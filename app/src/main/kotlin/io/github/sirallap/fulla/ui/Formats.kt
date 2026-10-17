// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.sirallap.fulla.ui

import io.github.sirallap.fulla.core.model.Config
import io.github.sirallap.fulla.core.money.Currency
import io.github.sirallap.fulla.core.money.DecimalStyle
import io.github.sirallap.fulla.core.money.MoneyFormatter
import io.github.sirallap.fulla.core.rules.PeriodRule
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/**
 * How one household's numbers and dates are written: its currency, in the
 * phone's language. Built once per config and handed down.
 */
class Formats(
    val config: Config,
    val locale: Locale = Locale.getDefault(),
    val periodRule: PeriodRule = PeriodRule(config.household.periodStartDay, config.household.incomeShiftDay),
) {
    val currency: Currency = Currency.of(config.household.currency) ?: Currency("XXX", 2)
    private val money = MoneyFormatter(locale, currency)
    val decimalStyle: DecimalStyle = DecimalStyle.of(locale)
    private val dayFormat = DateTimeFormatter.ofPattern("EEE d MMM", locale)
    private val longDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale)

    fun money(minor: Long, signed: Boolean = false): String = money.format(minor, signed)

    /** An amount rounded to whole units, for a label with little room ("3.469 €"). */
    fun whole(minor: Long): String {
        val format = java.text.NumberFormat.getCurrencyInstance(locale)
        runCatching { format.currency = java.util.Currency.getInstance(currency.code) }
        format.maximumFractionDigits = 0
        format.minimumFractionDigits = 0
        val divisor = (0 until currency.minorUnits).fold(1.0) { acc, _ -> acc * 10 }
        return format.format(kotlin.math.round(minor / divisor))
    }

    /** A period's short name, for a label with little room ("Sept"). */
    fun shortPeriod(p: YearMonth): String =
        p.month.getDisplayName(TextStyle.SHORT_STANDALONE, locale).replaceFirstChar { it.titlecase(locale) }.trimEnd('.')
    fun plain(minor: Long): String = money.formatPlain(minor)

    fun period(p: YearMonth): String {
        val month = p.month.getDisplayName(TextStyle.FULL_STANDALONE, locale).replaceFirstChar { it.titlecase(locale) }
        return if (p.year == YearMonth.now().year) month else "$month ${p.year}"
    }

    /**
     * The period's dates, when it does not start on the 1st. The one still
     * waiting for its salary has no end yet: [openFrom] writes it, given its
     * first day (a string resource, "from %1$s · open").
     */
    fun periodRange(p: YearMonth, openFrom: (String) -> String = { it }): String? {
        if (config.household.periodStartDay == 1 && !periodRule.anchored) return null
        val days = periodRule.daysOf(p)
        if (periodRule.isOpen(p)) return openFrom(dayFormat.format(days.start))
        return "${dayFormat.format(days.start)} – ${dayFormat.format(days.endInclusive)}"
    }

    fun day(d: LocalDate): String = dayFormat.format(d).replaceFirstChar { it.titlecase(locale) }
    fun longDay(d: LocalDate): String = longDate.format(d)

    fun currentPeriod(today: LocalDate = LocalDate.now()): YearMonth = periodRule.daysOfContaining(today)

    companion object {
        /**
         * The currency a new household is proposed: Canadian dollars
         * ([io.github.sirallap.fulla.core.money.Currency.DEFAULT_FOR_NEW_HOUSEHOLD]),
         * not the phone's region. The field stays editable.
         */
        fun proposedCurrency(): String = io.github.sirallap.fulla.core.money.Currency.DEFAULT_FOR_NEW_HOUSEHOLD
    }
}

/** The period whose days contain [date], for ordinary (non-shifted) rows. */
private fun PeriodRule.daysOfContaining(date: LocalDate): YearMonth =
    periodOf(date, io.github.sirallap.fulla.core.model.TransactionKind.EXPENSE, io.github.sirallap.fulla.core.model.Recurrence.VARIABLE)
