package dev.unionbreeze.webstorm

import org.eclipse.lsp4j.Range
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

interface UnionBreezeLanguageServer : LanguageServer {
    @JsonRequest("unionBreeze/documentUnions")
    fun documentUnions(params: DocumentUnionsParams): CompletableFuture<DocumentUnionsResponse?>
    @JsonRequest("unionBreeze/resolveLiteral")
    fun resolveLiteral(params: TextDocumentPositionParams): CompletableFuture<ResolvedLiteral?>
}
data class DocumentUnionsParams(val textDocument: TextDocumentIdentifier)
data class DocumentUnionsResponse(val version: Int? = null, val generation: Long = 0, val literals: List<ResolvedLiteral> = emptyList())
data class ResolvedLiteral(val range: Range = Range(), val kind: String = "usage", val currentValue: String = "", val contextualTypeName: String = "", val domain: SourceLocation = SourceLocation(), val declaredMembers: List<UnionMember> = emptyList(), val assignableMembers: List<UnionMember> = emptyList())
data class SourceLocation(val uri: String = "", val range: Range = Range())
data class UnionMember(val value: String = "", val declaration: SourceLocation = SourceLocation(), val deprecated: Boolean = false, val declarationOrder: Int = 0)

