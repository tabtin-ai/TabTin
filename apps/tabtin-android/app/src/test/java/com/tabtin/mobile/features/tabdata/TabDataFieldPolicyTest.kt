package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataFieldPolicyTest {
    @Test
    public fun `first slice native editor matrix is explicit`() {
        val editable = setOf(
            "text", "long_text", "number", "currency", "percent", "rating",
            "select", "multi_select", "checkbox", "date",
            "url", "email", "phone", "user",
        )
        editable.forEach { type ->
            assertEquals("$type should be editable", TabDataFieldEditMode.NATIVE, TabDataFieldPolicy.editMode(type))
        }

        val readOnly = setOf(
            "attachment", "link",
            "created_time", "last_modified_time", "created_by", "last_modified_by",
            "future_type",
        )
        readOnly.forEach { type ->
            assertEquals("$type should preserve full-mode editing", TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode(type))
        }

        assertEquals("select", TabDataFieldPolicy.normalizeFieldType(" Single_Select "))
        assertEquals("multi_select", TabDataFieldPolicy.normalizeFieldType("multiple_select"))
        assertEquals("attachment", TabDataFieldPolicy.normalizeFieldType("file"))
        assertEquals("timestamp", TabDataFieldPolicy.normalizeFieldType("timestamp"))
        assertEquals("never_seen_type", TabDataFieldPolicy.normalizeFieldType("never_seen_type"))
        assertEquals(TabDataFieldEditMode.NATIVE, TabDataFieldPolicy.editMode("single_select"))
        assertEquals(TabDataFieldEditMode.NATIVE, TabDataFieldPolicy.editMode(" TEXT "))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("timestamp"))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("file"))
        assertEquals(TabDataFieldEditMode.NATIVE, TabDataFieldPolicy.editMode(" USER "))
        // created_time / last_modified_time 是服务端算的，别名再像日期也不能开放编辑。
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("created_time"))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("last_modified_time"))
        // created_by / last_modified_by 是系统计算字段，即使长得像人员也不能一起放开。
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("created_by"))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("last_modified_by"))
        assertFalse(looksLikeInternalId("REC-001 客户回访"))
        assertTrue(looksLikeInternalId("usr-0001"))
    }
}
