package dev.typebreeze.webstorm

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.vfs.*
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.concurrency.AppExecutorUtil
import org.eclipse.lsp4j.Position
import java.awt.BorderLayout
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JComponent
import javax.swing.JPanel

@Service(Service.Level.PROJECT)
@State(name="TypeBreezeProjectSettings",storages=[Storage(StoragePathMacros.WORKSPACE_FILE)])
class TypeBreezeProjectSettings:PersistentStateComponent<TypeBreezeProjectSettings.Options> {
    data class Options(var configFilePath:String=DEFAULT_CONFIG_FILE)
    private var options=Options()
    override fun getState()=options
    override fun loadState(state:Options){options=state}
    companion object {
        const val DEFAULT_CONFIG_FILE="mappings.brz.json"
        fun normalizeConfigFilePath(value:String):String? {
            val trimmed=value.trim();if(trimmed.isEmpty())return null
            if(trimmed.startsWith('/')||trimmed.startsWith('\\')||Regex("^[A-Za-z]:").containsMatchIn(trimmed))return null
            val path=runCatching{Path.of(trimmed)}.getOrNull()?:return null
            if(path.isAbsolute)return null
            val normalized=path.normalize();if(normalized.toString().isEmpty()||normalized.startsWith(".."))return null
            return normalized.toString().replace('\\','/')
        }
    }
}

private fun Project.mappingConfigRelativePath()=TypeBreezeProjectSettings.normalizeConfigFilePath(getService(TypeBreezeProjectSettings::class.java).state.configFilePath)?:TypeBreezeProjectSettings.DEFAULT_CONFIG_FILE
private fun Project.mappingConfigPath():Path? {
    val root=basePath?.let(Path::of)?.normalize()?:return null
    return root.resolve(mappingConfigRelativePath()).normalize().takeIf{it.startsWith(root)}
}

class CreateAutoMappingAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        val editor=e.getData(CommonDataKeys.EDITOR); val file=e.getData(CommonDataKeys.VIRTUAL_FILE)
        val selected=editor?.let(::selectedTypeName)
        e.presentation.isEnabledAndVisible=e.project!=null&&file?.let(TypeBreezeLspProvider::supports)==true&&selected!=null
        e.presentation.text=selected?.let { "Create auto-mapping for \"$it\" type" } ?: "Create auto-mapping"
    }
    override fun actionPerformed(e: AnActionEvent) {
        val project=e.project?:return; val editor=e.getData(CommonDataKeys.EDITOR)?:return; val file=e.getData(CommonDataKeys.VIRTUAL_FILE)?:return
        val root=project.basePath?.let(Path::of)?:return; val configPath=project.mappingConfigPath()?:return
        var config=readConfig(configPath)
        if(config==null){
            val output=Messages.showInputDialog(project,"Generated files folder, relative to the workspace:","Create ${project.mappingConfigRelativePath()}",Messages.getQuestionIcon(),"src/generated",null)?.trim()?.takeIf(String::isNotEmpty)?:return
            val resolved=root.resolve(output).normalize();if(!resolved.startsWith(root)){notify(project,"Output folder must be inside the workspace.");return}
            config=JsonObject().apply { addProperty("outputDirectory",output.replace('\\','/'));addProperty("keyTypeParameter","TKey");addProperty("resultTypeParameter","TResult");add("mappings",JsonObject()) }
        }
        val mappingConfig=config?:return
        val keyName=mappingConfig.get("keyTypeParameter")?.asString?:"TKey";val resultName=mappingConfig.get("resultTypeParameter")?.asString?:"TResult"; val document=editor.document; val stamp=document.modificationStamp
        val offset=editor.caretModel.offset; val line=document.getLineNumber(offset); val position=Position(line,offset-document.getLineStartOffset(line))
        AppExecutorUtil.getAppExecutorService().execute {
            val info=LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(file)}.firstNotNullOfOrNull { client -> runCatching { client.sendRequestSync(10_000){server->(server as TypeBreezeLanguageServer).mappingTypeAt(MappingTypeParams(client.getDocumentIdentifier(file),position,document.text,stamp,keyName,resultName))} }.getOrNull() }
            ApplicationManager.getApplication().invokeLater {
                if(info==null){notify(project,"The TypeScript mapping validator is not ready.");return@invokeLater}
                if(!info.valid){notify(project,info.reason?:"This type cannot be used for auto-mapping.");return@invokeLater}
                val dialog=MappingDialog(project,info.typeName,info.finiteKeyDomain);if(!dialog.showAndGet())return@invokeLater
                val mappings=(mappingConfig.get("mappings") as? JsonObject)?:JsonObject().also{mappingConfig.add("mappings",it)}
                if(mappings.has(dialog.mappingName)){notify(project,"A mapping named ${dialog.mappingName} already exists.");return@invokeLater}
                mappings.add(dialog.mappingName,JsonObject().apply { addProperty("path",info.path);addProperty("type",info.typeName);addProperty("requireAllKeys",dialog.requireAllKeys) })
                writeConfig(project,configPath,mappingConfig)
                project.getService(MappingGenerationService::class.java).regenerate(file)
            }
        }
    }
}

private fun selectedTypeName(editor:Editor):String? {
    val text=editor.document.text;val offset=editor.caretModel.offset
    return Regex("\\b(?:type|interface)\\s+([A-Za-z_$][\\w$]*)\\s*<").findAll(text).firstOrNull { match -> offset in match.range }?.groupValues?.get(1)
}
private fun readConfig(path:Path):JsonObject?=runCatching { if(java.nio.file.Files.exists(path))JsonParser.parseString(java.nio.file.Files.readString(path)).asJsonObject else null }.getOrNull()
private fun writeConfig(project:Project,path:Path,config:JsonObject){
    val text=GsonBuilder().setPrettyPrinting().create().toJson(config)+"\n"
    WriteCommandAction.runWriteCommandAction(project,"Create auto-mapping",null,Runnable {
        val parent=VfsUtil.createDirectoryIfMissing(path.parent.toString())?:return@Runnable
        val file=parent.findChild(path.fileName.toString())?:parent.createChildData(CreateAutoMappingAction::class.java,path.fileName.toString())
        VfsUtil.saveText(file,text)
    })
}
private fun notify(project:Project,message:String)=com.intellij.notification.NotificationGroupManager.getInstance().getNotificationGroup("TypeBreeze").createNotification("Auto-mapping",message,com.intellij.notification.NotificationType.WARNING).notify(project)

private class MappingDialog(project:Project,typeName:String,finiteKeyDomain:Boolean):DialogWrapper(project) {
    private val mappingNameField=JBTextField(typeName.removeSuffix("Props").let{"${it}s"})
    private val exhaustive=JBCheckBox("Require all keys to be defined",finiteKeyDomain).apply{isEnabled=finiteKeyDomain}
    val mappingName:String get()=mappingNameField.text.trim();val requireAllKeys:Boolean get()=exhaustive.isSelected
    init{title="Create auto-mapping for \"$typeName\" type";init()}
    override fun createCenterPanel():JComponent=JPanel(BorderLayout(0,8)).apply { add(JBLabel("Mapping name:"),BorderLayout.NORTH);add(mappingNameField,BorderLayout.CENTER);add(exhaustive,BorderLayout.SOUTH) }
    override fun doValidate():ValidationInfo?=if(!Regex("[A-Za-z_$][\\w$]*").matches(mappingName))ValidationInfo("Enter a valid TypeScript identifier.",mappingNameField)else null
    override fun getPreferredFocusedComponent()=mappingNameField
}

@Service(Service.Level.PROJECT)
class MappingGenerationService(private val project:Project):Disposable {
    private val generation=AtomicLong()
    @Volatile private var anchor:VirtualFile?=null
    init {
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES,object:BulkFileListener{override fun after(events:List<VFileEvent>){events.asSequence().mapNotNull{it.file}.firstOrNull{isMappingInput(it)}?.let(::schedule)}})
    }
    private fun isMappingInput(file:VirtualFile)=TypeBreezeLspProvider.supports(file)||Path.of(file.path).normalize()==project.mappingConfigPath()||file.name=="package.json"||file.name.startsWith(".prettierrc")||file.name.startsWith("prettier.config.")
    fun schedule(file:VirtualFile){if(TypeBreezeLspProvider.supports(file))anchor=file;val token=generation.incrementAndGet();AppExecutorUtil.getAppScheduledExecutorService().schedule({if(generation.get()==token)regenerate(file,0,token)},250,TimeUnit.MILLISECONDS)}
    fun regenerate(file:VirtualFile){val token=generation.incrementAndGet();regenerate(file,0,token)}
    fun configurationChanged(){generation.incrementAndGet();val file=anchor?.takeIf{it.isValid}?:FileEditorManager.getInstance(project).openFiles.firstOrNull(TypeBreezeLspProvider::supports)?:return;regenerate(file)}
    private fun regenerate(file:VirtualFile,attempt:Int,token:Long){
        if(project.isDisposed||project.basePath==null)return
        if(generation.get()!=token)return
        val requestFile=file.takeIf(TypeBreezeLspProvider::supports)?:anchor?.takeIf{it.isValid}?:com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFiles.firstOrNull(TypeBreezeLspProvider::supports)?:return
        anchor=requestFile
        val clients=LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(requestFile)}
        if(clients.isEmpty()){if(attempt<20)AppExecutorUtil.getAppScheduledExecutorService().schedule({regenerate(requestFile,attempt+1,token)},500,TimeUnit.MILLISECONDS);return}
        AppExecutorUtil.getAppExecutorService().execute {
            val configFilePath=project.mappingConfigRelativePath()
            val plan=clients.firstNotNullOfOrNull{client->runCatching{client.sendRequestSync(30_000){server->(server as TypeBreezeLanguageServer).mappingGeneration(mapOf("configFilePath" to configFilePath))}}.onFailure{LOG.warn("Mapping generation failed",it)}.getOrNull()}?:return@execute
            ApplicationManager.getApplication().invokeLater {
                if(generation.get()!=token)return@invokeLater
                val root=Path.of(project.basePath!!).normalize()
                ApplicationManager.getApplication().runWriteAction { for(generated in plan.files){val target=root.resolve(generated.path).normalize();if(!target.startsWith(root))continue;val parent=VfsUtil.createDirectoryIfMissing(target.parent.toString())?:continue;val out=parent.findChild(target.fileName.toString())?:parent.createChildData(this,target.fileName.toString());if(VfsUtil.loadText(out)!=generated.content)VfsUtil.saveText(out,generated.content)} }
                LOG.info("Auto-mapping generated ${plan.files.size} file(s), ${plan.occurrences.size} gutter occurrence(s), and ${plan.diagnosticDocuments.sumOf{it.diagnostics.size}} diagnostic(s)")
                project.getService(MappingOccurrenceCache::class.java).replace(plan.occurrences)
                if(plan.diagnostics.isNotEmpty())notify(project,plan.diagnostics.joinToString("\n"){"${it.path}: ${it.message}"})
            }
        }
    }
    override fun dispose() {}
    companion object{private val LOG=Logger.getInstance(MappingGenerationService::class.java)}
}

@Service(Service.Level.PROJECT)
class MappingOccurrenceCache(private val project:Project) {
    private val entries=java.util.concurrent.ConcurrentHashMap<String,List<MappingOccurrence>>()
    fun replace(occurrences:List<MappingOccurrence>){val affected=entries.keys.toSet()+occurrences.map{it.uri};entries.clear();occurrences.groupBy{it.uri}.forEach{(uri,items)->entries[uri]=items};for(uri in affected)VirtualFileManager.getInstance().findFileByUrl(uri)?.let{com.intellij.psi.PsiManager.getInstance(project).findFile(it)}?.let{com.intellij.codeInsight.daemon.DaemonCodeAnalyzer.getInstance(project).restart(it)}}
    fun matching(file:VirtualFile,element:com.intellij.psi.PsiElement):MappingOccurrence? {
        if(element.firstChild!=null)return null
        val document=FileDocumentManager.getInstance().getDocument(file)?:return null
        return entries[file.url]?.firstOrNull { occurrence ->
            if(occurrence.range.start.line !in 0 until document.lineCount||occurrence.range.end.line !in 0 until document.lineCount){if(element===element.containingFile&&LOG.isDebugEnabled)LOG.debug("Unmatched mapping occurrence ${occurrence.uri}:${occurrence.range}; invalid document line range") ;return@firstOrNull false}
            val wanted=com.intellij.openapi.util.TextRange(document.getLineStartOffset(occurrence.range.start.line)+occurrence.range.start.character,document.getLineStartOffset(occurrence.range.end.line)+occurrence.range.end.character)
            val startOffset=wanted.startOffset.coerceIn(0,document.textLength.coerceAtLeast(1)-1)
            val anchor=element.containingFile.findElementAt(startOffset)?:return@firstOrNull false
            var containing:com.intellij.psi.PsiElement?=anchor
            while(containing!=null&&!containing.textRange.contains(wanted))containing=containing.parent
            if(containing==null){if(LOG.isDebugEnabled)LOG.debug("Unmatched mapping occurrence ${occurrence.uri}:${occurrence.range}; nearby PSI ${anchor.javaClass.name}");return@firstOrNull false}
            element===anchor
        }
    }
    fun navigate(source:VirtualFile,occurrence:MappingOccurrence){val manager=VirtualFileManager.getInstance();manager.findFileByUrl(occurrence.targetUri)?.let{FileEditorManager.getInstance(project).openFile(it,true);return};project.getService(MappingGenerationService::class.java).regenerate(source);openWhenReady(occurrence.targetUri,0)}
    private fun openWhenReady(targetUri:String,attempt:Int){AppExecutorUtil.getAppScheduledExecutorService().schedule({ApplicationManager.getApplication().invokeLater{val file=VirtualFileManager.getInstance().refreshAndFindFileByUrl(targetUri);if(file!=null)FileEditorManager.getInstance(project).openFile(file,true)else if(attempt<30)openWhenReady(targetUri,attempt+1)}},250,TimeUnit.MILLISECONDS)}
    companion object{private val LOG=Logger.getInstance(MappingOccurrenceCache::class.java)}
}
