package dev.unionbreeze.webstorm

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.Logger
import com.intellij.psi.PsiFile

class ChangeUnionMemberIntention : IntentionAction {
    private val log = Logger.getInstance(ChangeUnionMemberIntention::class.java)

    override fun getText(): String = "Change union member"

    override fun getFamilyName(): String = "UnionBreeze"

    override fun startInWriteAction(): Boolean = false

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        if (editor == null || file == null || file.virtualFile?.extension?.lowercase() !in setOf("ts", "tsx")) {
            return false
        }
        val literal = LiteralAtCaret.find(file, editor) ?: return false
        val resolved = project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE)
        val available = resolved?.confidence == ResolutionConfidence.HIGH && resolved.assignableMembers.size >= 2
        log.debug(
            "Intention availability: file=${file.virtualFile?.path}, offset=${editor.caretModel.offset}, " +
                "literal=${literal.text}, available=$available",
        )
        return available
    }

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        if (editor == null || file == null) return
        val literal = LiteralAtCaret.find(file, editor) ?: return
        val resolved = project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE) ?: return
        UnionMemberSwitcher.show(project, editor, literal, resolved)
    }
}
