package com.tabtin.mobile.data.automation

import android.database.Cursor

/**
 * Safe cursor column accessors that handle [Cursor.getColumnIndex] returning -1
 * on OEM devices where the ContentProvider may omit requested projection columns.
 */

public fun Cursor.safeGetString(columnName: String, default: String = ""): String {
    val idx = getColumnIndex(columnName)
    if (idx < 0) return default
    return getString(idx) ?: default
}

public fun Cursor.safeGetLong(columnName: String, default: Long = 0L): Long {
    val idx = getColumnIndex(columnName)
    if (idx < 0) return default
    return getLong(idx)
}

public fun Cursor.safeGetInt(columnName: String, default: Int = 0): Int {
    val idx = getColumnIndex(columnName)
    if (idx < 0) return default
    return getInt(idx)
}

public fun Cursor.safeGetStringOrNull(columnName: String): String? {
    val idx = getColumnIndex(columnName)
    if (idx < 0) return null
    return getString(idx)
}
