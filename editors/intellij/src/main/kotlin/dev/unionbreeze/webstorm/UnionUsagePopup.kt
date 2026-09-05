package dev.unionbreeze.webstorm

import com.intellij.find.actions.ShowUsagesAction
import com.intellij.find.actions.ShowUsagesActionHandler
import com.intellij.find.actions.ShowUsagesParameters
import com.intellij.internal.statistic.eventLog.events.EventPair
import com.intellij.lang.Language
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.psi.PsiElement
import com.intellij.psi.SmartPointerManager
import com.intellij.psi.SmartPsiElementPointer
import com.intellij.psi.impl.FakePsiElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.SearchScope
import com.intellij.ui.awt.RelativePoint
import com.intellij.usageView.UsageInfo
import com.intellij.usages.UsageInfo2UsageAdapter
import com.intellij.usages.UsageSearchPresentation
import com.intellij.usages.UsageSearcher

internal class UnionBreezeUsagesTarget(
    declaration: PsiElement,
    private val editor: Editor,
    usages: List<PsiElement>,
) : FakePsiElement() {
    private val declarationPointer = SmartPointerManager.createPointer(declaration)
    private val usagePointers = usages.map(SmartPointerManager::createPointer)

    override fun getParent(): PsiElement? = declarationPointer.element

    override fun getName(): String? = declarationPointer.element?.text

    override fun canNavigate(): Boolean = true

    override fun canNavigateToSource(): Boolean = true

    override fun navigate(requestFocus: Boolean) {
        val declaration = declarationPointer.element ?: return
        val validUsages = usagePointers.mapNotNull(SmartPsiElementPointer<PsiElement>::getElement)
        if (validUsages.isEmpty()) return
        if (validUsages.size == 1) {
            val usage = validUsages.single()
            val usageFile = usage.containingFile?.virtualFile ?: return
            OpenFileDescriptor(usage.project, usageFile, usage.textOffset).navigate(requestFocus)
            return
        }
        val handler = UnionBreezeShowUsagesHandler(declaration, validUsages)
        val parameters = ShowUsagesParameters.initial(
            declaration.project,
            editor,
            RelativePoint.getCenterOf(editor.contentComponent),
        )
        ShowUsagesAction.showElementUsagesWithResult(
            parameters,
            handler,
            handler.createUsageView(declaration.project),
        )
    }
}

private class UnionBreezeShowUsagesHandler(
    private val declaration: PsiElement,
    usageElements: List<PsiElement>,
) : ShowUsagesActionHandler {
    private val usages = usageElements.map { UsageInfo2UsageAdapter(UsageInfo(it)) }
    private val scope = GlobalSearchScope.projectScope(declaration.project)

    override fun isValid(): Boolean = declaration.isValid

    override fun getPresentation(): UsageSearchPresentation = object : UsageSearchPresentation {
        override fun getSearchTargetString(): String = declaration.text

        override fun getOptionsString(): String = "UnionBreeze union member usages"
    }

    override fun createUsageSearcher(): UsageSearcher = UsageSearcher { processor ->
        usages.forEach { if (!processor.process(it)) return@UsageSearcher }
    }

    override fun findUsages() = Unit

    override fun showDialog(): ShowUsagesActionHandler = this

    override fun withScope(scope: SearchScope): ShowUsagesActionHandler = this

    override fun moreUsages(parameters: ShowUsagesParameters): ShowUsagesParameters = parameters.moreUsages()

    override fun getSelectedScope(): SearchScope = scope

    override fun getMaximalScope(): SearchScope = scope

    override fun getTargetLanguage(): Language = declaration.language

    override fun getTargetClass(): Class<*> = declaration.javaClass

    override fun getEventData(): List<EventPair<*>> = mutableListOf()

    override fun navigateToSingleUsageImmediately(): Boolean = false

    override fun buildFinishEventData(usage: UsageInfo?): List<EventPair<*>> = mutableListOf()
}
