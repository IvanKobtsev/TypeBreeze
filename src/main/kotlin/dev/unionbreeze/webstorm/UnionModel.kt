package dev.unionbreeze.webstorm

import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.psi.PsiElement
import com.intellij.psi.SmartPsiElementPointer

interface UnionResolver {
    suspend fun resolveLiteral(
        literal: JSLiteralExpression,
        mode: ResolutionMode,
    ): ResolvedLiteralUnion?

    /** Synchronous entry point for IntelliJ intention availability checks. */
    fun resolveLiteralNow(
        literal: JSLiteralExpression,
        mode: ResolutionMode,
    ): ResolvedLiteralUnion?
}

enum class ResolutionMode {
    DECLARED_DOMAIN,
    ASSIGNABLE_HERE,
}

enum class ResolutionConfidence {
    HIGH,
    LOW,
}

data class DomainId(
    val declarationFileUrl: String,
    val declarationOffset: Int,
)

data class UnionMember(
    val value: String,
    val replacementText: String,
    val declaration: SmartPsiElementPointer<PsiElement>?,
    val deprecated: Boolean = false,
)

data class ResolvedLiteralUnion(
    val domainId: DomainId?,
    val contextualTypeName: String?,
    val currentMember: UnionMember,
    val declaredMembers: List<UnionMember>,
    val assignableMembers: List<UnionMember>,
    val origin: SmartPsiElementPointer<PsiElement>?,
    val confidence: ResolutionConfidence,
)
