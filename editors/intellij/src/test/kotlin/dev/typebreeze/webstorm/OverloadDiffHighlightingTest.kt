package dev.typebreeze.webstorm

import com.intellij.lang.javascript.psi.JSFunction
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class OverloadDiffHighlightingTest : BasePlatformTestCase() {
    fun testFadesOnlyComponentsSharedAcrossWholeFunctionGroup() {
        val text = """
            export function callMethod(key: Key, props: Props): Result;
            export function callMethod(key: Key | null, props: Props): Result | null;
            export function callMethod(key: Key | undefined, props: Props): Result | undefined;
            export function callMethod(key: Key | null | undefined, props: Props): Result | null | undefined { throw Error(); }
        """.trimIndent()
        val file = myFixture.configureByText("overloads.ts", text)

        val faded = OverloadDiffAnalyzer.ranges(file).map { text.substring(it.startOffset, it.endOffset).trim() }

        assertEquals(3, faded.count { it == "export function" })
        assertEquals(3, faded.count { it == "callMethod" })
        assertEquals(3, faded.count { it == "key" })
        assertEquals(3, faded.count { it == "props" })
        assertEquals(3, faded.count { it == "Props" })
        assertFalse(faded.any { it.startsWith("Key") })
        assertFalse(faded.any { it.startsWith("Result") })
    }

    fun testGroupsAcrossCommentsAndCanonicalizesTopLevelUnionOrder() {
        val text = """
            interface Api {
              call(value: A | B, stable: Stable): One;
              /** explanation */
              call(value: B |
                A, stable: Stable): Two;
            }
        """.trimIndent()
        val file = myFixture.configureByText("Api.ts", text)

        val faded = OverloadDiffAnalyzer.ranges(file).map { text.substring(it.startOffset, it.endOffset).trim() }

        assertEquals(2, faded.count { it == "call" })
        assertEquals(2, faded.count { it == "stable" })
        assertEquals(2, faded.count { it == "Stable" })
        assertEquals(2, faded.count { it.replace(Regex("\\s+"), "") in setOf("A|B", "B|A") })
        assertFalse(faded.any { it.contains("explanation") })
    }

    fun testUnrelatedSiblingBreaksGroup() {
        val text = """
            function choose(value: A): A;
            const boundary = true;
            function choose(value: B): B;
        """.trimIndent()
        val file = myFixture.configureByText("separate.ts", text)

        assertEmpty(OverloadDiffAnalyzer.ranges(file))
    }

    fun testClassMethodsAreSupported() {
        val text = "class Store {\n  get(key: Key): Value;\n  get(key: Key | null): Value | null;\n}"
        val file = myFixture.configureByText("Store.ts", text)

        val faded = OverloadDiffAnalyzer.ranges(file).map { text.substring(it.startOffset, it.endOffset).trim() }

        assertEquals(2, faded.count { it == "get" })
        assertEquals(2, faded.count { it == "key" })
        assertFalse(faded.any { it.startsWith("Key") || it.startsWith("Value") })
    }

    fun testGroupVisibilityCanBeToggledWithoutChangingSource() {
        val text = "function find(key: Key): Value;\nfunction find(key: Key | null): Value | null;"
        val file = myFixture.configureByText("toggle.ts", text)
        val group = OverloadDiffAnalyzer.groups(file).single()
        val visibility = project.getService(OverloadDiffVisibility::class.java)

        assertFalse(visibility.isSuppressed(file.virtualFile, group.anchor))
        visibility.toggle(file.virtualFile, group.anchor)
        assertTrue(visibility.isSuppressed(file.virtualFile, group.anchor))
        assertEquals(text, file.text)
        visibility.toggle(file.virtualFile, group.anchor)
        assertFalse(visibility.isSuppressed(file.virtualFile, group.anchor))
    }

    fun testGutterMarkerAppearsOnlyOnFirstOverload() {
        val file = myFixture.configureByText(
            "marker.ts",
            "function find(key: Key): Value;\nfunction find(key: Key | null): Value | null;",
        )
        val functions = PsiTreeUtil.findChildrenOfType(file, JSFunction::class.java).toList()
        val provider = OverloadDiffLineMarkerProvider()

        assertNotNull(provider.getLineMarkerInfo(functions[0]))
        assertNull(provider.getLineMarkerInfo(functions[1]))
    }

    fun testTogglingOneGroupReusesOtherGroupHighlighters() {
        val file = myFixture.configureByText(
            "two-groups.ts",
            """
                function find(key: Key): Value;
                function find(key: Key | null): Value | null;
                function save(value: Value): Result;
                function save(value: Value | null): Result | null;
            """.trimIndent(),
        )
        val groups = OverloadDiffAnalyzer.groups(file)
        assertEquals(2, groups.size)
        val service = project.getService(OverloadFadeHighlighters::class.java)
        val attributes = TextAttributes()
        service.clear(file.virtualFile)
        service.replace(file.virtualFile, groups.flatMap { it.ranges }, attributes)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val markup = DocumentMarkupModel.forDocument(myFixture.editor.document, project, true)
        val before = markup.allHighlighters
            .filter { it.layer == HighlighterLayer.ERROR - 1 }
            .associateBy { it.startOffset to it.endOffset }

        service.replace(file.virtualFile, groups[1].ranges, attributes)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val after = markup.allHighlighters
            .filter { it.layer == HighlighterLayer.ERROR - 1 }
            .associateBy { it.startOffset to it.endOffset }

        assertTrue(groups[0].ranges.none { (it.startOffset to it.endOffset) in after })
        groups[1].ranges.forEach { range ->
            val key = range.startOffset to range.endOffset
            assertSame(before[key], after[key])
        }
    }

    fun testDocumentEditReusesShiftedHighlighters() {
        val file = myFixture.configureByText(
            "edited.ts",
            "function find(key: Key): Value;\nfunction find(key: Key | null): Value | null;",
        )
        val service = project.getService(OverloadFadeHighlighters::class.java)
        val attributes = TextAttributes()
        service.clear(file.virtualFile)
        service.replace(file.virtualFile, OverloadDiffAnalyzer.ranges(file), attributes)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val document = myFixture.editor.document
        val markup = DocumentMarkupModel.forDocument(document, project, true)
        val before = markup.allHighlighters
            .filter { it.layer == HighlighterLayer.ERROR - 1 }
            .sortedBy { it.startOffset }

        WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// shifted\n") }
        PsiDocumentManager.getInstance(project).commitDocument(document)
        service.replace(file.virtualFile, OverloadDiffAnalyzer.ranges(file), attributes)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val after = markup.allHighlighters
            .filter { it.layer == HighlighterLayer.ERROR - 1 }
            .sortedBy { it.startOffset }

        assertEquals(before.size, after.size)
        before.zip(after).forEach { (old, current) -> assertSame(old, current) }
    }

    fun testIdenticalOrBoilerplateOnlyOverloadsAreNotFaded() {
        val identical = myFixture.configureByText("identical.ts", "function same(value: A): A;\nfunction same(value: A): A;")
        assertEmpty(OverloadDiffAnalyzer.ranges(identical))

        val unrelated = myFixture.configureByText("unrelated.ts", "function parse(left: A): One;\nfunction parse(right?: B): Two;")
        assertEmpty(OverloadDiffAnalyzer.ranges(unrelated))
    }
}
