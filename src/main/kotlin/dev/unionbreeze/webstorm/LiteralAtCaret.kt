package dev.unionbreeze.webstorm

import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil

internal object LiteralAtCaret {
    fun find(file: PsiFile, editor: Editor): JSLiteralExpression? {
        val documentLength = editor.document.textLength
        if (documentLength == 0) return null
        val caret = editor.caretModel.offset.coerceIn(0, documentLength)
        val offsets = if (caret == documentLength) intArrayOf(caret - 1) else intArrayOf(caret, caret - 1)
        return offsets.asSequence()
            .filter { it >= 0 }
            .mapNotNull(file::findElementAt)
            .mapNotNull { PsiTreeUtil.getParentOfType(it, JSLiteralExpression::class.java, false) }
            .firstOrNull { literal ->
                literal.isStringLiteral && caret in literal.textRange.startOffset..literal.textRange.endOffset
            }
    }
}
