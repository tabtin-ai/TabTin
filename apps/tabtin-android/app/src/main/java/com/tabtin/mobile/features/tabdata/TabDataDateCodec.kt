package com.tabtin.mobile.features.tabdata

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.FormatStyle

/**
 * 多维表日期字段的线格式与显示格式。与 iOS `NativeTabDataDateCodec` 对齐。
 */
public object TabDataDateCodec {
    private val WIRE_DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    public fun encodeDate(value: LocalDate): String = value.format(WIRE_DATE)

    public fun decodeDate(raw: String?): LocalDate? {
        val text = raw?.trim().orEmpty()
        if (text.length < 10) return null
        return try {
            LocalDate.parse(text.take(10), WIRE_DATE)
        } catch (_: DateTimeParseException) {
            null
        }
    }

    public fun displayDate(value: LocalDate): String =
        value.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))

}
