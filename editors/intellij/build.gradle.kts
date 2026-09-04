import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}
group = "dev.unionbreeze"
version = "0.3.0"
repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies {
    intellijPlatform { webstorm("2026.2.1"); bundledPlugin("JavaScript"); testFramework(TestFrameworkType.Platform) }
    testImplementation(kotlin("test"))
}
tasks.withType<KotlinCompile>().configureEach { compilerOptions.jvmTarget = JvmTarget.JVM_25 }
intellijPlatform {
    instrumentCode = false
    pluginConfiguration { ideaVersion { sinceBuild = "262.9437.145"; untilBuild = "262.*" } }
    pluginVerification { ides { recommended() } }
}
