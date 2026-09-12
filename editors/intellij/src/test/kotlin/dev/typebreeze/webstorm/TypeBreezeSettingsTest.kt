package dev.typebreeze.webstorm

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Container
import javax.swing.AbstractButton
import javax.swing.JLabel

class TypeBreezeSettingsTest:BasePlatformTestCase() {
    fun testConfigPathValidationAndNormalization() {
        assertEquals("mappings.brz.json",TypeBreezeProjectSettings.normalizeConfigFilePath(" mappings.brz.json "))
        assertEquals("config/mappings.brz.json",TypeBreezeProjectSettings.normalizeConfigFilePath("config\\mappings.brz.json"))
        assertNull(TypeBreezeProjectSettings.normalizeConfigFilePath(""))
        assertNull(TypeBreezeProjectSettings.normalizeConfigFilePath("../mappings.brz.json"))
        assertNull(TypeBreezeProjectSettings.normalizeConfigFilePath("config/../../mappings.brz.json"))
        assertNull(TypeBreezeProjectSettings.normalizeConfigFilePath("/mappings.brz.json"))
        assertNull(TypeBreezeProjectSettings.normalizeConfigFilePath("C:\\mappings.brz.json"))
    }

    fun testSettingsAreGroupedByFeature() {
        val component=TypeBreezeConfigurable(project).createComponent()!!
        val text=allText(component)
        assertTrue(text.contains("Union intelligence"))
        assertTrue(text.contains("Fade unused union members"))
        assertTrue(text.contains("Overloads diff"))
        assertTrue(text.contains("Fade repeated overload syntax"))
        assertTrue(text.contains("Auto-mapping generator"))
        assertTrue(text.contains("Config file path:"))
        assertFalse(text.any{it.contains("Extension methods")||it.contains("Style union member")||it.contains("Style contextual")})
    }

    fun testUnionAnnotatorSupportsTsAndTsx() {
        val pluginXml=java.io.File("src/main/resources/META-INF/plugin.xml").readText()
        assertTrue(pluginXml.contains("<annotator language=\"TypeScript\" implementationClass=\"dev.typebreeze.webstorm.TypeBreezeAnnotator\"/>"))
        assertTrue(pluginXml.contains("<annotator language=\"TypeScript JSX\" implementationClass=\"dev.typebreeze.webstorm.TypeBreezeAnnotator\"/>"))
    }

    private fun allText(container:Container):List<String> = container.components.flatMap { component ->
        val own=when(component){is JLabel->listOf(component.text);is AbstractButton->listOf(component.text);else->emptyList()}
        own+(component as? Container)?.let(::allText).orEmpty()
    }
}
