package com.tabtin.mobile.util

import android.content.Context
import android.text.format.DateFormat
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Iso8601DateParser
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

public object RelativeTimeFormatter {
    public fun parse(dateStr: String): Date? {
        return Iso8601DateParser.epochMillis(from = dateStr)?.let { Date(it) }
    }

    @Synchronized
    public fun format(context: Context, dateStr: String): String? {
        val date = parse(dateStr) ?: return null
        val now = Date()
        val seconds = (now.time - date.time) / 1000

        if (seconds < 60) return context.getString(R.string.common_just_now)
        if (seconds < 3600) return context.getString(R.string.common_minutes_ago, (seconds / 60).toInt())
        if (seconds < 86400) return context.getString(R.string.common_hours_ago, (seconds / 3600).toInt())

        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -1)
        val yesterday = cal.time
        val dateCal = Calendar.getInstance().apply { time = date }
        val yesterdayCal = Calendar.getInstance().apply { time = yesterday }
        if (dateCal.get(Calendar.YEAR) == yesterdayCal.get(Calendar.YEAR) &&
            dateCal.get(Calendar.DAY_OF_YEAR) == yesterdayCal.get(Calendar.DAY_OF_YEAR)
        ) return context.getString(R.string.common_yesterday)

        val days = seconds / 86400
        if (days < 30) return context.getString(R.string.common_days_ago, days.toInt())

        val locale = Locale.getDefault()
        val nowCal = Calendar.getInstance()
        return if (dateCal.get(Calendar.YEAR) == nowCal.get(Calendar.YEAR)) {
            val pattern = DateFormat.getBestDateTimePattern(locale, "MMMd")
            SimpleDateFormat(pattern, locale).format(date)
        } else {
            val pattern = DateFormat.getBestDateTimePattern(locale, "yMMMd")
            SimpleDateFormat(pattern, locale).format(date)
        }
    }

    @Synchronized
    public fun formatTime(dateStr: String): String? {
        val date = parse(dateStr) ?: return null
        return SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
    }
}
