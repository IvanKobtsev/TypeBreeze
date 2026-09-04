package dev.unionbreeze.webstorm

import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class PublicApiUnionResolverTest : BasePlatformTestCase() {
    fun testDirectAnnotation() {
        assertMembers(
            "type Status = 'draft' | 'published'; const value: Status = '<caret>draft';",
            "draft", "published",
        )
    }

    fun testFunctionArgument() {
        assertMembers(
            "type Status = 'draft' | 'published'; function setStatus(value: Status) {} setStatus('<caret>draft');",
            "draft", "published",
        )
    }

    fun testTypedObjectProperty() {
        assertMembers(
            "type Status = 'draft' | 'published'; interface Item { status: Status } const item: Item = { status: '<caret>draft' };",
            "draft", "published",
        )
    }

    fun testImportedAlias() {
        myFixture.addFileToProject("status.ts", "export type Status = 'draft' | 'published';")
        assertMembers(
            "import type { Status } from './status'; const value: Status = '<caret>draft';",
            "draft", "published",
        )
    }

    fun testRejectsOrdinaryString() {
        myFixture.configureByText("test.ts", "const value = '<caret>draft';")
        assertNull(resolveAtCaret())
    }

    fun testRejectsOpenUnion() {
        myFixture.configureByText("test.ts", "type Value = 'draft' | string; const value: Value = '<caret>draft';")
        assertNull(resolveAtCaret())
    }

    fun testReplacementPreservesQuotesAndIsUndoable() {
        myFixture.configureByText(
            "test.ts",
            "type Status = \"draft\" | \"published\"; const value: Status = \"<caret>draft\";",
        )
        val literal = literalAtCaret()
        assertTrue(UnionMemberSwitcher.replaceLiteral(project, myFixture.editor, literal, "published"))
        myFixture.checkResult(
            "type Status = \"draft\" | \"published\"; const value: Status = \"published\";",
        )
        myFixture.performEditorAction(IdeActions.ACTION_UNDO)
        myFixture.checkResult(
            "type Status = \"draft\" | \"published\"; const value: Status = \"draft\";",
        )
    }

    private fun assertMembers(source: String, vararg expected: String) {
        myFixture.configureByText("test.ts", source)
        val resolved = resolveAtCaret()
        assertNotNull(resolved)
        assertEquals(expected.toList(), resolved!!.assignableMembers.map(UnionMember::value))
        assertEquals(ResolutionConfidence.HIGH, resolved.confidence)
    }

    private fun resolveAtCaret(): ResolvedLiteralUnion? {
        val literal = literalAtCaret()
        return project.getService(PublicApiUnionResolver::class.java)
            .resolveLiteralNow(literal, ResolutionMode.ASSIGNABLE_HERE)
    }

    private fun literalAtCaret(): JSLiteralExpression {
        val element = myFixture.file.findElementAt(myFixture.caretOffset)
            ?: error("No PSI element at caret")
        return generateSequence(element) { it.parent }
            .filterIsInstance<JSLiteralExpression>()
            .first()
    }
}
