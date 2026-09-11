package dev.typebreeze.webstorm

import com.intellij.lang.annotation.Annotator
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.javascript.psi.JSFunction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiComment
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiErrorElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiWhiteSpace
import com.intellij.psi.util.CachedValueProvider
import com.intellij.psi.util.CachedValuesManager
import com.intellij.psi.util.PsiTreeUtil

class OverloadDiffAnnotator : Annotator {
    override fun annotate(element: PsiElement, holder: AnnotationHolder) {
        if (element !is PsiFile) return
        val fadedAttributes = EditorColorsManager.getInstance().globalScheme
            .getAttributes(TypeBreezeColors.REPEATED_OVERLOAD) ?: TextAttributes()
        val ranges = if (TypeBreezeSettings.instance.state.fadeRepeatedOverloadSyntax) {
            OverloadDiffAnalyzer.ranges(element)
        } else emptyList()
        element.project.getService(OverloadFadeHighlighters::class.java)
            .replace(element.virtualFile ?: return, ranges, fadedAttributes)
    }
}

@Service(Service.Level.PROJECT)
class OverloadFadeHighlighters(private val project: Project) {
    private data class Applied(val stamp: Long, val ranges: List<TextRange>, val highlighters: List<RangeHighlighter>)
    private val applied = mutableMapOf<Document, Applied>()

    init {
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                ApplicationManager.getApplication().invokeLater { clear(event.document) }
            }
        }, project)
    }

    fun replace(file: VirtualFile, ranges: List<TextRange>, attributes: TextAttributes) {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val stamp = document.modificationStamp
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed || document.modificationStamp != stamp) return@invokeLater
            val previous = applied[document]
            if (previous?.stamp == stamp && previous.ranges == ranges) return@invokeLater
            previous?.highlighters?.forEach(RangeHighlighter::dispose)
            val markup = DocumentMarkupModel.forDocument(document, project, true)
            val highlighters = ranges.map { range ->
                markup.addRangeHighlighter(
                    range.startOffset,
                    range.endOffset,
                    HighlighterLayer.ERROR - 1,
                    attributes,
                    HighlighterTargetArea.EXACT_RANGE,
                )
            }
            applied[document] = Applied(stamp, ranges, highlighters)
        }
    }

    private fun clear(document: Document) {
        applied.remove(document)?.highlighters?.forEach(RangeHighlighter::dispose)
    }
}

internal object OverloadDiffAnalyzer {
    private data class Component(val key: String, val normalized: String, val range: TextRange)
    private data class Signature(val function: JSFunction, val components: Map<String, Component>)

    fun ranges(file: PsiFile): List<TextRange> = CachedValuesManager.getCachedValue(file) {
        CachedValueProvider.Result.create(analyze(file), file)
    }

    private fun analyze(file: PsiFile): List<TextRange> {
        val functions = PsiTreeUtil.findChildrenOfType(file, JSFunction::class.java)
            .filter { it.nameIdentifier != null && it.parent != null }
        val byParent = functions.groupBy { it.parent }
        val ranges = mutableListOf<TextRange>()
        for ((parent, candidates) in byParent) {
            val candidateSet = candidates.toHashSet()
            var group = mutableListOf<JSFunction>()
            fun flush() {
                if (group.size >= 2) ranges += compare(group)
                group = mutableListOf()
            }
            for (element in parent.children) {
                if (element is PsiWhiteSpace || element is PsiComment) continue
                val function = (element as? JSFunction)?.takeIf { it in candidateSet }
                if (function == null) {
                    flush()
                    continue
                }
                if (hasBody(function)) { flush(); continue }
                if (group.isNotEmpty() && group.first().name != function.name) flush()
                group += function
            }
            flush()
        }
        return ranges.distinct().sortedBy { it.startOffset }
    }

    private fun compare(functions: List<JSFunction>): List<TextRange> {
        if (functions.any { PsiTreeUtil.findChildOfType(it, PsiErrorElement::class.java) != null }) return emptyList()
        val signatures = functions.mapNotNull(::signature)
        if (signatures.size != functions.size) return emptyList()
        val shapes = signatures.map { signature -> signature.components.mapValues { it.value.normalized } }
        if (shapes.distinct().size == 1) return emptyList()
        val sharedKeys = signatures.first().components.keys.filter { key ->
            signatures.all { it.components[key]?.normalized == signatures.first().components[key]?.normalized }
        }
        // A shared name alone is not enough useful repetition to fade a group.
        if (sharedKeys.none { it != "name" }) return emptyList()
        return signatures.flatMap { signature -> sharedKeys.mapNotNull { signature.components[it]?.range } }
    }

    private fun signature(function: JSFunction): Signature? {
        val name = function.nameIdentifier ?: return null
        val parameterList = function.parameterList ?: return null
        val components = linkedMapOf<String, Component>()
        components["name"] = component("name", name.textRange, name.text)

        val prefix = TextRange(function.textRange.startOffset, name.textRange.startOffset)
        addIfMeaningful(components, "modifiers", prefix,
            function.containingFile.text.substring(prefix.startOffset, prefix.endOffset))

        val typeParameters = TextRange(name.textRange.endOffset, parameterList.textRange.startOffset)
        addIfMeaningful(components, "typeParameters", typeParameters,
            function.containingFile.text.substring(typeParameters.startOffset, typeParameters.endOffset))

        parameterList.parameters.forEachIndexed { index, parameter -> addParameter(components, index, parameter) }

        val suffixEnd = function.block?.textRange?.startOffset ?: function.textRange.endOffset
        val suffix = TextRange(parameterList.textRange.endOffset, suffixEnd)
        val suffixText = function.containingFile.text.substring(suffix.startOffset, suffix.endOffset)
            .trimEnd().removeSuffix(";").trimEnd()
        val colon = topLevelColon(suffixText)
        if (colon >= 0) {
            val rawStart = suffix.startOffset + suffixText.indexOf(':', colon)
            val typeStart = skipTrivia(function.containingFile.text, rawStart + 1, suffix.startOffset + suffixText.length)
            addIfMeaningful(components, "returnType", TextRange(typeStart, suffix.startOffset + suffixText.length),
                function.containingFile.text.substring(typeStart, suffix.startOffset + suffixText.length))
        }
        return Signature(function, components)
    }

    private fun addParameter(components: MutableMap<String, Component>, index: Int, parameter: PsiElement) {
        val text = parameter.text
        val absolute = parameter.textRange.startOffset
        val colon = topLevelColon(text)
        val beforeType = if (colon >= 0) text.substring(0, colon) else text
        val nameMatch = Regex("[A-Za-z_$][\\w$]*").findAll(beforeType).lastOrNull() ?: return
        val nameRange = TextRange(absolute + nameMatch.range.first, absolute + nameMatch.range.last + 1)
        components["parameter.$index.name"] = component("parameter.$index.name", nameRange, nameMatch.value)
        val prefix = beforeType.substring(0, nameMatch.range.first)
        addIfMeaningful(components, "parameter.$index.flagsBefore", TextRange(absolute, nameRange.startOffset), prefix)
        val suffix = beforeType.substring(nameMatch.range.last + 1)
        addIfMeaningful(components, "parameter.$index.flagsAfter", TextRange(nameRange.endOffset, absolute + beforeType.length), suffix)
        if (colon >= 0) {
            val typeStart = skipTrivia(parameter.containingFile.text, absolute + colon + 1, parameter.textRange.endOffset)
            addIfMeaningful(components, "parameter.$index.type", TextRange(typeStart, parameter.textRange.endOffset),
                parameter.containingFile.text.substring(typeStart, parameter.textRange.endOffset))
        }
    }

    private fun addIfMeaningful(target: MutableMap<String, Component>, key: String, range: TextRange, text: String) {
        if (normalize(text).isNotEmpty() && !range.isEmpty) target[key] = component(key, range, text)
    }

    private fun component(key: String, range: TextRange, text: String) = Component(key, normalize(text), trimRange(range, text))

    private fun trimRange(range: TextRange, text: String): TextRange {
        val leading = text.indexOfFirst { !it.isWhitespace() }.let { if (it < 0) 0 else it }
        val trailing = text.indexOfLast { !it.isWhitespace() }.let { if (it < 0) text.length else it + 1 }
        return TextRange(range.startOffset + leading, range.startOffset + trailing)
    }

    private fun normalize(value: String): String {
        val compact = compactSyntax(value)
        val union = splitTopLevel(compact, '|')
        if (union.size > 1) return union.sorted().joinToString("|")
        val intersection = splitTopLevel(compact, '&')
        return if (intersection.size > 1) intersection.sorted().joinToString("&") else compact
    }

    private fun compactSyntax(value: String): String {
        val result = StringBuilder(value.length)
        var index = 0
        var quote: Char? = null
        var escaped = false
        while (index < value.length) {
            val char = value[index]
            if (quote != null) {
                result.append(char)
                if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == quote) quote = null
                index++
                continue
            }
            if (char == '\'' || char == '"' || char == '`') {
                quote = char
                result.append(char)
                index++
                continue
            }
            if (char == '/' && index + 1 < value.length && value[index + 1] == '/') {
                index += 2
                while (index < value.length && value[index] != '\n' && value[index] != '\r') index++
                continue
            }
            if (char == '/' && index + 1 < value.length && value[index + 1] == '*') {
                index += 2
                while (index + 1 < value.length && !(value[index] == '*' && value[index + 1] == '/')) index++
                index = (index + 2).coerceAtMost(value.length)
                continue
            }
            if (!char.isWhitespace()) result.append(char)
            index++
        }
        return result.toString()
    }

    private fun splitTopLevel(text: String, separator: Char): List<String> {
        var angle = 0; var round = 0; var square = 0; var curly = 0
        var quote: Char? = null; var escaped = false; var start = 0
        val parts = mutableListOf<String>()
        text.forEachIndexed { index, char ->
            if (quote != null) {
                if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == quote) quote = null
            } else when (char) {
                '\'', '"', '`' -> quote = char
                '<' -> angle++
                '>' -> if (angle > 0) angle--
                '(' -> round++
                ')' -> if (round > 0) round--
                '[' -> square++
                ']' -> if (square > 0) square--
                '{' -> curly++
                '}' -> if (curly > 0) curly--
                separator -> if (angle + round + square + curly == 0) { parts += text.substring(start, index); start = index + 1 }
            }
        }
        if (parts.isEmpty()) return listOf(text)
        parts += text.substring(start)
        return parts
    }

    private fun topLevelColon(text: String): Int {
        var angle = 0; var round = 0; var square = 0; var curly = 0
        text.forEachIndexed { index, char -> when (char) {
            '<' -> angle++; '>' -> if (angle > 0) angle--; '(' -> round++; ')' -> if (round > 0) round--
            '[' -> square++; ']' -> if (square > 0) square--; '{' -> curly++; '}' -> if (curly > 0) curly--
            ':' -> if (angle + round + square + curly == 0) return index
        } }
        return -1
    }

    private fun skipTrivia(text: String, start: Int, end: Int): Int {
        var offset = start
        while (offset < end && text[offset].isWhitespace()) offset++
        return offset
    }

    private fun hasBody(function: JSFunction): Boolean = function.block != null
}
