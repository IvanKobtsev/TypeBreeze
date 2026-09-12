package dev.typebreeze.webstorm

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
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.NlsContexts
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import javax.swing.Icon
import javax.swing.JComponent

object TypeBreezeColors {
    val DECLARATION=TextAttributesKey.createTextAttributesKey("TYPEBREEZE_DECLARATION",DefaultLanguageHighlighterColors.STRING)
    val USAGE=TextAttributesKey.createTextAttributesKey("TYPEBREEZE_USAGE",DefaultLanguageHighlighterColors.STRING)
    val UNUSED_DECLARATION=TextAttributesKey.createTextAttributesKey("TYPEBREEZE_UNUSED_DECLARATION",CodeInsightColors.NOT_USED_ELEMENT_ATTRIBUTES)
    val EXTENSION_METHOD=TextAttributesKey.createTextAttributesKey("TYPEBREEZE_EXTENSION_METHOD",DefaultLanguageHighlighterColors.INSTANCE_METHOD)
    val REPEATED_OVERLOAD=TextAttributesKey.createTextAttributesKey("TYPEBREEZE_REPEATED_OVERLOAD",DefaultLanguageHighlighterColors.LINE_COMMENT)
}

class TypeBreezeColorSettingsPage:ColorSettingsPage {
    override fun getIcon():Icon?=null
    override fun getHighlighter():SyntaxHighlighter=PlainSyntaxHighlighter()
    override fun getDemoText()="""type Status = <unionDeclaration>'draft'</unionDeclaration> | <unusedUnionDeclaration>'published'</unusedUnionDeclaration>;
const status: Status = <unionUsage>'draft'</unionUsage>;
const ordinary = 'draft';
function <extensionMethod>truncate</extensionMethod>(value: string, length: number) { return value.slice(0, length); }
<extensionMethod>truncate</extensionMethod>('hello', 3);
function <repeatedOverload>callMethod</repeatedOverload>(<repeatedOverload>key</repeatedOverload>: Key): Result;
function <repeatedOverload>callMethod</repeatedOverload>(<repeatedOverload>key</repeatedOverload>: Key | null): Result | null;"""
    override fun getAdditionalHighlightingTagToDescriptorMap()=mapOf("unionDeclaration" to TypeBreezeColors.DECLARATION,"unusedUnionDeclaration" to TypeBreezeColors.UNUSED_DECLARATION,"unionUsage" to TypeBreezeColors.USAGE,"extensionMethod" to TypeBreezeColors.EXTENSION_METHOD,"repeatedOverload" to TypeBreezeColors.REPEATED_OVERLOAD)
    override fun getAttributeDescriptors()=arrayOf(AttributesDescriptor("Union member declaration",TypeBreezeColors.DECLARATION),AttributesDescriptor("Unused union member declaration",TypeBreezeColors.UNUSED_DECLARATION),AttributesDescriptor("Union member usage",TypeBreezeColors.USAGE),AttributesDescriptor("Extension method declaration and call",TypeBreezeColors.EXTENSION_METHOD),AttributesDescriptor("Repeated overload syntax",TypeBreezeColors.REPEATED_OVERLOAD))
    override fun getColorDescriptors():Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY
    override fun getDisplayName()="TypeBreeze"
}

class TypeBreezeAnnotator:Annotator {
    override fun annotate(element:PsiElement,holder:AnnotationHolder){
        val literal=element as? JSLiteralExpression?:return;if(!literal.isStringLiteral)return
        val file=literal.containingFile.virtualFile?:return;val document=literal.containingFile.viewProvider.document?:return
        val resolved=literal.project.getService(UnionCache::class.java).matching(file,document,literal.textRange)?:return
        val settings=TypeBreezeSettings.instance.state;val key=when(resolved.kind){"declaration"->if(settings.fadeUnusedDeclarations&&resolved.hasUsages==false)TypeBreezeColors.UNUSED_DECLARATION else TypeBreezeColors.DECLARATION;"usage"->TypeBreezeColors.USAGE;else->return}
        val range=literal.textRange.let{if(it.length>1)TextRange(it.startOffset+1,it.endOffset-1)else it};holder.newSilentAnnotation(HighlightSeverity.INFORMATION).range(range).textAttributes(key).create()
    }
}

@Service(Service.Level.APP)
@State(name="TypeBreezeSettings",storages=[Storage("typebreeze.xml")])
class TypeBreezeSettings:PersistentStateComponent<TypeBreezeSettings.Options> {
    data class Options(var fadeUnusedDeclarations:Boolean=true,var fadeRepeatedOverloadSyntax:Boolean=true)
    private var options=Options();override fun getState()=options;override fun loadState(state:Options){options=state}
    companion object { val instance:TypeBreezeSettings get()=ApplicationManager.getApplication().getService(TypeBreezeSettings::class.java) }
}

class TypeBreezeConfigurable(private val project:com.intellij.openapi.project.Project):BoundConfigurable("TypeBreeze") {
    private val projectSettings get()=project.getService(TypeBreezeProjectSettings::class.java)
    override fun createPanel()=panel {
        val settings=TypeBreezeSettings.instance.state
        group("Union intelligence"){row{checkBox("Fade unused union members").bindSelected(settings::fadeUnusedDeclarations)}}
        group("Overloads diff"){row{checkBox("Fade repeated overload syntax").bindSelected(settings::fadeRepeatedOverloadSyntax)}}
        group("Auto-mapping generator"){row("Config file path:"){textField().bindText(projectSettings.state::configFilePath).resizableColumn()}}
    }
    override fun apply(){
        val oldPath=projectSettings.state.configFilePath
        super.apply()
        val normalized=TypeBreezeProjectSettings.normalizeConfigFilePath(projectSettings.state.configFilePath)
            ?:run{projectSettings.state.configFilePath=oldPath;throw ConfigurationException("Config file path must be a non-empty path inside the workspace.")}
        projectSettings.state.configFilePath=normalized
        ProjectManager.getInstance().openProjects.forEach{com.intellij.codeInsight.daemon.DaemonCodeAnalyzer.getInstance(it).restart()}
        if(oldPath!=normalized)project.getService(MappingGenerationService::class.java).configurationChanged()
    }
}
