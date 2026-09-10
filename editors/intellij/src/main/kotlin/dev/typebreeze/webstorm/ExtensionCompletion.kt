package dev.typebreeze.webstorm

import com.intellij.codeInsight.AutoPopupController
import com.intellij.codeInsight.completion.CompletionContributor
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.completion.CompletionResultSet
import com.intellij.codeInsight.completion.CompletionType
import com.intellij.codeInsight.completion.InsertionContext
import com.intellij.codeInsight.editorActions.TypedHandlerDelegate
import com.intellij.codeInsight.lookup.AutoCompletionPolicy
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.codeInsight.lookup.LookupElement
import com.intellij.codeInsight.lookup.LookupEvent
import com.intellij.codeInsight.lookup.LookupListener
import com.intellij.codeInsight.lookup.LookupManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import org.eclipse.lsp4j.Position

class ExtensionCompletionContributor : CompletionContributor() {
    override fun fillCompletionVariants(parameters: CompletionParameters, result: CompletionResultSet) {
        if (parameters.completionType != CompletionType.BASIC) return
        val file = parameters.originalFile.virtualFile ?: return
        if (!TypeBreezeLspProvider.supports(file)) return
        val editor = parameters.editor
        val document = editor.document
        val text = document.text
        val offset = parameters.offset.coerceAtMost(text.length)
        if (!extensionDotContext(text, offset)) return
        result.restartCompletionOnAnyPrefixChange()
        val project = parameters.originalFile.project
        val manager = FileDocumentManager.getInstance()
        val overlays = manager.unsavedDocuments.mapNotNull { unsaved ->
            manager.getFile(unsaved)?.takeIf { TypeBreezeLspProvider.supports(it) }?.let {
                DocumentUnionsParams(org.eclipse.lsp4j.TextDocumentIdentifier(it.url), unsaved.text, unsaved.modificationStamp, false)
            }
        }
        val line = document.getLineNumber(offset)
        val clients = LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java)
            .filter { it.descriptor.isSupportedFile(file) }
        for (client in clients) {
            ProgressManager.checkCanceled()
            val response = try {
                client.sendRequestSync(10_000) { server ->
                    (server as TypeBreezeLanguageServer).extensionCompletions(ExtensionCompletionParams(
                        client.getDocumentIdentifier(file), Position(line, offset - document.getLineStartOffset(line)),
                        text, document.modificationStamp, overlays))
                }
            } catch (cancelled: ProcessCanceledException) {
                throw cancelled
            } catch (_: Exception) { null } ?: continue
            ProgressManager.checkCanceled()
            if (document.text != text) return
            addExtensionCompletions(parameters, result, response, offset)
        }
    }
}

internal fun addExtensionCompletions(parameters: CompletionParameters, result: CompletionResultSet,
    response: ExtensionCompletions, offset: Int) {
    val guard = captureExtensionDependencies(response, parameters.editor)
    val items = response.candidates.map { extensionLookupElement(it, response, offset, guard) }
    // Reject an outdated selection before IntelliJ inserts the lookup string.
    LookupManager.getActiveLookup(parameters.editor)?.addLookupListener(object : LookupListener {
        override fun beforeItemSelected(event: LookupEvent): Boolean {
            if (event.item !in items) return true
            return parameters.editor.document.text == response.expectedText &&
                guard.current()
        }
    })
    result.addAllElements(items)
}

private fun extensionLookupElement(candidate: ExtensionCandidate, response: ExtensionCompletions, offset: Int,
    guard: ExtensionDependencyGuard): LookupElement =
    LookupElementBuilder.create(candidate.id, candidate.name)
        .withPresentableText(candidate.name)
        .withTailText(" (${candidate.remainingParameters}) [extension · ${candidate.sourceModule}]", true)
        .withTypeText(candidate.returnType)
        .withInsertHandler { context, _ -> insertExtension(context, candidate, response, offset, guard) }
        .withAutoCompletionPolicy(AutoCompletionPolicy.NEVER_AUTOCOMPLETE)

private data class ExtensionDependency(val file: VirtualFile, val document: Document, val stamp: Long, val fileStamp: Long) {
    fun current() = file.isValid && file.modificationStamp == fileStamp && document.modificationStamp == stamp
}

private data class ExtensionDependencyGuard(val dependencies: List<ExtensionDependency>, val valid: Boolean) {
    fun current() = valid && dependencies.all { it.current() }
    // The lookup's own insertion changes PSI; only dependency stamps apply here.
    fun dependenciesCurrent() = valid && dependencies.all { it.current() }
}

private fun captureExtensionDependencies(response: ExtensionCompletions, editor: Editor): ExtensionDependencyGuard {
    val manager = FileDocumentManager.getInstance()
    val dependencies = mutableListOf<ExtensionDependency>()
    var valid = true
    for (snapshot in response.documents) {
        ProgressManager.checkCanceled()
        val file = VirtualFileManager.getInstance().findFileByUrl(snapshot.uri)
        val document = file?.let(manager::getDocument)
        if (file == null || document == null || document.text != snapshot.expectedText) valid = false
        else if (document !== editor.document) dependencies.add(ExtensionDependency(file, document, document.modificationStamp, file.modificationStamp))
    }
    return ExtensionDependencyGuard(dependencies, valid)
}

internal fun extensionDotContext(text: String, offset: Int): Boolean {
    if (offset !in 0..text.length) return false
    var start = offset
    while (start > 0 && (text[start - 1].isLetterOrDigit() || text[start - 1] in "_$")) start--
    while (start > 0 && text[start - 1].isWhitespace()) start--
    return start > 0 && text[start - 1] == '.'
}

class ExtensionAutoPopup : TypedHandlerDelegate() {
    override fun checkAutoPopup(charTyped: Char, project: Project, editor: Editor, file: PsiFile): Result {
        if (charTyped == '.' && file.virtualFile?.let(TypeBreezeLspProvider::supports) == true) {
            AutoPopupController.getInstance(project).scheduleAutoPopup(editor)
        }
        return Result.CONTINUE
    }
}

private fun insertExtension(context: InsertionContext, candidate: ExtensionCandidate, response: ExtensionCompletions, offset: Int,
    guard: ExtensionDependencyGuard) {
    context.setAddCompletionChar(false)
    val document = context.document
    val before = response.expectedText
    val start = context.startOffset
    if (start !in 0..offset || offset > before.length || context.tailOffset > document.textLength) return
    // Completion inserts its lookup text before invoking the handler. Restore that
    // prefix within the same command, then validate and apply the compiler's plan.
    val originalEnd = if (context.completionChar == '\t') {
        var end = offset
        while (end < before.length && (before[end].isLetterOrDigit() || before[end] in "_$")) end++
        end
    } else offset
    document.replaceString(start, context.tailOffset, before.substring(start, originalEnd))
    if (document.text != before) return
    if (!guard.dependenciesCurrent()) return
    val plan = candidate.plan ?: return
    if (before != plan.expectedText || response.snapshot != plan.snapshot) return
    if (applyExtensionPlan(context.project, context.editor, plan)) {
        context.tailOffset = plan.caretOffset
        PsiDocumentManager.getInstance(context.project).commitDocument(document)
        if (plan.parameterInfo) AutoPopupController.getInstance(context.project).autoPopupParameterInfo(context.editor, null)
    }
}

internal fun applyExtensionPlan(project: Project, editor: Editor, plan: ExtensionCallPlan): Boolean {
    val document = editor.document
    val ordered = plan.edits.sortedBy { it.start }
    if (ordered.isEmpty() || ordered.any { it.start < 0 || it.end < it.start || it.end > plan.expectedText.length ||
            plan.expectedText.substring(it.start, it.end) != it.expectedText } ||
        ordered.zipWithNext().any { (left, right) -> left.end > right.start }) return false
    val finalLength = plan.expectedText.length + ordered.sumOf { it.newText.length - (it.end - it.start) }
    if (plan.caretOffset !in 0..finalLength) return false
    var applied = false
    WriteCommandAction.runWriteCommandAction(project, "Insert Extension Method", null, Runnable {
        if (document.isWritable && document.text == plan.expectedText) {
            ordered.asReversed().forEach { document.replaceString(it.start, it.end, it.newText) }
            editor.caretModel.moveToOffset(plan.caretOffset)
            applied = true
        }
    })
    return applied
}
