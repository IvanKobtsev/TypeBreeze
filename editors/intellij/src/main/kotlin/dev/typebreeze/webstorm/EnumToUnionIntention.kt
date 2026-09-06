package dev.typebreeze.webstorm

import com.intellij.codeInsight.FileModificationService
import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.lang.javascript.psi.ecma6.TypeScriptEnum
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import org.eclipse.lsp4j.Position

class EnumToUnionIntention : IntentionAction {
    override fun getText() = "Enum to Union"
    override fun getFamilyName() = "TypeBreeze"
    override fun startInWriteAction() = false
    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        if (editor == null || file == null || file.virtualFile?.let(TypeBreezeLspProvider::supports) != true) return false
        val leaf = file.findElementAt(editor.caretModel.offset) ?: return false
        return PsiTreeUtil.getParentOfType(leaf, TypeScriptEnum::class.java, false) != null
    }

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val activeEditor = editor ?: return
        val virtualFile = file?.virtualFile ?: return
        val snapshots = captureEnumDocuments(project, virtualFile)
        val selected = snapshots.firstOrNull { it.file == virtualFile } ?: return
        val offset = activeEditor.caretModel.offset
        val line = selected.document.getLineNumber(offset)
        val position = Position(line, offset - selected.document.getLineStartOffset(line))
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Enum to Union", true) {
            override fun run(indicator: ProgressIndicator) {
                indicator.text = "Resolving enum references and checking the converted project"
                val clients = LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java)
                    .filter { it.descriptor.isSupportedFile(virtualFile) }
                val plan = clients.firstNotNullOfOrNull { client ->
                    runCatching {
                        client.sendRequestSync(60_000) { server ->
                            (server as TypeBreezeLanguageServer).enumToUnionPlan(EnumToUnionParams(
                                client.getDocumentIdentifier(virtualFile), position, selected.text, selected.stamp,
                                snapshots.map { DocumentUnionsParams(client.getDocumentIdentifier(it.file), it.text, it.stamp, false) },
                            ))
                        }
                    }.getOrNull()
                }
                indicator.checkCanceled()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed || indicator.isCanceled) return@invokeLater
                    if (plan == null) enumConversionFailure(project, "The TypeScript conversion plan could not be completed. Try again once the language server is ready.")
                    else if (plan.reason != null) {
                        val location = plan.location?.let { " (${it.uri.substringAfterLast('/')}:${it.range.start.line + 1})" }.orEmpty()
                        enumConversionFailure(project, plan.reason + location)
                    } else if (!applyEnumConversionPlan(project, plan, snapshots)) {
                        enumConversionFailure(project, "Files changed or could not be edited. No conversion was applied; invoke Enum to Union again.")
                    }
                }
            }
        })
    }
}

internal data class EnumEditorSnapshot(val file: VirtualFile, val document: Document, val stamp: Long, val text: String)

private fun captureEnumDocuments(project: Project, selected: VirtualFile): List<EnumEditorSnapshot> =
    ReadAction.compute<List<EnumEditorSnapshot>, RuntimeException> {
        val manager = FileDocumentManager.getInstance()
        val files = FileEditorManager.getInstance(project).openFiles.toList() +
            manager.unsavedDocuments.mapNotNull(manager::getFile) + selected
        files.distinct().filter { TypeBreezeLspProvider.supports(it) &&
            (it == selected || project.basePath?.let { base -> it.path.startsWith("$base/") } == true)
        }.mapNotNull { virtualFile -> manager.getDocument(virtualFile)?.let { EnumEditorSnapshot(virtualFile, it, it.modificationStamp, it.text) } }
    }

/** Validate the complete transaction again inside the write command, before its first edit. */
internal fun applyEnumConversionPlan(project: Project, plan: EnumToUnionPlan, originals: List<EnumEditorSnapshot>): Boolean {
    if (plan.reason != null || plan.edits.isEmpty() || plan.documents.isEmpty()) return false
    val manager = FileDocumentManager.getInstance()
    val documents = plan.documents.map { snapshot ->
        val file = VirtualFileManager.getInstance().findFileByUrl(snapshot.uri) ?: return false
        val document = manager.getDocument(file) ?: return false
        Triple(snapshot, file, document)
    }
    if (documents.map { it.first.uri }.distinct().size != documents.size) return false
    val prepared = plan.edits.map { edit ->
        val document = documents.firstOrNull { it.first.uri == edit.uri }?.third ?: return false
        val start = document.enumOffset(edit.range.start) ?: return false
        val end = document.enumOffset(edit.range.end) ?: return false
        if (end < start) return false
        EnumPendingEdit(document, start, end, edit.expectedText, edit.newText)
    }
    if (prepared.groupBy { it.document }.values.any { group ->
        group.sortedBy { it.start }.zipWithNext().any { (left, right) -> left.end > right.start }
    }) return false
    fun valid() = originals.all { it.file.isValid && it.document.modificationStamp == it.stamp && it.document.text == it.text } &&
        documents.all { (snapshot, file, document) -> file.isValid && document.text == snapshot.expectedText } &&
        prepared.all { it.end <= it.document.textLength && it.document.getText(TextRange(it.start, it.end)) == it.expectedText }
    if (!valid()) return false
    if (!FileModificationService.getInstance().prepareVirtualFilesForWrite(project, documents.map { it.second })) return false
    var applied = false
    WriteCommandAction.runWriteCommandAction(project, "Enum to Union", null, Runnable {
        if (valid() && documents.all { it.second.isWritable && it.third.isWritable }) {
            prepared.groupBy { it.document }.forEach { (_, edits) ->
                edits.sortedByDescending { it.start }.forEach { it.document.replaceString(it.start, it.end, it.newText) }
            }
            applied = true
        }
    })
    return applied
}

private data class EnumPendingEdit(val document: Document, val start: Int, val end: Int, val expectedText: String, val newText: String)
private fun Document.enumOffset(position: Position): Int? {
    if (position.line !in 0 until lineCount || position.character < 0) return null
    return (getLineStartOffset(position.line) + position.character).takeIf { it <= getLineEndOffset(position.line) }
}
private fun enumConversionFailure(project: Project, message: String) {
    NotificationGroupManager.getInstance().getNotificationGroup("TypeBreeze")
        .createNotification("Enum to Union", message, NotificationType.WARNING).notify(project)
}
