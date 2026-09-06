package dev.typebreeze.webstorm

import com.intellij.lang.documentation.AbstractDocumentationProvider
import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.text.StringUtil
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.model.Pointer
import com.intellij.platform.backend.documentation.DocumentationTarget
import com.intellij.platform.backend.documentation.DocumentationTargetProvider
import com.intellij.platform.backend.documentation.DocumentationResult
import com.intellij.platform.backend.presentation.TargetPresentation
import com.intellij.psi.SmartPointerManager

/** Choose the hover target by source offset, before JavaScript maps a value to its property. */
class UnionDocumentationTargetProvider : DocumentationTargetProvider {
    override fun documentationTargets(file: PsiFile, offset: Int): List<DocumentationTarget> {
        val leaf = file.findElementAt(offset) ?: return emptyList()
        val literal = PsiTreeUtil.getParentOfType(leaf, JSLiteralExpression::class.java, false) ?: return emptyList()
        if (!literal.isStringLiteral) return emptyList()
        val virtualFile = file.virtualFile ?: return emptyList()
        if (!TypeBreezeLspProvider.supports(virtualFile)) return emptyList()
        val document = file.viewProvider.document ?: return emptyList()
        val member = file.project.getService(UnionCache::class.java).matching(virtualFile, document, literal.textRange)
            ?: return emptyList()
        return listOf(UnionDocumentationTarget(literal, member, document.modificationStamp))
    }
}

private class UnionDocumentationTarget(
    private val literal: JSLiteralExpression,
    private val member: ResolvedLiteral,
    private val stamp: Long,
) : DocumentationTarget {
    override fun createPointer(): Pointer<out DocumentationTarget> {
        val pointer = SmartPointerManager.createPointer(literal)
        val snapshot = member
        val version = stamp
        return Pointer {
            val restored = pointer.element
            if (restored == null || restored.containingFile.viewProvider.document?.modificationStamp != version) null
            else UnionDocumentationTarget(restored, snapshot, version)
        }
    }

    override fun computePresentation(): TargetPresentation =
        TargetPresentation.builder("${member.contextualTypeName}: '${member.currentValue}'").presentation()

    override fun computeDocumentationHint(): String = renderUnionDocumentation(member)
    override fun computeDocumentation(): DocumentationResult = DocumentationResult.documentation(renderUnionDocumentation(member))
}

internal fun renderUnionDocumentation(member: ResolvedLiteral): String {
    fun escape(value: String) = StringUtil.escapeXmlEntities(value)
    val values = member.declaredMembers.joinToString(" | ") { "&quot;${escape(it.value)}&quot;" }
    return "<div class='definition'><pre>Union member &quot;${escape(member.currentValue)}&quot;</pre></div>" +
        "<div class='content'>Defined by <b>${escape(member.contextualTypeName)}</b><pre>$values</pre></div>"
}

/** Keep documentation attached to the literal, before JavaScript resolves its property. */
class UnionDocumentationProvider : AbstractDocumentationProvider() {
    override fun getCustomDocumentationElement(editor: Editor, file: PsiFile, contextElement: PsiElement?, targetOffset: Int): PsiElement? {
        val leaf = file.findElementAt(targetOffset) ?: return null
        val literal = PsiTreeUtil.getParentOfType(leaf, JSLiteralExpression::class.java, false) ?: return null
        return literal.takeIf { resolved(it) != null }
    }

    override fun generateDoc(element: PsiElement, originalElement: PsiElement?): String? = render(originalElement) ?: render(element)
    override fun generateHoverDoc(element: PsiElement, originalElement: PsiElement?): String? = generateDoc(element, originalElement)
    override fun getQuickNavigateInfo(element: PsiElement, originalElement: PsiElement?): String? = generateDoc(element, originalElement)

    private fun resolved(element: PsiElement): ResolvedLiteral? {
        val literal = PsiTreeUtil.getParentOfType(element, JSLiteralExpression::class.java, false) ?: return null
        if (!literal.isStringLiteral) return null
        val file = literal.containingFile
        val virtualFile = file.virtualFile ?: return null
        val document = file.viewProvider.document ?: return null
        val cache = literal.project.getService(UnionCache::class.java)
        return cache.matching(virtualFile, document, literal.textRange)
    }

    private fun render(element: PsiElement?): String? {
        val member = element?.let(::resolved) ?: return null
        return renderUnionDocumentation(member)
    }
}
