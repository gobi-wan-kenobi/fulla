// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.sirallap.fulla.core.money

/**
 * A currency and how many decimal places its minor unit has: 2 for EUR and
 * USD, 0 for JPY and KRW, 3 for BHD and KWD.
 */
data class Currency(val code: String, val minorUnits: Int) {
    override fun toString(): String = code

    companion object {
        /** A currency Fulla knows, by ISO 4217 code, or null. */
        fun of(code: String): Currency? =
            Currencies.MINOR_UNITS[code.uppercase()]?.let { Currency(code.uppercase(), it) }

        fun require(code: String): Currency =
            of(code) ?: throw IllegalArgumentException("Unknown currency: $code")

        /**
         * The currency a new household is proposed when it is created: Canadian
         * dollars, whatever the phone's region. It is only the starting value of
         * the field; any other currency Fulla knows can still be typed in.
         */
        const val DEFAULT_FOR_NEW_HOUSEHOLD: String = "CAD"
    }
}

/**
 * ISO 4217 active currencies. Generated from testdata/defaults/currencies.json,
 * the same table the database embeds; a test checks all three agree.
 */
object Currencies {
    val MINOR_UNITS: Map<String, Int> = mapOf(
        "AED" to 2, "AFN" to 2, "ALL" to 2, "AMD" to 2, "AOA" to 2, "ARS" to 2, "AUD" to 2, "AWG" to 2,
        "AZN" to 2, "BAM" to 2, "BBD" to 2, "BDT" to 2, "BGN" to 2, "BHD" to 3, "BIF" to 0, "BMD" to 2,
        "BND" to 2, "BOB" to 2, "BRL" to 2, "BSD" to 2, "BTN" to 2, "BWP" to 2, "BYN" to 2, "BZD" to 2,
        "CAD" to 2, "CDF" to 2, "CHF" to 2, "CLP" to 0, "CNY" to 2, "COP" to 2, "CRC" to 2, "CUP" to 2,
        "CVE" to 2, "CZK" to 2, "DJF" to 0, "DKK" to 2, "DOP" to 2, "DZD" to 2, "EGP" to 2, "ERN" to 2,
        "ETB" to 2, "EUR" to 2, "FJD" to 2, "FKP" to 2, "GBP" to 2, "GEL" to 2, "GHS" to 2, "GIP" to 2,
        "GMD" to 2, "GNF" to 0, "GTQ" to 2, "GYD" to 2, "HKD" to 2, "HNL" to 2, "HTG" to 2, "HUF" to 2,
        "IDR" to 2, "ILS" to 2, "INR" to 2, "IQD" to 3, "IRR" to 2, "ISK" to 0, "JMD" to 2, "JOD" to 3,
        "JPY" to 0, "KES" to 2, "KGS" to 2, "KHR" to 2, "KMF" to 0, "KPW" to 2, "KRW" to 0, "KWD" to 3,
        "KYD" to 2, "KZT" to 2, "LAK" to 2, "LBP" to 2, "LKR" to 2, "LRD" to 2, "LSL" to 2, "LYD" to 3,
        "MAD" to 2, "MDL" to 2, "MGA" to 2, "MKD" to 2, "MMK" to 2, "MNT" to 2, "MOP" to 2, "MRU" to 2,
        "MUR" to 2, "MVR" to 2, "MWK" to 2, "MXN" to 2, "MYR" to 2, "MZN" to 2, "NAD" to 2, "NGN" to 2,
        "NIO" to 2, "NOK" to 2, "NPR" to 2, "NZD" to 2, "OMR" to 3, "PAB" to 2, "PEN" to 2, "PGK" to 2,
        "PHP" to 2, "PKR" to 2, "PLN" to 2, "PYG" to 0, "QAR" to 2, "RON" to 2, "RSD" to 2, "RUB" to 2,
        "RWF" to 0, "SAR" to 2, "SBD" to 2, "SCR" to 2, "SDG" to 2, "SEK" to 2, "SGD" to 2, "SHP" to 2,
        "SLE" to 2, "SOS" to 2, "SRD" to 2, "SSP" to 2, "STN" to 2, "SVC" to 2, "SYP" to 2, "SZL" to 2,
        "THB" to 2, "TJS" to 2, "TMT" to 2, "TND" to 3, "TOP" to 2, "TRY" to 2, "TTD" to 2, "TWD" to 2,
        "TZS" to 2, "UAH" to 2, "UGX" to 0, "USD" to 2, "UYU" to 2, "UZS" to 2, "VED" to 2, "VES" to 2,
        "VND" to 0, "VUV" to 0, "WST" to 2, "XAF" to 0, "XCD" to 2, "XCG" to 2, "XOF" to 0, "XPF" to 0,
        "YER" to 2, "ZAR" to 2, "ZMW" to 2, "ZWG" to 2,
    )
}
