package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import com.tabtin.mobile.data.repository.TabDataDraftScope
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataDraftPolicyTest {
    @Test
    public fun `dirty fields include only editable changes`() {
        val fields = listOf(
            field("标题", "text"),
            field("附件", "attachment"),
        )
        val original = mapOf("标题" to JsonPrimitive("旧"), "附件" to JsonPrimitive("旧文件"))
        val draft = mapOf("标题" to JsonPrimitive("新"), "附件" to JsonPrimitive("新文件"))

        val dirty = TabDataDraftPolicy.dirtyFields(original, draft, fields)

        assertEquals(JsonPrimitive("新"), dirty["标题"])
        assertFalse("附件" in dirty)
    }

    @Test
    public fun `normalization matches native field storage`() {
        assertEquals(JsonPrimitive(12.5), TabDataDraftPolicy.normalize(field("金额", "currency"), "12.5"))
        assertEquals(JsonPrimitive(true), TabDataDraftPolicy.normalize(field("完成", "checkbox"), "true"))
        assertEquals(
            JsonArray(listOf(JsonPrimitive("A"), JsonPrimitive("B"))),
            TabDataDraftPolicy.normalize(field("标签", "multi_select"), "A, B"),
        )
        assertEquals(JsonNull, TabDataDraftPolicy.normalize(field("备注", "text"), "  "))
    }

    @Test
    public fun `numeric validation is explicit`() {
        val fields = listOf(
            field("标题", "text"),
            field("金额", "number"),
        )
        val errors = TabDataDraftPolicy.validate(
            mapOf("标题" to JsonNull, "金额" to JsonPrimitive("not-number")),
            fields,
        )

        assertEquals(TabDataValidationError.InvalidNumber, errors["金额"])
    }

    @Test
    public fun `restored dirty field must keep the same id and type`() {
        val originalField = field("标题", "text")
        val snapshot = TabDataDraftSnapshot(
            scope = TabDataDraftScope("user", "org", "table-1", "record-1"),
            original = JsonObject(mapOf("标题" to JsonPrimitive("旧"))),
            draft = JsonObject(mapOf("标题" to JsonPrimitive("本地"))),
            fieldIdentities = TabDataDraftSchema.identities(listOf(originalField)),
            schemaFingerprint = TabDataDraftSchema.fingerprint(listOf(originalField)),
        )

        assertTrue(
            TabDataDraftPolicy.restore(
                remote = mapOf("新标题" to JsonPrimitive("远端")),
                snapshot = snapshot,
                fields = listOf(originalField.copy(name = "新标题")),
            ).isWriteCompatible,
        )
        assertFalse(
            TabDataDraftPolicy.restore(
                remote = mapOf("标题" to JsonPrimitive(1)),
                snapshot = snapshot,
                fields = listOf(originalField.copy(fieldType = "number")),
            ).isWriteCompatible,
        )
    }

    @Test
    public fun `legacy draft remains visible but cannot be submitted`() {
        val field = field("标题", "text")
        val restored = TabDataDraftPolicy.restore(
            remote = mapOf("标题" to JsonPrimitive("远端")),
            snapshot = TabDataDraftSnapshot(
                scope = TabDataDraftScope("user", "org", "table-1", "record-1"),
                original = JsonObject(mapOf("标题" to JsonPrimitive("旧"))),
                draft = JsonObject(mapOf("标题" to JsonPrimitive("本地"))),
            ),
            fields = listOf(field),
        )

        assertEquals(JsonPrimitive("本地"), restored.draft["标题"])
        assertFalse(restored.isWriteCompatible)
    }

    private fun field(name: String, type: String): TabDataField = TabDataField(
        id = "field-$name",
        tableId = "table-1",
        name = name,
        fieldType = type,
    )
}
