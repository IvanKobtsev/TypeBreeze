package dev.unionbreeze.webstorm

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.psi.PsiFile
import com.intellij.util.IncorrectOperationException
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.TextRange
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import org.eclipse.lsp4j.Position

class ChangeUnionMemberAction:AnAction(){
    override fun getActionUpdateThread()=ActionUpdateThread.BGT
    override fun update(e:AnActionEvent){val project=e.project;val editor=e.getData(CommonDataKeys.EDITOR);val file=e.getData(CommonDataKeys.VIRTUAL_FILE);e.presentation.isEnabledAndVisible=project!=null&&editor!=null&&file!=null&&project.getService(UnionCache::class.java).at(file,editor.document,editor.caretModel.offset)!=null}
    override fun actionPerformed(e:AnActionEvent){requestAndShow(e.project?:return,e.getData(CommonDataKeys.EDITOR)?:return,e.getData(CommonDataKeys.VIRTUAL_FILE)?:return,true)}
}
class ChangeUnionMemberIntention:IntentionAction {
    override fun getText()="Change Union Member"
    override fun getFamilyName()="UnionBreeze"
    override fun startInWriteAction()=false
    override fun isAvailable(project:Project,editor:Editor?,file:PsiFile?):Boolean {val e=editor?:return false;val f=file?.virtualFile?:return false;return project.getService(UnionCache::class.java).at(f,e.document,e.caretModel.offset)!=null}
    @Throws(IncorrectOperationException::class) override fun invoke(project:Project,editor:Editor?,file:PsiFile?){requestAndShow(project,editor?:return,file?.virtualFile?:return,false)}
}
private fun requestAndShow(project:Project,editor:Editor,file:VirtualFile,notify:Boolean){
    val document=editor.document;val stamp=document.modificationStamp;val position=document.position(editor.caretModel.offset)
    AppExecutorUtil.getAppExecutorService().execute {
        val clients=LspClientManager.getInstance(project).getClients(UnionBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(file)}
        val resolved=clients.firstNotNullOfOrNull { client -> runCatching { client.sendRequestSync(1_500){server->(server as UnionBreezeLanguageServer).resolveLiteral(ResolveLiteralParams(client.getDocumentIdentifier(file),position,document.text,stamp))} }.getOrNull() }
        ApplicationManager.getApplication().invokeLater {
            if(document.modificationStamp!=stamp)return@invokeLater
            if(resolved==null||resolved.kind!="usage"||resolved.assignableMembers.size<2){if(notify)NotificationGroupManager.getInstance().getNotificationGroup("UnionBreeze").createNotification("No closed string union is available here.",NotificationType.INFORMATION).notify(project);return@invokeLater}
            project.getService(UnionCache::class.java).put(file,document,resolved);showPopup(project,editor,file,resolved,stamp)
        }
    }
}
private fun showPopup(project:Project,editor:Editor,file:VirtualFile,resolved:ResolvedLiteral,stamp:Long){
    val choices=resolved.assignableMembers.sortedBy{it.declarationOrder};val step=object:BaseListPopupStep<UnionMember>(resolved.contextualTypeName,choices){
        override fun getTextFor(value:UnionMember)=if(value.value==resolved.currentValue)"● ${value.value}" else "  ${value.value}"
        override fun onChosen(value:UnionMember,finalChoice:Boolean):PopupStep<*>?{if(editor.document.modificationStamp==stamp)replace(project,editor,file,resolved,value.value);return FINAL_CHOICE}
    };JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(editor)
}
private fun replace(project:Project,editor:Editor,file:VirtualFile,resolved:ResolvedLiteral,value:String){
    val document=editor.document;val start=document.offset(resolved.range.start)?:return;val end=document.offset(resolved.range.end)?:return
    if(start !in 0 until document.textLength||end>document.textLength||end-start<2)return
    val quote=document.charsSequence[start];if(quote!='\''&&quote!='"')return
    val escaped=buildString { value.forEach{append(when(it){'\\'->"\\\\";quote->"\\$quote";'\n'->"\\n";'\r'->"\\r";'\t'->"\\t";else->it})} }
    WriteCommandAction.runWriteCommandAction(project,Runnable{document.replaceString(start+1,end-1,escaped)})
}
private fun Document.position(offset:Int):Position { val line=getLineNumber(offset);return Position(line,offset-getLineStartOffset(line)) }
private fun Document.offset(position:Position):Int? { if(position.line<0||position.line>=lineCount)return null;val start=getLineStartOffset(position.line);val end=getLineEndOffset(position.line);var units=0;var i=start;while(i<end&&units<position.character){val pair=Character.isHighSurrogate(charsSequence[i])&&i+1<end&&Character.isLowSurrogate(charsSequence[i+1]);units+=if(pair)2 else 1;i+=if(pair)2 else 1};return if(units==position.character)i else null }

@Service(Service.Level.PROJECT)
class UnionCache(private val project:Project){
    private data class Entry(val stamp:Long,val literals:List<ResolvedLiteral>);private val entries=ConcurrentHashMap<String,Entry>()
    private val refreshing=ConcurrentHashMap.newKeySet<String>()
    init { EditorFactory.getInstance().eventMulticaster.addDocumentListener(object:DocumentListener{override fun documentChanged(event:DocumentEvent){FileDocumentManager.getInstance().getFile(event.document)?.takeIf(UnionBreezeLspProvider::supports)?.let{entries.remove(it.url);refresh(it)}}},project) }
    fun put(file:VirtualFile,document:Document,literal:ResolvedLiteral){
        entries.compute(file.url){_,old->
            val retained=old?.takeIf{it.stamp==document.modificationStamp}?.literals.orEmpty().filterNot{it.kind==literal.kind&&it.range==literal.range}
            Entry(document.modificationStamp,retained+literal)
        }
    }
    fun at(file:VirtualFile,document:Document,offset:Int):ResolvedLiteral? {
        val entry=entries[file.url]?.takeIf{it.stamp==document.modificationStamp}?:run{refresh(file);return null}
        return entry.literals.firstOrNull{val start=document.offset(it.range.start)?:-2;val end=document.offset(it.range.end)?:-1;it.kind=="usage"&&it.assignableMembers.size>1&&offset in (start+1)..(end-1)}
    }
    fun matching(file:VirtualFile,document:Document,range:TextRange)=entries[file.url]?.takeIf{it.stamp==document.modificationStamp}?.literals?.firstOrNull{document.offset(it.range.start)==range.startOffset&&document.offset(it.range.end)==range.endOffset}
    fun refresh(file:VirtualFile){if(refreshing.add(file.url))scheduleRefresh(file,0)}
    private fun scheduleRefresh(file:VirtualFile,attempt:Int){AppExecutorUtil.getAppScheduledExecutorService().schedule({val document=ReadAction.compute<Document?,RuntimeException>{FileDocumentManager.getInstance().getDocument(file)};if(document==null){refreshing.remove(file.url);return@schedule};val stamp=document.modificationStamp;val text=document.text;val clients=LspClientManager.getInstance(project).getClients(UnionBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(file)};if(clients.isEmpty()){if(attempt<5)scheduleRefresh(file,attempt+1)else refreshing.remove(file.url);return@schedule};val response=clients.firstNotNullOfOrNull{client->runCatching{client.sendRequestSync(15_000){server->(server as UnionBreezeLanguageServer).documentUnions(DocumentUnionsParams(client.getDocumentIdentifier(file),text,stamp))}}.onFailure{LOG.warn("documentUnions failed for ${file.path}",it)}.getOrNull()};if(response!=null&&response.clientVersion==stamp&&document.modificationStamp==stamp){entries[file.url]=Entry(stamp,response.literals);refreshing.remove(file.url);ApplicationManager.getApplication().invokeLater{DaemonCodeAnalyzer.getInstance(project).restart()}}else if(attempt<5)scheduleRefresh(file,attempt+1)else refreshing.remove(file.url)},if(attempt==0)300 else 500,TimeUnit.MILLISECONDS)}
    companion object { private val LOG=Logger.getInstance(UnionCache::class.java) }
}
