package dev.unionbreeze.webstorm

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.highlighter.EditorHighlighterFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiElement
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListCellRenderer
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JSplitPane
import javax.swing.KeyStroke
import javax.swing.AbstractAction
import java.awt.event.ActionEvent

internal fun showUnionUsages(project: Project, editor: Editor, targets: List<PsiElement>, member: ResolvedLiteral) {
    val list = JBList(targets)
    list.cellRenderer = object : DefaultListCellRenderer() {
        override fun getListCellRendererComponent(list: JList<*>?, value: Any?, index: Int, selected: Boolean, focus: Boolean): java.awt.Component {
            val element = value as PsiElement
            val file = element.containingFile.virtualFile
            val document = FileDocumentManager.getInstance().getDocument(file)
            val line = document?.getLineNumber(element.textRange.startOffset) ?: 0
            val snippet = document?.let { it.charsSequence.subSequence(it.getLineStartOffset(line), it.getLineEndOffset(line)).toString().trim() }.orEmpty()
            return super.getListCellRendererComponent(list, "${file.name}:${line + 1}  $snippet", index, selected, focus)
        }
    }
    val preview = JPanel(BorderLayout())
    var viewer: Editor? = null
    fun updatePreview() {
        viewer?.let { EditorFactory.getInstance().releaseEditor(it) }; viewer = null
        preview.removeAll()
        val element = list.selectedValue?.takeIf { it.isValid } ?: return
        val file = element.containingFile.virtualFile
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val next = EditorFactory.getInstance().createViewer(document, project)
        (next as? EditorEx)?.highlighter = EditorHighlighterFactory.getInstance().createEditorHighlighter(project, file)
        next.caretModel.moveToOffset(element.textRange.startOffset)
        next.selectionModel.setSelection(element.textRange.startOffset, element.textRange.endOffset)
        next.scrollingModel.scrollToCaret(ScrollType.CENTER)
        viewer = next
        preview.add(next.component, BorderLayout.CENTER)
        preview.revalidate(); preview.repaint()
    }
    val panel = JSplitPane(JSplitPane.VERTICAL_SPLIT, JBScrollPane(list), preview)
    panel.preferredSize = Dimension(850, 480)
    panel.resizeWeight = 0.35
    val popup = JBPopupFactory.getInstance().createComponentPopupBuilder(panel, list)
        .setTitle("${member.contextualTypeName}: '${member.currentValue}' — ${targets.size} usages")
        .setResizable(true).setMovable(true).setRequestFocus(true).createPopup()
    Disposer.register(popup, com.intellij.openapi.Disposable { viewer?.let { EditorFactory.getInstance().releaseEditor(it) }; viewer = null })
    fun navigate() {
        val element = list.selectedValue?.takeIf { it.isValid } ?: return
        OpenFileDescriptor(project, element.containingFile.virtualFile, element.textRange.startOffset).navigate(true)
        popup.cancel()
    }
    list.addListSelectionListener { if(!it.valueIsAdjusting) updatePreview() }
    list.addMouseListener(object : MouseAdapter() { override fun mouseClicked(event: MouseEvent) { if(event.clickCount == 2) navigate() } })
    list.getInputMap().put(KeyStroke.getKeyStroke("ENTER"), "navigate")
    list.actionMap.put("navigate", object : AbstractAction() { override fun actionPerformed(event: ActionEvent) = navigate() })
    list.selectedIndex = 0
    popup.showInBestPositionFor(editor)
    viewer?.scrollingModel?.scrollToCaret(ScrollType.CENTER)
}
