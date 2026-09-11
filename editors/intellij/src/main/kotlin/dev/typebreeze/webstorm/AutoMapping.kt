package dev.typebreeze.webstorm

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
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
        val root=project.basePath?.let(Path::of)?:return; val configPath=root.resolve("mappings.brz.json")
        var config=readConfig(configPath)
        if(config==null){
            val output=Messages.showInputDialog(project,"Generated files folder, relative to the workspace:","Create mappings.brz.json",Messages.getQuestionIcon(),"src/generated",null)?.trim()?.takeIf(String::isNotEmpty)?:return
            val resolved=root.resolve(output).normalize();if(!resolved.startsWith(root)){notify(project,"Output folder must be inside the workspace.");return}
            config=JsonObject().apply { addProperty("outputDirectory",output.replace('\\','/'));addProperty("keyTypeParameter","TKey");add("mappings",JsonObject()) }
        }
        val mappingConfig=config?:return
        val keyName=mappingConfig.get("keyTypeParameter")?.asString?:"TKey"; val document=editor.document; val stamp=document.modificationStamp
        val offset=editor.caretModel.offset; val line=document.getLineNumber(offset); val position=Position(line,offset-document.getLineStartOffset(line))
        AppExecutorUtil.getAppExecutorService().execute {
            val info=LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(file)}.firstNotNullOfOrNull { client -> runCatching { client.sendRequestSync(10_000){server->(server as TypeBreezeLanguageServer).mappingTypeAt(MappingTypeParams(client.getDocumentIdentifier(file),position,document.text,stamp,keyName))} }.getOrNull() }
            ApplicationManager.getApplication().invokeLater {
                if(info==null){notify(project,"The TypeScript mapping validator is not ready.");return@invokeLater}
                if(!info.valid){notify(project,info.reason?:"This type cannot be used for auto-mapping.");return@invokeLater}
                val dialog=MappingDialog(project,info.typeName);if(!dialog.showAndGet())return@invokeLater
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

private class MappingDialog(project:Project,typeName:String):DialogWrapper(project) {
    private val name=JBTextField(typeName.removeSuffix("Props").let{"${it}s"})
    private val exhaustive=JBCheckBox("Require all keys to be defined",true)
    val mappingName:String get()=name.text.trim();val requireAllKeys:Boolean get()=exhaustive.isSelected
    init{title="Create auto-mapping for \"$typeName\" type";init()}
    override fun createCenterPanel():JComponent=JPanel(BorderLayout(0,8)).apply { add(JBLabel("Mapping name:"),BorderLayout.NORTH);add(name,BorderLayout.CENTER);add(exhaustive,BorderLayout.SOUTH) }
    override fun doValidate():ValidationInfo?=if(!Regex("[A-Za-z_$][\\w$]*").matches(mappingName))ValidationInfo("Enter a valid TypeScript identifier.",name)else null
    override fun getPreferredFocusedComponent()=name
}

@Service(Service.Level.PROJECT)
class MappingGenerationService(private val project:Project):Disposable {
    private val generation=AtomicLong()
    init {
        project.messageBus.connect(this).subscribe(FileDocumentManagerListener.TOPIC,object:FileDocumentManagerListener{override fun beforeDocumentSaving(document:com.intellij.openapi.editor.Document){FileDocumentManager.getInstance().getFile(document)?.takeIf{it.name=="mappings.brz.json"||TypeBreezeLspProvider.supports(it)}?.let(::schedule)}})
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES,object:BulkFileListener{override fun after(events:List<VFileEvent>){events.asSequence().mapNotNull{it.file}.firstOrNull{it.name=="mappings.brz.json"||TypeBreezeLspProvider.supports(it)}?.let(::schedule)}})
    }
    fun schedule(file:VirtualFile){val token=generation.incrementAndGet();AppExecutorUtil.getAppScheduledExecutorService().schedule({if(generation.get()==token)regenerate(file)},250,TimeUnit.MILLISECONDS)}
    fun regenerate(file:VirtualFile){
        if(project.isDisposed||project.basePath==null)return
        val clients=LspClientManager.getInstance(project).getClients(TypeBreezeLspProvider::class.java).filter{it.descriptor.isSupportedFile(file)};if(clients.isEmpty())return
        AppExecutorUtil.getAppExecutorService().execute {
            val plan=clients.firstNotNullOfOrNull{client->runCatching{client.sendRequestSync(30_000){server->(server as TypeBreezeLanguageServer).mappingGeneration()}}.onFailure{LOG.warn("Mapping generation failed",it)}.getOrNull()}?:return@execute
            ApplicationManager.getApplication().invokeLater {
                val root=Path.of(project.basePath!!).normalize()
                ApplicationManager.getApplication().runWriteAction { for(generated in plan.files){val target=root.resolve(generated.path).normalize();if(!target.startsWith(root))continue;val parent=VfsUtil.createDirectoryIfMissing(target.parent.toString())?:continue;val out=parent.findChild(target.fileName.toString())?:parent.createChildData(this,target.fileName.toString());if(VfsUtil.loadText(out)!=generated.content)VfsUtil.saveText(out,generated.content)} }
                if(plan.diagnostics.isNotEmpty())notify(project,plan.diagnostics.joinToString("\n"){"${it.path}: ${it.message}"})
            }
        }
    }
    override fun dispose()={}
    companion object{private val LOG=Logger.getInstance(MappingGenerationService::class.java)}
}
