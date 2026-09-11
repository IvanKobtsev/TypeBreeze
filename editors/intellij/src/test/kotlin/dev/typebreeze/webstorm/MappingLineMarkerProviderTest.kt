package dev.typebreeze.webstorm

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.Range

class MappingLineMarkerProviderTest : BasePlatformTestCase() {
    fun testTsxSemanticRangesProduceExactlyOneMarkerEach() {
        val file=myFixture.configureByText("mapping.tsx","""
            export type Connector<TKey extends 'one'> = { key: TKey };
            export function Component(props: Connector<'one'>) { return <div />; }
        """.trimIndent())
        val document=myFixture.editor.document
        fun occurrence(name:String,kind:String):MappingOccurrence {
            val start=document.text.indexOf(name)
            val startPoint=document.offsetToLogicalPosition(start)
            val endPoint=document.offsetToLogicalPosition(start+name.length)
            return MappingOccurrence(file.virtualFile.url,Range(Position(startPoint.line,startPoint.column),Position(endPoint.line,endPoint.column)),kind,"Components","file:///generated/Connector.map.ts")
        }
        project.getService(MappingOccurrenceCache::class.java).replace(listOf(occurrence("Connector","connector"),occurrence("Component","component")))
        val provider=MappingLineMarkerProvider()
        val markers=mutableListOf<com.intellij.codeInsight.daemon.LineMarkerInfo<*>>()
        file.accept(object:com.intellij.psi.PsiRecursiveElementWalkingVisitor(){override fun visitElement(element:com.intellij.psi.PsiElement){provider.getLineMarkerInfo(element)?.let(markers::add);super.visitElement(element)}})
        assertEquals(2,markers.size)
        assertTrue(markers.any{it.lineMarkerTooltip?.contains("Auto-mapping connector") == true})
        assertTrue(markers.any{it.lineMarkerTooltip?.contains("Mapped component") == true})
    }
}
