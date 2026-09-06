package dev.typebreeze.webstorm

import com.intellij.codeInsight.completion.CompletionContributor
import com.intellij.codeInsight.completion.CompletionContributorEP
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.completion.CompletionResultSet
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Exercises the actual lookup/insert pipeline with deterministic compiler plans. */
class FixtureExtensionContributor : CompletionContributor() {
    override fun fillCompletionVariants(parameters: CompletionParameters, result: CompletionResultSet) {
        if (parameters.originalFile.name != "completion.ts") return
        addExtensionCompletions(parameters, result, response, parameters.offset)
    }

    companion object {
        var response = ExtensionCompletions()
    }
}

class ExtensionCompletionTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        val descriptor = PluginManagerCore.getPlugin(PluginId.getId("dev.typebreeze"))!!
        CompletionContributor.EP.point.registerExtension(
            CompletionContributorEP("TypeScript", FixtureExtensionContributor::class.java.name, descriptor), testRootDisposable)
    }

    override fun tearDown() {
        try { FixtureExtensionContributor.response = ExtensionCompletions() } finally { super.tearDown() }
    }

    private fun prepare(marked: String, required: Boolean = false) {
        myFixture.configureByText("completion.ts", marked)
        val before = myFixture.editor.document.text
        val receiverStart = before.lastIndexOf("title.")
        val end = receiverStart + "title.".length + before.substring(receiverStart + "title.".length).takeWhile { it.isLetter() }.length
        val importText = "import { truncate } from './strings.ext';\n"
        val replacement = if (required) "truncate(title, )" else "truncate(title)"
        val plan = ExtensionCallPlan(snapshot = "test", expectedText = before,
            edits = listOf(ExtensionOffsetEdit(receiverStart, end, before.substring(receiverStart, end), replacement),
                ExtensionOffsetEdit(0, 0, "", importText)),
            caretOffset = importText.length + receiverStart + replacement.length - if (required) 1 else 0,
            parameterInfo = required)
        FixtureExtensionContributor.response = ExtensionCompletions(snapshot = "test", candidates = listOf(
            ExtensionCandidate(id = "truncate", name = "truncate", sourceModule = "strings.ext.ts", returnType = "string", plan = plan)))
    }

    fun testDotCompletionCoexistsWithNativeMembersAndInsertsImport() {
        prepare("const title = 'hello'; title.<caret>")
        val items = myFixture.completeBasic()!!
        assertTrue(items.any { it.lookupString == "truncate" })
        assertTrue(items.any { it.lookupString == "toUpperCase" })
        myFixture.lookup.currentItem = items.first { it.lookupString == "truncate" }
        myFixture.finishLookup('\n')
        myFixture.checkResult("import { truncate } from './strings.ext';\nconst title = 'hello'; truncate(title)<caret>")
    }

    fun testPrefixCompletionAndRequiredArgumentCaret() {
        prepare("const title = 'hello'; title.tru<caret>", required = true)
        val items = myFixture.completeBasic()!!
        myFixture.lookup.currentItem = items.first { it.lookupString == "truncate" }
        myFixture.finishLookup('\n')
        myFixture.checkResult("import { truncate } from './strings.ext';\nconst title = 'hello'; truncate(title, <caret>)")
    }

    fun testTabReplacesIdentifierSuffix() {
        prepare("const title = 'hello'; title.tru<caret>nc")
        val items = myFixture.completeBasic()!!
        myFixture.lookup.currentItem = items.first { it.lookupString == "truncate" }
        myFixture.finishLookup('\t')
        myFixture.checkResult("import { truncate } from './strings.ext';\nconst title = 'hello'; truncate(title)<caret>")
    }

    fun testCallAndImportUndoTogether() {
        prepare("const title = 'hello'; title.<caret>")
        val before = myFixture.editor.document.text
        val items = myFixture.completeBasic()!!
        myFixture.lookup.currentItem = items.first { it.lookupString == "truncate" }
        myFixture.finishLookup('\n')
        val undo = UndoManager.getInstance(project)
        val editor = FileEditorManager.getInstance(project).selectedEditor
        assertTrue(undo.isUndoAvailable(editor))
        undo.undo(editor)
        assertEquals(before, myFixture.editor.document.text)
        undo.redo(editor)
        assertTrue(myFixture.editor.document.text.contains("truncate(title)"))
    }

    fun testStaleAndOverlappingPlansDoNotEditAnything() {
        prepare("const title = 'hello'; title.<caret>")
        val document = myFixture.editor.document
        val plan = FixtureExtensionContributor.response.candidates.single().plan
        assertFalse(applyExtensionPlan(project, myFixture.editor, plan.copy(edits = plan.edits + plan.edits.first())))
        WriteCommandAction.runWriteCommandAction(project, Runnable { document.insertString(0, "// changed\n") })
        val changed = document.text
        assertFalse(applyExtensionPlan(project, myFixture.editor, plan))
        assertEquals(changed, document.text)
    }

    fun testDotTriggerExcludesOptionalAccess() {
        assertTrue(extensionDotContext("title.", 6))
        assertTrue(extensionDotContext("title.tr", 8))
        assertFalse(extensionDotContext("title?.", 7))
        assertFalse(extensionDotContext("title", 5))
    }

    fun testContributorRegisteredForTsx() {
        val file = myFixture.configureByText("view.tsx", "const title = 'hello'; const view = <div>{title.<caret>}</div>;")
        assertTrue(CompletionContributor.forLanguage(file.language).any { it is ExtensionCompletionContributor })
    }

    fun testStaleDependencyRejectsSelectionBeforeLookupInsertion() {
        prepare("const title = 'hello'; title.<caret>")
        val dependency = myFixture.addFileToProject("strings.ext.ts", "export const truncate = (value: string) => value;")
        FixtureExtensionContributor.response = FixtureExtensionContributor.response.copy(
            documents = listOf(EnumDocumentSnapshot(dependency.virtualFile.url, "outdated dependency")))
        val before = myFixture.editor.document.text
        val items = myFixture.completeBasic()!!
        myFixture.lookup.currentItem = items.first { it.lookupString == "truncate" }
        myFixture.finishLookup('\n')
        assertEquals(before, myFixture.editor.document.text)
    }
}
