package dev.unionbreeze.webstorm

import com.intellij.lang.javascript.psi.ExpectedTypeEvaluator
import com.intellij.lang.javascript.psi.JSExpectedTypeKind
import com.intellij.lang.javascript.psi.JSLiteralExpression
import com.intellij.lang.javascript.psi.JSType
import com.intellij.lang.javascript.psi.ecma6.TypeScriptTypeAlias
import com.intellij.lang.javascript.psi.types.JSPrimitiveLiteralType
import com.intellij.lang.javascript.psi.types.JSUnionOrIntersectionType
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.SmartPointerManager

@Service(Service.Level.PROJECT)
class PublicApiUnionResolver(private val project: Project) : UnionResolver {
    override suspend fun resolveLiteral(
        literal: JSLiteralExpression,
        mode: ResolutionMode,
    ): ResolvedLiteralUnion? = resolveLiteralNow(literal, mode)

    override fun resolveLiteralNow(
        literal: JSLiteralExpression,
        mode: ResolutionMode,
    ): ResolvedLiteralUnion? {
        if (!literal.isValid || !literal.isStringLiteral) return null
        val currentValue = literal.value as? String ?: return null
        val expectedType = ExpectedTypeEvaluator(literal, JSExpectedTypeKind.EXPECTED).findExpectedType() ?: return null
        val normalizedType = expectedType.substitute()
        val members = extractClosedStringUnion(normalizedType)
            ?: extractClosedStringUnion(expectedType)
            ?: return null
        if (members.size !in 2..MAX_MEMBERS || members.none { it.value == currentValue }) return null

        val pointerManager = SmartPointerManager.getInstance(project)
        val originElement = expectedType.sourceElement ?: normalizedType.sourceElement
        val alias = generateSequence(originElement) { it.parent }
            .filterIsInstance<TypeScriptTypeAlias>()
            .firstOrNull()
        val origin = alias ?: originElement
        val originPointer = origin?.takeIf(PsiElement::isValid)?.let(pointerManager::createSmartPsiElementPointer)
        val domainId = origin?.containingFile?.virtualFile?.url?.let { url ->
            DomainId(url, origin.textOffset)
        }
        val contextualName = alias?.name ?: expectedType.typeText.takeIf { it.length <= 80 }
        val currentMember = members.first { it.value == currentValue }

        return ResolvedLiteralUnion(
            domainId = domainId,
            contextualTypeName = contextualName,
            currentMember = currentMember,
            declaredMembers = members,
            assignableMembers = members,
            origin = originPointer,
            confidence = ResolutionConfidence.HIGH,
        )
    }

    private fun extractClosedStringUnion(type: JSType): List<UnionMember>? {
        val union = type as? JSUnionOrIntersectionType ?: return null
        if (!union.isUnionType) return null
        val pointerManager = SmartPointerManager.getInstance(project)
        val members = LinkedHashMap<String, UnionMember>()

        fun visit(candidate: JSType): Boolean {
            if (candidate is JSUnionOrIntersectionType) {
                if (!candidate.isUnionType) return false
                return candidate.types.all(::visit)
            }
            val literal = candidate as? JSPrimitiveLiteralType<*> ?: return false
            val value = literal.literal as? String ?: return false
            val declaration = candidate.sourceElement
                ?.takeIf(PsiElement::isValid)
                ?.let(pointerManager::createSmartPsiElementPointer)
            members.putIfAbsent(
                value,
                UnionMember(value, value, declaration),
            )
            return true
        }

        if (!union.types.all(::visit)) return null
        return members.values.toList()
    }

    companion object {
        const val MAX_MEMBERS = 100
    }
}
