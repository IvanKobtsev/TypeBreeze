package dev.typebreeze.webstorm

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.lang.annotation.Annotator
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class ExtensionMethodAnnotator : Annotator {
    override fun annotate(element: PsiElement, holder: AnnotationHolder) {
        val file = element.containingFile?.virtualFile ?: return
        val document = element.containingFile?.viewProvider?.document ?: return
        if (element.project.getService(ExtensionStyleCache::class.java).matching(file, document, element.textRange) == null) return
        holder.newSilentAnnotation(HighlightSeverity.INFORMATION)
            .range(element.textRange)
            .textAttributes(TypeBreezeColors.EXTENSION_METHOD)
            .create()
    }
}

@Service(Service.Level.PROJECT)
class ExtensionStyleCache(private val project: Project) {
    private data class Entry(val stamp: Long, val occurrences: List<ExtensionOccurrence>)
    private val entries = ConcurrentHashMap<String, Entry>()
    private val refreshing = ConcurrentHashMap.newKeySet<String>()

    init {
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                FileDocumentManager.getInstance().getFile(event.document)
                    ?.takeIf(TypeBreezeLspProvider::supports)
                    ?.let { entries.remove(it.url); refresh(it) }
            }
        }, project)
    }

    fun matching(file: VirtualFile, document: Document, range: TextRange): ExtensionOccurrence? {
        val entry = entries[file.url]?.takeIf { it.stamp == document.modificationStamp }
            ?: run { refresh(file); return null }
        return entry.occurrences.firstOrNull {
            document.offset(it.range.start) == range.startOffset && document.offset(it.range.end) == range.endOffset
        }
    }

    fun refresh(file: VirtualFile) {
        if (!refreshing.add(file.url)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule({ request(file) }, 75, TimeUnit.MILLISECONDS)
    }

    private fun request(file: VirtualFile) {
        if (project.isDisposed || !file.isValid) { refreshing.remove(file.url); return }
        val snapshot = ReadAction.compute<Triple<Document, Long, String>?, RuntimeException> {
            FileDocumentManager.getInstance().getDocument(file)?.let { Triple(it, it.modificationStamp, it.text) }
        } ?: run { refreshing.remove(file.url); return }
        val (document, stamp, text) = snapshot
        val response = LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java)
            .asSequence().filter { it.descriptor.isSupportedFile(file) }
            .mapNotNull { client -> runCatching {
                client.sendRequestSync(10_000) { server ->
                    (server as TypeBreezeLanguageServer).documentExtensions(
                        DocumentUnionsParams(client.getDocumentIdentifier(file), text, stamp, false))
                }
            }.getOrNull() }.firstOrNull()
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (document.modificationStamp != stamp) {
                refreshing.remove(file.url); refresh(file)
            } else {
                if (response?.clientVersion == stamp) entries[file.url] = Entry(stamp, response.occurrences)
                refreshing.remove(file.url)
                PsiManager.getInstance(project).findFile(file)?.let { DaemonCodeAnalyzer.getInstance(project).restart(it) }
            }
        }
    }

    private fun Document.offset(position: org.eclipse.lsp4j.Position): Int? {
        if (position.line !in 0 until lineCount) return null
        return (getLineStartOffset(position.line) + position.character).takeIf { it <= getLineEndOffset(position.line) }
    }
}
