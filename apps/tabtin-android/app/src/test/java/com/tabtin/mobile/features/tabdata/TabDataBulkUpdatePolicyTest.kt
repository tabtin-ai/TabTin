package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldConflict
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import com.tabtin.mobile.data.repository.TabDataDraftScope
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataBulkUpdatePolicyTest {
    @Test
    public fun `payload keys are field ids not names and snapshot only includes dirty fields`() {
        val fields = listOf(field("标题"), field("备注"), field("状态"))
        val original = mapOf(
            "标题" to JsonPrimitive("编辑起点标题"),
            "备注" to JsonPrimitive("编辑起点备注"),
            "状态" to JsonPrimitive("待办"),
        )
        val dirty = JsonObject(
            mapOf(
                "标题" to JsonPrimitive("我改的标题"),
                "状态" to JsonPrimitive("完成"),
            ),
        )

        val payload = TabDataBulkUpdatePolicy.fieldIdPayload(dirty, original, fields)

        assertEquals(setOf("field-标题", "field-状态"), payload.data.keys)
        assertEquals(setOf("field-标题", "field-状态"), payload.baseSnapshot.keys)
        assertFalse("标题" in payload.data)
        assertFalse("标题" in payload.baseSnapshot)
        assertFalse("field-备注" in payload.baseSnapshot)
        assertEquals(JsonPrimitive("我改的标题"), payload.data["field-标题"])
        assertEquals(JsonPrimitive("编辑起点标题"), payload.baseSnapshot["field-标题"])
        assertEquals(JsonPrimitive("待办"), payload.baseSnapshot["field-状态"])
    }

    @Test
    public fun `base snapshot uses edit-start values not the latest remote ones`() {
        val fields = listOf(field("标题"))
        val latestRemote = mapOf("标题" to JsonPrimitive("别人刚改的"))
        val editStart = mapOf("标题" to JsonPrimitive("我打开时的值"))
        val dirty = JsonObject(mapOf("标题" to JsonPrimitive("我改的")))

        val fromLatest = TabDataBulkUpdatePolicy.fieldIdPayload(dirty, latestRemote, fields)
        val fromStart = TabDataBulkUpdatePolicy.fieldIdPayload(dirty, editStart, fields)

        assertEquals(JsonPrimitive("别人刚改的"), fromLatest.baseSnapshot["field-标题"])
        assertEquals(JsonPrimitive("我打开时的值"), fromStart.baseSnapshot["field-标题"])
    }

    @Test
    public fun `edit start prefers draft snapshot original over later remote values`() {
        val title = field("标题")
        val snapshot = TabDataDraftSnapshot(
            scope = TabDataDraftScope("user", "org", "table-1", "record-1"),
            original = JsonObject(mapOf("标题" to JsonPrimitive("编辑起点"))),
            draft = JsonObject(mapOf("标题" to JsonPrimitive("本地"))),
            fieldIdentities = TabDataDraftSchema.identities(listOf(title)),
            schemaFingerprint = TabDataDraftSchema.fingerprint(listOf(title)),
        )

        val values = TabDataBulkUpdatePolicy.editStartValues(
            snapshot = snapshot,
            detailOriginal = mapOf("标题" to JsonPrimitive("打开时的最新远端")),
            fields = listOf(title),
        )

        assertEquals(JsonPrimitive("编辑起点"), values["标题"])
    }

    @Test
    public fun `conflict names resolve field id to display name and overflow`() {
        val fields = listOf(field("状态"), field("标题"), field("备注"))
        val conflicts = listOf(
            TabDataFieldConflict(recordId = "record-1", fieldId = "field-状态"),
            TabDataFieldConflict(recordId = "record-1", fieldId = "field-标题"),
            TabDataFieldConflict(recordId = "record-1", fieldId = "field-备注"),
        )

        val names = TabDataBulkUpdatePolicy.conflictFieldNames(conflicts, fields)

        assertEquals(listOf("状态", "标题"), names.listed)
        assertEquals(3, names.total)
        assertTrue(names.hasOverflow)
    }

    private fun field(name: String): TabDataField = TabDataField(
        id = "field-$name",
        tableId = "table-1",
        name = name,
        fieldType = "text",
    )
}
