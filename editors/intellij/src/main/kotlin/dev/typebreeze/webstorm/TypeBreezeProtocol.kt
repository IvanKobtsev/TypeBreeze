package dev.typebreeze.webstorm

import org.eclipse.lsp4j.Range
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

interface TypeBreezeLanguageServer : LanguageServer {
    @JsonRequest("typeBreeze/extensionCompletions")
    fun extensionCompletions(params: ExtensionCompletionParams): CompletableFuture<ExtensionCompletions?>
    @JsonRequest("typeBreeze/documentExtensions")
    fun documentExtensions(params: DocumentUnionsParams): CompletableFuture<DocumentExtensionsResponse?>
    @JsonRequest("typeBreeze/documentUnions")
    fun documentUnions(params: DocumentUnionsParams): CompletableFuture<DocumentUnionsResponse?>
    @JsonRequest("typeBreeze/resolveLiteral")
    fun resolveLiteral(params: ResolveLiteralParams): CompletableFuture<ResolvedLiteral?>
    @JsonRequest("typeBreeze/navigationTargets")
    fun navigationTargets(params:ResolveLiteralParams):CompletableFuture<List<SourceLocation>>
    @JsonRequest("typeBreeze/renamePlan")
    fun renamePlan(params:RenamePlanParams):CompletableFuture<RenamePlan?>
    @JsonRequest("typeBreeze/enumToUnionPlan")
    fun enumToUnionPlan(params:EnumToUnionParams):CompletableFuture<EnumToUnionPlan?>
    @JsonRequest("typeBreeze/mappingTypeAt")
    fun mappingTypeAt(params:MappingTypeParams):CompletableFuture<MappingTypeInfo?>
    @JsonRequest("typeBreeze/mappingGeneration")
    fun mappingGeneration(params:Map<String,String> = emptyMap()):CompletableFuture<MappingGenerationPlan?>
}

data class ExtensionCompletionParams(val textDocument: TextDocumentIdentifier, val position: org.eclipse.lsp4j.Position,
    val text: String, val clientVersion: Long, val documents: List<DocumentUnionsParams>)
data class ExtensionCompletions(val snapshot: String = "", val expectedText: String = "",
    val documents: List<EnumDocumentSnapshot> = emptyList(),
    val candidates: List<ExtensionCandidate> = emptyList())
data class ExtensionCandidate(val id: String = "", val name: String = "", val sourceModule: String = "",
    val signature: String = "", val remainingParameters: String = "", val returnType: String = "",
    val plan: ExtensionCallPlan? = null)
data class ExtensionOffsetEdit(val start: Int = 0, val end: Int = 0, val expectedText: String = "", val newText: String = "")
data class ExtensionCallPlan(val snapshot: String = "", val expectedText: String = "",
    val edits: List<ExtensionOffsetEdit> = emptyList(), val caretOffset: Int = 0, val parameterInfo: Boolean = false)
data class DocumentUnionsParams(val textDocument: TextDocumentIdentifier, val text:String, val clientVersion:Long, val includeUsages:Boolean=true)
data class DocumentExtensionsResponse(val clientVersion:Long?=null,val generation:Long=0,val occurrences:List<ExtensionOccurrence> = emptyList())
data class ExtensionOccurrence(val range:Range=Range(),val kind:String="call")
data class ResolveLiteralParams(val textDocument:TextDocumentIdentifier,val position:org.eclipse.lsp4j.Position,val text:String,val clientVersion:Long)
data class RenamePlanParams(val textDocument:TextDocumentIdentifier,val position:org.eclipse.lsp4j.Position,val text:String,val clientVersion:Long,val newValue:String)
data class DocumentUnionsResponse(val version: Int? = null, val clientVersion:Long?=null, val generation: Long = 0, val literals: List<ResolvedLiteral> = emptyList())
data class ResolvedLiteral(val range: Range = Range(), val kind: String = "usage", val currentValue: String = "", val contextualTypeName: String = "", val domain: SourceLocation = SourceLocation(), val declaredMembers: List<UnionMember> = emptyList(), val assignableMembers: List<UnionMember> = emptyList(),val hasUsages:Boolean?=null,val usageLocations:List<SourceLocation> = emptyList())
data class SourceLocation(val uri: String = "", val range: Range = Range())
data class UnionMember(val value: String = "", val declaration: SourceLocation = SourceLocation(), val deprecated: Boolean = false, val declarationOrder: Int = 0)
data class RenameTarget(val uri:String="",val range:Range=Range(),val expectedText:String="")
data class RenamePlan(val oldValue:String="",val contextualTypeName:String="",val targets:List<RenameTarget> = emptyList())

data class EnumToUnionParams(val textDocument:TextDocumentIdentifier,val position:org.eclipse.lsp4j.Position,val text:String,val clientVersion:Long,val documents:List<DocumentUnionsParams>)
data class EnumDocumentSnapshot(val uri:String="",val expectedText:String="")
data class EnumTextEdit(val uri:String="",val range:Range=Range(),val expectedText:String="",val newText:String="")
data class EnumToUnionPlan(val enumName:String?=null,val needsObject:Boolean?=null,val reason:String?=null,val location:SourceLocation?=null,val documents:List<EnumDocumentSnapshot> = emptyList(),val edits:List<EnumTextEdit> = emptyList())
data class MappingTypeParams(val textDocument:TextDocumentIdentifier,val position:org.eclipse.lsp4j.Position,val text:String,val clientVersion:Long,val keyTypeParameter:String)
data class MappingTypeInfo(val valid:Boolean=false,val reason:String?=null,val typeName:String="",val path:String="")
data class GeneratedMappingFile(val path:String="",val content:String="")
data class MappingDiagnostic(val path:String="",val message:String="")
data class MappingGenerationPlan(val files:List<GeneratedMappingFile> = emptyList(),val diagnostics:List<MappingDiagnostic> = emptyList())
