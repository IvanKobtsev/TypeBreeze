package dev.unionbreeze.webstorm

import com.intellij.lang.annotation.Annotator
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.CodeInsightColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.PlainSyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.NlsContexts
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.panel
import javax.swing.Icon
import javax.swing.JComponent

object UnionBreezeColors {
    val DECLARATION=TextAttributesKey.createTextAttributesKey("UNIONBREEZE_DECLARATION",DefaultLanguageHighlighterColors.STRING)
    val USAGE=TextAttributesKey.createTextAttributesKey("UNIONBREEZE_USAGE",DefaultLanguageHighlighterColors.STRING)
    val UNUSED_DECLARATION=TextAttributesKey.createTextAttributesKey("UNIONBREEZE_UNUSED_DECLARATION",CodeInsightColors.NOT_USED_ELEMENT_ATTRIBUTES)
}

class UnionBreezeColorSettingsPage:ColorSettingsPage {
    override fun getIcon():Icon?=null
    override fun getHighlighter():SyntaxHighlighter=PlainSyntaxHighlighter()
    override fun getDemoText()="""type Status = <unionDeclaration>'draft'</unionDeclaration> | <unusedUnionDeclaration>'published'</unusedUnionDeclaration>;
const status: Status = <unionUsage>'draft'</unionUsage>;
const ordinary = 'draft';"""
    override fun getAdditionalHighlightingTagToDescriptorMap()=mapOf("unionDeclaration" to UnionBreezeColors.DECLARATION,"unusedUnionDeclaration" to UnionBreezeColors.UNUSED_DECLARATION,"unionUsage" to UnionBreezeColors.USAGE)
    override fun getAttributeDescriptors()=arrayOf(AttributesDescriptor("Union member declaration",UnionBreezeColors.DECLARATION),AttributesDescriptor("Unused union member declaration",UnionBreezeColors.UNUSED_DECLARATION),AttributesDescriptor("Union member usage",UnionBreezeColors.USAGE))
    override fun getColorDescriptors():Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY
    override fun getDisplayName()="UnionBreeze"
}

class UnionBreezeAnnotator:Annotator {
    override fun annotate(element:PsiElement,holder:AnnotationHolder){
        val literal=element as? JSLiteralExpression?:return;if(!literal.isStringLiteral)return
        val file=literal.containingFile.virtualFile?:return;val document=literal.containingFile.viewProvider.document?:return
        val resolved=literal.project.getService(UnionCache::class.java).matching(file,document,literal.textRange)?:return
        val settings=UnionBreezeSettings.instance.state;val key=when(resolved.kind){"declaration"->if(settings.styleDeclarations){if(settings.fadeUnusedDeclarations&&resolved.hasUsages==false)UnionBreezeColors.UNUSED_DECLARATION else UnionBreezeColors.DECLARATION}else return;"usage"->if(settings.styleUsages)UnionBreezeColors.USAGE else return;else->return}
        val range=literal.textRange.let{if(it.length>1)TextRange(it.startOffset+1,it.endOffset-1)else it};holder.newSilentAnnotation(HighlightSeverity.INFORMATION).range(range).textAttributes(key).create()
    }
}

@Service(Service.Level.APP)
@State(name="UnionBreezeSettings",storages=[Storage("unionbreeze.xml")])
class UnionBreezeSettings:PersistentStateComponent<UnionBreezeSettings.Options> {
    data class Options(var styleDeclarations:Boolean=true,var styleUsages:Boolean=true,var fadeUnusedDeclarations:Boolean=true)
    private var options=Options();override fun getState()=options;override fun loadState(state:Options){options=state}
    companion object { val instance:UnionBreezeSettings get()=ApplicationManager.getApplication().getService(UnionBreezeSettings::class.java) }
}

class UnionBreezeConfigurable:BoundConfigurable("UnionBreeze") {
    override fun createPanel()=panel { val settings=UnionBreezeSettings.instance.state;row{checkBox("Style union member declarations").bindSelected(settings::styleDeclarations)};row{checkBox("Fade declarations without usages").bindSelected(settings::fadeUnusedDeclarations)};row{checkBox("Style contextual union member usages").bindSelected(settings::styleUsages)} }
    override fun apply(){super.apply();ProjectManager.getInstance().openProjects.forEach{com.intellij.codeInsight.daemon.DaemonCodeAnalyzer.getInstance(it).restart()}}
}
