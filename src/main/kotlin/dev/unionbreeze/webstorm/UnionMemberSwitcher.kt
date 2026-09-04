package dev.unionbreeze.webstorm

import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.SmartPointerManager

internal object UnionMemberSwitcher {
    fun show(
        project: Project,
        editor: Editor,
        literal: JSLiteralExpression,
        resolved: ResolvedLiteralUnion,
    ) {
        val pointer = SmartPointerManager.getInstance(project).createSmartPsiElementPointer(literal)
        val document = editor.document
        val initialStamp = document.modificationStamp
        val choices = resolved.assignableMembers
        if (choices.size < 2) return

        val step = object : BaseListPopupStep<UnionMember>(
            resolved.contextualTypeName ?: "Change Union Member",
            choices,
        ) {
            override fun getTextFor(value: UnionMember): String =
                if (value.value == resolved.currentMember.value) "● ${value.value}" else "  ${value.value}"

            override fun onChosen(selectedValue: UnionMember, finalChoice: Boolean): PopupStep<*>? {
                replaceIfStillValid(project, pointer.element, editor, initialStamp, selectedValue.value)
                return FINAL_CHOICE
            }
        }
        JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(editor)
    }

    private fun replaceIfStillValid(
        project: Project,
        literal: JSLiteralExpression?,
        editor: Editor,
        initialStamp: Long,
        value: String,
    ) {
        if (literal == null || !literal.isValid || !literal.isStringLiteral) return
        if (editor.document.modificationStamp != initialStamp) return
        replaceLiteral(project, editor, literal, value)
    }

    internal fun replaceLiteral(
        project: Project,
        editor: Editor,
        literal: JSLiteralExpression,
        value: String,
    ): Boolean {
        val resolver = project.getService(PublicApiUnionResolver::class.java)
        val resolved = resolver.resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE) ?: return false
        if (resolved.confidence != ResolutionConfidence.HIGH || resolved.assignableMembers.none { it.value == value }) {
            return false
        }

        val text = literal.text
        val quote = text.firstOrNull().takeIf { it == '\'' || it == '"' } ?: return false
        val replacement = quote + escape(value, quote) + quote
        WriteCommandAction.runWriteCommandAction(project, "Change Union Member", null, Runnable {
            val range = literal.textRange
            editor.document.replaceString(range.startOffset, range.endOffset, replacement)
            PsiDocumentManager.getInstance(project).commitDocument(editor.document)
        }, literal.containingFile)
        return true
    }

    internal fun escape(value: String, quote: Char): String = buildString(value.length) {
        value.forEach { character ->
            append(
                when (character) {
                    '\\' -> "\\\\"
                    quote -> "\\$quote"
                    '\n' -> "\\n"
                    '\r' -> "\\r"
                    '\t' -> "\\t"
                    '\b' -> "\\b"
                    '\u000C' -> "\\f"
                    else -> character
                },
            )
        }
    }
}
