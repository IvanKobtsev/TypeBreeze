package dev.typebreeze.webstorm

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.codeInsight.FileModificationService
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.refactoring.rename.RenameHandler
import com.intellij.util.concurrency.AppExecutorUtil
import org.eclipse.lsp4j.Position

class TypeBreezeRenameHandler:RenameHandler {
    override fun isAvailableOnDataContext(dataContext:DataContext):Boolean {
        val project=CommonDataKeys.PROJECT.getData(dataContext)?:return false;val editor=CommonDataKeys.EDITOR.getData(dataContext)?:return false;val file=CommonDataKeys.VIRTUAL_FILE.getData(dataContext)?:return false
        return project.getService(UnionCache::class.java).navigationAt(file,editor.document,editor.caretModel.offset)!=null
    }
    override fun invoke(project:Project,editor:Editor,file:PsiFile,dataContext:DataContext){
        val virtualFile=file.virtualFile?:return;val cached=project.getService(UnionCache::class.java).navigationAt(virtualFile,editor.document,editor.caretModel.offset)?:return
        val newValue=Messages.showInputDialog(project,"New value for '${cached.currentValue}':","Rename ${cached.contextualTypeName} Union Member",Messages.getQuestionIcon(),cached.currentValue,null)?.takeIf{it.isNotEmpty()&&it!=cached.currentValue}?:return
        val document=editor.document;val stamp=document.modificationStamp;val position=document.positionForRename(editor.caretModel.offset)
        AppExecutorUtil.getAppExecutorService().execute{
            val plan=LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(virtualFile)}.firstNotNullOfOrNull{client->runCatching{client.sendRequestSync(5_000){server->(server as TypeBreezeLanguageServer).renamePlan(RenamePlanParams(client.getDocumentIdentifier(virtualFile),position,document.text,stamp,newValue))}}.getOrNull()}
            ApplicationManager.getApplication().invokeLater{if(plan==null||document.modificationStamp!=stamp)notifyFailure(project)else applyPlan(project,plan)}
        }
    }
    override fun invoke(project:Project,elements:Array<out PsiElement>,dataContext:DataContext){}
}

private data class PendingEdit(val file:com.intellij.openapi.vfs.VirtualFile,val document:Document,val start:Int,val end:Int,val replacement:String)
private fun applyPlan(project:Project,plan:RenamePlan){
    val edits=plan.targets.mapNotNull{target->val file=VirtualFileManager.getInstance().findFileByUrl(target.uri)?:return@mapNotNull null;val document=FileDocumentManager.getInstance().getDocument(file)?:return@mapNotNull null;val start=document.offsetForRename(target.range.start)?:return@mapNotNull null;val end=document.offsetForRename(target.range.end)?:return@mapNotNull null;if(start<0||end>document.textLength||start>=end||document.getText(com.intellij.openapi.util.TextRange(start,end))!=target.expectedText)return@mapNotNull null;PendingEdit(file,document,start,end,target.newText)}
    if(edits.size!=plan.targets.size||edits.isEmpty()){notifyFailure(project);return}
    if(!FileModificationService.getInstance().prepareVirtualFilesForWrite(project,edits.map{it.file}.distinct()))return
    WriteCommandAction.runWriteCommandAction(project,Runnable{edits.groupBy{it.document}.forEach{(_,items)->items.sortedByDescending{it.start}.forEach{it.document.replaceString(it.start,it.end,it.replacement)}}})
}
private fun notifyFailure(project:Project)=NotificationGroupManager.getInstance().getNotificationGroup("TypeBreeze").createNotification("Union member rename was cancelled because its usages could not be resolved safely.",NotificationType.WARNING).notify(project)
private fun Document.positionForRename(offset:Int):Position{val line=getLineNumber(offset);return Position(line,offset-getLineStartOffset(line))}
private fun Document.offsetForRename(position:Position):Int?{if(position.line<0||position.line>=lineCount)return null;return(getLineStartOffset(position.line)+position.character).takeIf{it<=getLineEndOffset(position.line)}}
