package dev.unionbreeze.webstorm

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger

class ChangeUnionMemberAction : AnAction() {
    private val log = Logger.getInstance(ChangeUnionMemberAction::class.java)

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val editor = event.getData(CommonDataKeys.EDITOR)
        val file = event.getData(CommonDataKeys.PSI_FILE)
        event.presentation.isEnabledAndVisible = project != null && editor != null && file != null &&
            file.virtualFile?.extension?.lowercase() in setOf("ts", "tsx")
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val file = event.getData(CommonDataKeys.PSI_FILE) ?: return
        val literal = LiteralAtCaret.find(file, editor)
        log.info(
            "Change Union Member invoked: file=${file.virtualFile?.path}, " +
                "offset=${editor.caretModel.offset}, literal=${literal?.text}",
        )
        if (literal == null) {
            notifyUnavailable(project, "The caret is not inside a TypeScript string literal.")
            return
        }
        val resolved = project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE)
        if (resolved == null) {
            log.info("No closed contextual string union resolved for ${literal.text} at ${literal.textOffset}")
            notifyUnavailable(
                project,
                "No closed contextual string union was resolved. Details were written to the IDE log.",
            )
            return
        }
        log.info(
            "Resolved ${resolved.contextualTypeName ?: "unnamed union"}: " +
                resolved.assignableMembers.joinToString { it.value },
        )
        UnionMemberSwitcher.show(project, editor, literal, resolved)
    }

    private fun notifyUnavailable(project: com.intellij.openapi.project.Project, message: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("UnionBreeze")
            .createNotification("UnionBreeze", message, NotificationType.INFORMATION)
            .notify(project)
    }
}
