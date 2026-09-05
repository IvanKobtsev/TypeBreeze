package dev.unionbreeze.webstorm

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.Range

class EnumToUnionIntentionTest : BasePlatformTestCase() {
    fun testAvailableOnlyInsideEnumDeclaration() {
        val file = myFixture.configureByText("enum.ts", "enum <caret>E { a, b }\nconst v = E.a;")
        val intention = EnumToUnionIntention()
        assertTrue(intention.isAvailable(project, myFixture.editor, file))
        myFixture.editor.caretModel.moveToOffset(file.text.lastIndexOf("E.a"))
        assertFalse(intention.isAvailable(project, myFixture.editor, file))
    }

    fun testMultiFileConversionAndUndoRedo() {
        val file = myFixture.addFileToProject("enum.ts", "export enum E { a, b }")
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        val usage = myFixture.addFileToProject("usage.ts", "const v = E.a;")
        val document = myFixture.editor.document
        val usageDocument = FileDocumentManager.getInstance().getDocument(usage.virtualFile)!!
        val before = document.text
        val usageBefore = usageDocument.text
        val replacement = "export type E = 'a' | 'b';"
        val snapshots = listOf(
            EnumEditorSnapshot(file.virtualFile, document, document.modificationStamp, before),
            EnumEditorSnapshot(usage.virtualFile, usageDocument, usageDocument.modificationStamp, usageBefore),
        )
        val plan = EnumToUnionPlan(enumName = "E", needsObject = false,
            documents = snapshots.map { EnumDocumentSnapshot(it.file.url, it.text) },
            edits = listOf(
                EnumTextEdit(file.virtualFile.url, Range(Position(0, 0), Position(0, before.length)), before, replacement),
                EnumTextEdit(usage.virtualFile.url, Range(Position(0, 10), Position(0, 13)), "E.a", "'a'"),
            ),
        )
        assertTrue(applyEnumConversionPlan(project, plan, snapshots))
        assertEquals(replacement, document.text)
        assertEquals("const v = 'a';", usageDocument.text)
        val editor = FileEditorManager.getInstance(project).selectedEditor
        val undo = UndoManager.getInstance(project)
        assertTrue(undo.isUndoAvailable(editor))
        undo.undo(editor)
        assertEquals(before, document.text)
        assertEquals(usageBefore, usageDocument.text)
        undo.redo(editor)
        assertEquals(replacement, document.text)
        assertEquals("const v = 'a';", usageDocument.text)
    }

    fun testStaleSnapshotCancelsBeforeAnyFileIsChanged() {
        val file = myFixture.addFileToProject("enum.ts", "enum E { a, b }")
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        val document = myFixture.editor.document
        val snapshot = EnumEditorSnapshot(file.virtualFile, document, document.modificationStamp, document.text)
        val plan = EnumToUnionPlan(documents = listOf(EnumDocumentSnapshot(file.virtualFile.url, document.text)),
            edits = listOf(EnumTextEdit(file.virtualFile.url, Range(Position(0, 0), Position(0, document.textLength)), document.text, "type E = 'a' | 'b';")))
        WriteCommandAction.runWriteCommandAction(project, Runnable { document.insertString(document.textLength, " // edited") })
        val edited = document.text
        assertFalse(applyEnumConversionPlan(project, plan, listOf(snapshot)))
        assertEquals(edited, document.text)
    }

    fun testInvalidSecondEditCancelsWholeTransaction() {
        val file = myFixture.addFileToProject("enum.ts", "enum E { a, b }")
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        val document = myFixture.editor.document
        val before = document.text
        val plan = EnumToUnionPlan(documents = listOf(EnumDocumentSnapshot(file.virtualFile.url, before)), edits = listOf(
            EnumTextEdit(file.virtualFile.url, Range(Position(0, 0), Position(0, 4)), "enum", "type"),
            EnumTextEdit(file.virtualFile.url, Range(Position(0, 5), Position(0, 6)), "WrongName", "X"),
        ))
        assertFalse(applyEnumConversionPlan(project, plan, emptyList()))
        assertEquals(before, document.text)
    }
}
