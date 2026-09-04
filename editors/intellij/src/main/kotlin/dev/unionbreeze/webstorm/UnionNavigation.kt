package dev.unionbreeze.webstorm

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.psi.util.PsiTreeUtil
import org.eclipse.lsp4j.Position

class UnionBreezeGotoDeclarationHandler:GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(sourceElement:PsiElement?,offset:Int,editor:Editor?):Array<PsiElement>? {
        val element=sourceElement?:return null;val activeEditor=editor?:return null;val project=element.project
        val file=element.containingFile?.virtualFile?:return null;val document=activeEditor.document
        val resolved=project.getService(UnionCache::class.java).navigationAt(file,document,offset)?:return null
        val locations=if(resolved.kind=="usage"){
            listOfNotNull(resolved.declaredMembers.firstOrNull{it.value==resolved.currentValue}?.declaration)
        }else{
            val position=document.positionForNavigation(offset);val stamp=document.modificationStamp
            LspClientManager.getInstance(project).getClients(UnionBreezeLspProvider::class.java)
                .filter{it.descriptor.isSupportedFile(file)}
                .firstNotNullOfOrNull{client->runCatching{client.sendRequestSync(1_500){server->
                    (server as UnionBreezeLanguageServer).navigationTargets(ResolveLiteralParams(client.getDocumentIdentifier(file),position,document.text,stamp))
                }}.getOrNull()}.orEmpty()
        }
        val targets=locations.mapNotNull{location->
            val targetFile=VirtualFileManager.getInstance().findFileByUrl(location.uri)?:return@mapNotNull null
            val targetDocument=FileDocumentManager.getInstance().getDocument(targetFile)?:return@mapNotNull null
            val targetOffset=targetDocument.offsetForNavigation(location.range.start)?:return@mapNotNull null
            val psiFile=PsiManager.getInstance(project).findFile(targetFile)?:return@mapNotNull null
            val leaf=psiFile.findElementAt((targetOffset+1).coerceAtMost((psiFile.textLength-1).coerceAtLeast(0)))?:return@mapNotNull null
            PsiTreeUtil.getParentOfType(leaf,JSLiteralExpression::class.java,false)?:leaf
        }.distinctBy{Pair(it.containingFile?.virtualFile?.url,it.textRange.startOffset)}
        return targets.takeIf{it.isNotEmpty()}?.toTypedArray()
    }
}

private fun Document.positionForNavigation(offset:Int):Position {val line=getLineNumber(offset);return Position(line,offset-getLineStartOffset(line))}
private fun Document.offsetForNavigation(position:Position):Int? {if(position.line<0||position.line>=lineCount)return null;val start=getLineStartOffset(position.line);val end=getLineEndOffset(position.line);return (start+position.character).takeIf{it<=end}}
