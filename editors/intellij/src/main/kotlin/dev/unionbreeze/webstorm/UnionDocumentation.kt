package dev.unionbreeze.webstorm

import com.intellij.lang.documentation.AbstractDocumentationProvider
import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.text.StringUtil
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil

/** Keep documentation attached to the literal, before JavaScript resolves its property. */
class UnionDocumentationProvider : AbstractDocumentationProvider() {
    override fun getCustomDocumentationElement(editor: Editor, file: PsiFile, contextElement: PsiElement?, targetOffset: Int): PsiElement? {
        val leaf = file.findElementAt(targetOffset) ?: return null
        val literal = PsiTreeUtil.getParentOfType(leaf, JSLiteralExpression::class.java, false) ?: return null
        return literal.takeIf { resolved(it) != null }
    }

    override fun generateDoc(element: PsiElement, originalElement: PsiElement?): String? = render(originalElement) ?: render(element)
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
        fun escape(value: String) = StringUtil.escapeXmlEntities(value)
        val values = member.declaredMembers.joinToString(" | ") { "&quot;${escape(it.value)}&quot;" }
        return "<div class='definition'><pre>Union member &quot;${escape(member.currentValue)}&quot;</pre></div>" +
            "<div class='content'>Defined by <b>${escape(member.contextualTypeName)}</b><pre>$values</pre></div>"
    }
}
