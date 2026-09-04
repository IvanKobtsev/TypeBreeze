package dev.unionbreeze.webstorm

import kotlin.test.Test
import kotlin.test.assertEquals

class UnionMemberSwitcherTest {
    @Test
    fun preservesSingleQuoteByEscapingContent() {
        assertEquals("can\\'t\\\\stop\\n", UnionMemberSwitcher.escape("can't\\stop\n", '\''))
    }

    @Test
    fun preservesDoubleQuoteByEscapingContent() {
        assertEquals("say \\\"hello\\\"", UnionMemberSwitcher.escape("say \"hello\"", '"'))
    }
}
