package dev.typebreeze.webstorm

import org.eclipse.lsp4j.Range
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

interface TypeBreezeLanguageServer : LanguageServer {
    @JsonRequest("typeBreeze/extensionCompletions")
    fun extensionCompletions(params: ExtensionCompletionParams): CompletableFuture<ExtensionCompletions?>
    @JsonRequest("typeBreeze/extensionCallPlan")
    fun extensionCallPlan(params: ExtensionCompletionParams): CompletableFuture<ExtensionCallPlan?>
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
}

data class ExtensionCompletionParams(val textDocument: TextDocumentIdentifier, val position: org.eclipse.lsp4j.Position,
    val text: String, val clientVersion: Long, val documents: List<DocumentUnionsParams>,
    val candidateId: String? = null, val snapshot: String? = null)
data class ExtensionCompletions(val snapshot: String = "", val documents: List<EnumDocumentSnapshot> = emptyList(),
    val candidates: List<ExtensionCandidate> = emptyList())
data class ExtensionCandidate(val id: String = "", val name: String = "", val sourceModule: String = "",
    val signature: String = "", val remainingParameters: String = "", val returnType: String = "",
    val plan: ExtensionCallPlan = ExtensionCallPlan())
data class ExtensionOffsetEdit(val start: Int = 0, val end: Int = 0, val expectedText: String = "", val newText: String = "")
data class ExtensionCallPlan(val snapshot: String = "", val expectedText: String = "",
    val edits: List<ExtensionOffsetEdit> = emptyList(), val caretOffset: Int = 0, val parameterInfo: Boolean = false)
data class DocumentUnionsParams(val textDocument: TextDocumentIdentifier, val text:String, val clientVersion:Long, val includeUsages:Boolean=true)
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
