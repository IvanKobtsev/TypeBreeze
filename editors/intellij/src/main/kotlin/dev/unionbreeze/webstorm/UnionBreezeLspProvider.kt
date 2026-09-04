package dev.unionbreeze.webstorm

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspIntegrationProvider
import com.intellij.platform.lsp.api.ProjectWideLspClientDescriptor
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.eclipse.lsp4j.services.LanguageServer

class UnionBreezeLspProvider : LspIntegrationProvider {
    override fun fileOpened(project: Project, file: VirtualFile, clientStarter: LspIntegrationProvider.LspClientStarter) { if (supports(file)){clientStarter.ensureClientStarted(Descriptor(project));project.getService(UnionCache::class.java).refresh(file)} }
    companion object { fun supports(file: VirtualFile)=file.extension?.lowercase() in setOf("ts","tsx") }
}
private class Descriptor(project: Project):ProjectWideLspClientDescriptor(project,"UnionBreeze") {
    override fun isSupportedFile(file: VirtualFile)=UnionBreezeLspProvider.supports(file)
    override fun createCommandLine()=GeneralCommandLine(BundledServer.executable().toString()).withEnvironment("UNIONBREEZE_LOG","1")
    override val lsp4jServerClass:Class<out LanguageServer> get()=UnionBreezeLanguageServer::class.java
}
internal object BundledServer {
    fun executable():Path {
        System.getenv("UNIONBREEZE_SERVER_PATH")?.let{return Path.of(it)}
        val os=System.getProperty("os.name").lowercase();val arch=System.getProperty("os.arch").lowercase()
        val platform=when { os.contains("win")&&arch in setOf("aarch64","arm64")->"windows-arm64/unionbreeze.exe";os.contains("win")->"windows-x64/unionbreeze.exe";os.contains("mac")&&arch.contains("aarch64")->"macos-arm64/unionbreeze";os.contains("mac")->"macos-x64/unionbreeze";arch.contains("aarch64")->"linux-arm64/unionbreeze";else->"linux-x64/unionbreeze" }
        val bytes=checkNotNull(javaClass.getResourceAsStream("/bin/$platform")){"Missing bundled server /bin/$platform"}.use{it.readBytes()}
        val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
        val target=PathManager.getSystemDir().resolve("plugins/unionbreeze/$hash/${platform.substringAfterLast('/')}")
        if(!Files.exists(target)){Files.createDirectories(target.parent);Files.copy(bytes.inputStream(),target,StandardCopyOption.REPLACE_EXISTING);target.toFile().setExecutable(true,true)}
        return target
    }
}
