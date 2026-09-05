package dev.unionbreeze.webstorm

import org.eclipse.lsp4j.Range
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

interface UnionBreezeLanguageServer : LanguageServer {
    @JsonRequest("unionBreeze/documentUnions")
    fun documentUnions(params: DocumentUnionsParams): CompletableFuture<DocumentUnionsResponse?>
    @JsonRequest("unionBreeze/resolveLiteral")
    fun resolveLiteral(params: ResolveLiteralParams): CompletableFuture<ResolvedLiteral?>
    @JsonRequest("unionBreeze/navigationTargets")
    fun navigationTargets(params:ResolveLiteralParams):CompletableFuture<List<SourceLocation>>
    @JsonRequest("unionBreeze/renamePlan")
    fun renamePlan(params:RenamePlanParams):CompletableFuture<RenamePlan?>
    @JsonRequest("unionBreeze/enumToUnionPlan")
    fun enumToUnionPlan(params:EnumToUnionParams):CompletableFuture<EnumToUnionPlan?>
}
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
