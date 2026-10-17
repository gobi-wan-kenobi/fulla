// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.sirallap.fulla.core

import io.github.sirallap.fulla.core.money.Currency
import io.github.sirallap.fulla.core.money.DecimalStyle
import io.github.sirallap.fulla.core.money.Money
import io.github.sirallap.fulla.core.money.MoneyFormatter
import io.github.sirallap.fulla.core.money.MoneyParser
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MoneyTest {
    private val eur = Currency.require("EUR")
    private val jpy = Currency.require("JPY")
    private val bhd = Currency.require("BHD")
    private fun p(text: String, c: Currency = eur, s: DecimalStyle = DecimalStyle.DOT) = MoneyParser.parse(text, c, s)

    @Test
    fun `a double drifts where minor units do not`() {
        var d = 0.0
        repeat(1000) { d += 0.1 }
        assertTrue(d != 100.0, "binary floating point cannot add 0.1 a thousand times")
        var m = Money.zero(eur)
        repeat(1000) { m += Money(10, eur) }
        assertEquals(10_000L, m.minor)
    }

    @Test
    fun `currencies know their decimals`() {
        assertEquals(2, eur.minorUnits)
        assertEquals(0, jpy.minorUnits)
        assertEquals(3, bhd.minorUnits)
        assertNull(Currency.of("XXX"))
    }

    @Test
    fun `a new household is proposed Canadian dollars`() {
        assertEquals("CAD", Currency.DEFAULT_FOR_NEW_HOUSEHOLD)
        assertEquals(2, Currency.require(Currency.DEFAULT_FOR_NEW_HOUSEHOLD).minorUnits)
    }

    @Test
    fun `different currencies do not mix`() {
        assertFailsWith<IllegalArgumentException> { Money(1, eur) + Money(1, jpy) }
    }

    @Test
    fun `parsing rounds half away from zero on the text`() {
        assertEquals(13L, p("0.125"))
        assertEquals(-13L, p("-0.125"))
        assertEquals(12L, p("0.124"))
        assertEquals(1235L, p("12.345"))
        assertEquals(3L, p("2.5", jpy))
        assertEquals(-3L, p("-2.5", jpy))
        assertEquals(1235L, p("1.2345", bhd))
    }

    @Test
    fun `grouping and decimal styles`() {
        assertEquals(123456L, p("1,234.56"))
        assertEquals(123456L, p("1.234,56", s = DecimalStyle.COMMA))
        assertEquals(123456L, p("1 234,56", s = DecimalStyle.COMMA))
        assertEquals(123456L, p("1'234.56"))
        assertEquals(123400L, p("1.234", s = DecimalStyle.COMMA), "a lone dot in a comma locale groups thousands")
        assertEquals(123L, p("1.234"), "and in a dot locale it is a decimal, rounded")
        assertEquals(1000L, p("10"))
    }

    @Test
    fun `signs, brackets and symbols`() {
        assertEquals(-1234L, p("(12.34)"))
        assertEquals(-1234L, p("12.34-"))
        assertEquals(-1234L, p("−12.34"))
        assertEquals(1234L, p("+12.34"))
        assertEquals(1234L, p("€ 12.34"))
        assertEquals(1234L, p("12.34 EUR"))
    }

    @Test
    fun `text that is not an amount`() {
        listOf("", " ", "abc", "1.2.3", "12..3", "--5").forEach { assertNull(p(it), it) }
    }

    @Test
    fun `formatting follows the locale and the currency`() {
        assertEquals("$1,234.56", MoneyFormatter(Locale.US, Currency.require("USD")).format(123456))
        assertEquals("1.234,56 €", MoneyFormatter(Locale.GERMANY, eur).format(123456))
        val yen = MoneyFormatter(Locale.JAPAN, jpy).format(1235)
        assertTrue(yen.endsWith("1,235") && !yen.contains('.'), yen)
        assertTrue(MoneyFormatter(Locale.US, bhd).formatPlain(1235) == "1.235")
        // java.text cannot group the Indian way (1,23,456.78); the app formats
        // through android.icu, which can. Here only the digits are checked.
        val india = MoneyFormatter(Locale.forLanguageTag("en-IN"), Currency.require("INR")).formatPlain(12345678)
        assertEquals("123456.78", india.replace(",", ""))
    }

    @Test
    fun `negative amounts use a real minus, and signed income a plus`() {
        val f = MoneyFormatter(Locale.US, Currency.require("USD"))
        assertEquals("−$5.00", f.format(-500))
        assertEquals("+$5.00", f.format(500, signed = true))
        assertEquals("$0.00", f.format(0, signed = true))
    }
}
