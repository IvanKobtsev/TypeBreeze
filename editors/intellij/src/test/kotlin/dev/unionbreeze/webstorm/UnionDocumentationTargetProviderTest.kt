package dev.unionbreeze.webstorm

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.Range

class UnionDocumentationTargetProviderTest : BasePlatformTestCase() {
    fun testObjectValueOwnsDocumentationInsteadOfProperty() {
        val text = "declare function toast(props: { styleType: 'normal' | 'wide' }): void;\ntoast({ styleType: 'wide' });"
        val file = myFixture.configureByText("Toast.tsx", text)
        val document = myFixture.editor.document
        val start = text.lastIndexOf("'wide'")
        val line = document.getLineNumber(start)
        val column = start - document.getLineStartOffset(line)
        project.getService(UnionCache::class.java).put(file.virtualFile, document, ResolvedLiteral(
            range = Range(Position(line, column), Position(line, column + 6)),
            currentValue = "wide",
            contextualTypeName = "ToastStyleType",
            declaredMembers = listOf(UnionMember("normal"), UnionMember("wide")),
        ))
        val provider = UnionDocumentationTargetProvider()
        val target = provider.documentationTargets(file, start + 2).single()
        val hint = target.computeDocumentationHint()!!
        assertTrue(hint.contains("ToastStyleType"))
        assertTrue(hint.contains("Union member &quot;wide&quot;"))
        assertFalse(hint.contains("styleType:"))
        assertNotNull(target.createPointer().dereference())
        assertEmpty(provider.documentationTargets(file, text.lastIndexOf("styleType") + 2))
    }

    fun testOrdinaryStringDoesNotOverrideDocumentation() {
        val file = myFixture.configureByText("ordinary.tsx", "const ordinary = 'wide';")
        assertEmpty(UnionDocumentationTargetProvider().documentationTargets(file, file.text.indexOf("wide") + 1))
    }
}
