package dev.unionbreeze.webstorm

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile

class ChangeUnionMemberIntention : IntentionAction {
    override fun getText(): String = "Change union member"

    override fun getFamilyName(): String = "UnionBreeze"

    override fun startInWriteAction(): Boolean = false

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        if (editor == null || file == null || file.virtualFile?.extension?.lowercase() !in setOf("ts", "tsx")) return false
        val literal = LiteralAtCaret.find(file, editor) ?: return false
        val resolved = project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE)
        return resolved?.confidence == ResolutionConfidence.HIGH && resolved.assignableMembers.size >= 2
    }

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        if (editor == null || file == null) return
        val literal = LiteralAtCaret.find(file, editor) ?: return
        val resolved = project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE) ?: return
        UnionMemberSwitcher.show(project, editor, literal, resolved)
    }
}
