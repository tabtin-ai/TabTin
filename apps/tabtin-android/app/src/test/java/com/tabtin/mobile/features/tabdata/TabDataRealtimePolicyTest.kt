package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataRealtimePolicyTest {
    private val title = field("fld-title", "标题", "text")
    private val status = field("fld-status", "状态", "select")
    private val fields = listOf(title, status)

    @Test
    public fun `inline records with latest version merge by id without rebuilding others`() {
        val current = listOf(record("record-1", "旧一"), record("record-2", "旧二"), record("record-3", "旧三"))
        val incoming = listOf(record("record-2", "远端二", version = 4))
        val delta = delta(
            action = "update_record",
            recordIds = listOf("record-2"),
            records = incoming,
            latestVersion = 4_000_000_000_008,
        )

        val decision = TabDataRealtimePolicy.decide(
            delta = delta,
            localUserId = "user-1",
            pendingRecordIds = emptySet(),
            editingRecordId = null,
            isDetailDirty = false,
        )

        assertEquals(TabDataRealtimeDecision.Merge(incoming, emptySet(), 4_000_000_000_008), decision)
        val merged = TabDataRealtimePolicy.mergeRecords(current, incoming, emptySet())
        assertEquals(listOf("record-1", "record-2", "record-3"), merged.map(TabDataRecord::id))
        assertEquals("远端二", titleOf(merged[1]))
        assertEquals("旧一", titleOf(merged[0]))
        assertEquals("旧三", titleOf(merged[2]))
    }

    @Test
    public fun `delta without records falls back to refresh`() {
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(action = "update_record", recordIds = listOf("record-2")),
            localUserId = "user-1",
            pendingRecordIds = emptySet(),
            editingRecordId = null,
            isDetailDirty = false,
        )
        assertEquals(TabDataRealtimeDecision.Refresh, decision)
    }

    @Test
    public fun `draft dirty fields survive remote merge`() {
        val remote = record("record-1", "远端标题", statusValue = "done", version = 9)
        val merge = TabDataRealtimePolicy.mergeOpenDetail(
            remote = remote,
            fields = fields,
            detailDraft = mapOf(
                "标题" to JsonPrimitive("我正在输入"),
                "状态" to JsonPrimitive("todo"),
            ),
            detailOriginal = mapOf(
                "标题" to JsonPrimitive("打开时的标题"),
                "状态" to JsonPrimitive("todo"),
            ),
        )

        assertEquals(JsonPrimitive("我正在输入"), merge.draft["标题"])
        assertEquals(JsonPrimitive("done"), merge.draft["状态"])
        assertEquals(JsonPrimitive("远端标题"), merge.original["标题"])
        assertEquals(JsonPrimitive("done"), merge.original["状态"])
        assertEquals(listOf("标题"), merge.protectedFieldNames)
        assertEquals(9L, merge.record.version)
    }

    @Test
    public fun `reverted field is not dirty so remote value applies`() {
        val remote = record("record-1", "远端标题", statusValue = "done", version = 9)
        val opened = mapOf(
            "标题" to JsonPrimitive("打开时的标题"),
            "状态" to JsonPrimitive("todo"),
        )
        val merge = TabDataRealtimePolicy.mergeOpenDetail(
            remote = remote,
            fields = fields,
            detailDraft = opened,
            detailOriginal = opened,
        )

        assertEquals(JsonPrimitive("远端标题"), merge.draft["标题"])
        assertEquals(JsonPrimitive("done"), merge.draft["状态"])
        assertTrue(merge.protectedFieldNames.isEmpty())
    }

    @Test
    public fun `rls affected always refreshes even when records are present`() {
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(
                action = "update_record",
                recordIds = emptyList(),
                records = listOf(record("record-1", "不该用")),
                latestVersion = 8,
                rlsAffected = true,
            ),
            localUserId = "user-1",
            pendingRecordIds = emptySet(),
            editingRecordId = "record-1",
            isDetailDirty = true,
        )
        assertEquals(TabDataRealtimeDecision.Refresh, decision)
    }

    @Test
    public fun `self echo of a pending save is ignored`() {
        val incoming = listOf(record("record-1", "刚保存的回声"))
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(
                action = "update_record",
                recordIds = listOf("record-1"),
                records = incoming,
                latestVersion = 6,
                actorUserId = "user-1",
            ),
            localUserId = "user-1",
            pendingRecordIds = setOf("record-1"),
            editingRecordId = "record-1",
            isDetailDirty = false,
        )
        assertEquals(TabDataRealtimeDecision.Ignore, decision)
    }

    @Test
    public fun `same user on another device is not treated as self echo`() {
        val incoming = listOf(record("record-1", "桌面改的"))
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(
                action = "update_record",
                recordIds = listOf("record-1"),
                records = incoming,
                latestVersion = 6,
                actorUserId = "user-1",
            ),
            localUserId = "user-1",
            pendingRecordIds = emptySet(),
            editingRecordId = null,
            isDetailDirty = false,
        )
        assertEquals(TabDataRealtimeDecision.Merge(incoming, emptySet(), 6), decision)
    }

    @Test
    public fun `deleting the record being edited keeps the draft`() {
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(action = "delete_record", recordIds = listOf("record-1")),
            localUserId = "user-2",
            pendingRecordIds = emptySet(),
            editingRecordId = "record-1",
            isDetailDirty = true,
        )
        assertEquals(TabDataRealtimeDecision.DeletedWhileEditing("record-1"), decision)
    }

    @Test
    public fun `delete without a dirty draft removes the record in place`() {
        val current = listOf(record("record-1", "一"), record("record-2", "二"))
        val decision = TabDataRealtimePolicy.decide(
            delta = delta(action = "batch_delete_records", recordIds = listOf("record-1")),
            localUserId = "user-1",
            pendingRecordIds = emptySet(),
            editingRecordId = "record-1",
            isDetailDirty = false,
        )
        assertEquals(TabDataRealtimeDecision.Delete(setOf("record-1")), decision)
        val merged = TabDataRealtimePolicy.mergeRecords(current, emptyList(), setOf("record-1"))
        assertEquals(listOf("record-2"), merged.map(TabDataRecord::id))
    }

    @Test
    public fun `new records prepend without dropping the current page`() {
        val current = listOf(record("record-1", "旧"))
        val created = listOf(record("record-new", "新建"))
        val merged = TabDataRealtimePolicy.mergeRecords(current, created, emptySet())
        assertEquals(listOf("record-new", "record-1"), merged.map(TabDataRecord::id))
    }

    @Test
    public fun `kanban create without a home group asks for refresh`() {
        val groups = listOf(
            TabDataRecordGroup(
                groupValue = JsonPrimitive("todo"),
                groupLabel = "待办",
                records = listOf(record("record-1", "旧")),
                count = 1,
            ),
        )
        assertNull(
            TabDataRealtimePolicy.mergeGroups(groups, listOf(record("record-new", "新")), emptySet()),
        )
    }

    @Test
    public fun `id keyed websocket fields normalize to names`() {
        val raw = TabDataRecord(
            id = "record-1",
            tableId = "table-1",
            fields = JsonObject(mapOf("fld-title" to JsonPrimitive("按 id"))),
            data = JsonObject(mapOf("标题" to JsonPrimitive("按名"))),
            version = 2,
        )
        val normalized = TabDataRealtimePolicy.normalizeRecord(raw, fields)
        assertEquals(JsonPrimitive("按 id"), normalized.namedFields["标题"])
        assertNull(normalized.namedFields["fld-title"])
    }

    @Test
    public fun `wrong table or non delta envelopes are dropped`() {
        assertNull(
            TabDataRealtimePolicy.parseDelta(
                envelope("table.events.field", tableId = "table-1"),
                expectedTableId = "table-1",
            ),
        )
        assertNull(
            TabDataRealtimePolicy.parseDelta(
                envelope("table.events.delta", tableId = "table-other"),
                expectedTableId = "table-1",
            ),
        )
    }

    @Test
    public fun `field event for this table asks to reload schema`() {
        val change = TabDataRealtimePolicy.parseStructureChange(
            envelope(
                type = "table.events.field",
                tableId = "table-1",
                extra = buildJsonObject {
                    put("action", "create_field")
                    put("metadata", buildJsonObject { put("user_id", "user-1") })
                },
            ),
            expectedTableId = "table-1",
        )
        assertEquals(TabDataRealtimeStructureKind.Field, change?.kind)
        assertEquals("create_field", change?.action)
        assertEquals(
            TabDataRealtimeDecision.ReloadSchema,
            TabDataRealtimePolicy.decideStructure(requireNotNull(change)),
        )
    }

    @Test
    public fun `view event for this table asks to reload schema`() {
        val change = TabDataRealtimePolicy.parseStructureChange(
            envelope(
                type = "table.events.view",
                tableId = "table-1",
                extra = buildJsonObject { put("action", "update_view") },
            ),
            expectedTableId = "table-1",
        )
        assertEquals(TabDataRealtimeStructureKind.View, change?.kind)
        assertEquals(
            TabDataRealtimeDecision.ReloadSchema,
            TabDataRealtimePolicy.decideStructure(requireNotNull(change)),
        )
    }

    @Test
    public fun `structure events for another table are ignored`() {
        assertNull(
            TabDataRealtimePolicy.parseStructureChange(
                envelope("table.events.field", tableId = "table-other"),
                expectedTableId = "table-1",
            ),
        )
        assertNull(
            TabDataRealtimePolicy.parseStructureChange(
                envelope("table.events.view", tableId = "table-other"),
                expectedTableId = "table-1",
            ),
        )
        assertNull(
            TabDataRealtimePolicy.parseStructureChange(
                envelope("table.events.delta", tableId = "table-1"),
                expectedTableId = "table-1",
            ),
        )
    }

    @Test
    public fun `dirty draft fields survive schema reload and follow a rename`() {
        val remote = record("record-1", "远端标题", statusValue = "done")
        val rebase = TabDataRealtimePolicy.rebaseOpenDetailAfterSchema(
            previousFields = fields,
            nextFields = listOf(title.copy(name = "任务名"), status, field("fld-note", "备注", "text")),
            detailDraft = mapOf(
                "标题" to JsonPrimitive("我正在输入"),
                "状态" to JsonPrimitive("todo"),
            ),
            detailOriginal = mapOf(
                "标题" to JsonPrimitive("打开时的标题"),
                "状态" to JsonPrimitive("todo"),
            ),
            record = remote,
        )

        assertEquals(JsonPrimitive("我正在输入"), rebase.draft["任务名"])
        assertEquals(JsonPrimitive("done"), rebase.draft["状态"])
        assertEquals(JsonPrimitive("远端标题"), rebase.original["任务名"])
        assertEquals(listOf("任务名"), rebase.protectedFieldNames)
        assertTrue(rebase.droppedFieldNames.isEmpty())
        assertNull(rebase.draft["标题"])
    }

    @Test
    public fun `deleted field drops its dirty draft key and keeps the others`() {
        val remote = record("record-1", "远端标题")
        val rebase = TabDataRealtimePolicy.rebaseOpenDetailAfterSchema(
            previousFields = fields,
            nextFields = listOf(title),
            detailDraft = mapOf(
                "标题" to JsonPrimitive("我正在输入"),
                "状态" to JsonPrimitive("本地状态"),
            ),
            detailOriginal = mapOf(
                "标题" to JsonPrimitive("打开时的标题"),
                "状态" to JsonPrimitive("todo"),
            ),
            record = remote,
        )

        assertEquals(JsonPrimitive("我正在输入"), rebase.draft["标题"])
        assertNull(rebase.draft["状态"])
        assertEquals(listOf("标题"), rebase.protectedFieldNames)
        assertEquals(listOf("状态"), rebase.droppedFieldNames)
        assertTrue(rebase.draft.keys == setOf("标题"))
    }

    @Test
    public fun `type change drops the dirty value instead of writing incompatible data`() {
        val rebase = TabDataRealtimePolicy.rebaseOpenDetailAfterSchema(
            previousFields = fields,
            nextFields = listOf(title, status.copy(fieldType = "number")),
            detailDraft = mapOf(
                "标题" to JsonPrimitive("打开时的标题"),
                "状态" to JsonPrimitive("todo"),
            ),
            detailOriginal = mapOf(
                "标题" to JsonPrimitive("打开时的标题"),
                "状态" to JsonPrimitive("doing"),
            ),
            record = record("record-1", "远端标题", statusValue = "done"),
        )

        assertEquals(JsonPrimitive("done"), rebase.draft["状态"])
        assertEquals(listOf("状态"), rebase.droppedFieldNames)
        assertTrue(rebase.protectedFieldNames.isEmpty())
    }

    @Test
    public fun `rls flag is read from metadata or payload`() {
        val fromPayload = TabDataRealtimePolicy.parseDelta(
            envelope(
                type = "table.events.delta",
                tableId = "table-1",
                extra = buildJsonObject {
                    put("action", "update_record")
                    put("rls_affected", true)
                    put("metadata", buildJsonObject { put("user_id", "user-9") })
                },
            ),
            expectedTableId = "table-1",
        )
        val fromMetadata = TabDataRealtimePolicy.parseDelta(
            envelope(
                type = "table.events.delta",
                tableId = "table-1",
                extra = buildJsonObject {
                    put("action", "update_record")
                    put(
                        "metadata",
                        buildJsonObject {
                            put("user_id", "user-9")
                            put("rls_affected", true)
                            put("count", 3)
                        },
                    )
                },
            ),
            expectedTableId = "table-1",
        )
        assertTrue(fromPayload?.rlsAffected == true)
        assertTrue(fromMetadata?.rlsAffected == true)
        assertEquals(3L, fromMetadata?.affectedCount)
        assertEquals("user-9", fromMetadata?.actorUserId)
    }

    private fun delta(
        action: String,
        recordIds: List<String> = emptyList(),
        records: List<TabDataRecord> = emptyList(),
        latestVersion: Long? = null,
        rlsAffected: Boolean = false,
        actorUserId: String? = "user-2",
    ): TabDataRealtimeDelta = TabDataRealtimeDelta(
        tableId = "table-1",
        action = action,
        recordIds = recordIds,
        records = records,
        latestVersion = latestVersion,
        rlsAffected = rlsAffected,
        actorUserId = actorUserId,
        affectedCount = null,
    )

    private fun envelope(
        type: String,
        tableId: String,
        extra: JsonObject = JsonObject(emptyMap()),
    ): WSEnvelope = WSEnvelope(
        type = type,
        payload = JsonObject(
            mapOf("table_id" to JsonPrimitive(tableId)) + extra,
        ),
        tableId = tableId,
    )

    private fun record(
        id: String,
        titleValue: String,
        statusValue: String = "todo",
        version: Long = 1,
    ): TabDataRecord = TabDataRecord(
        id = id,
        tableId = "table-1",
        fields = JsonObject(
            mapOf(
                "标题" to JsonPrimitive(titleValue),
                "状态" to JsonPrimitive(statusValue),
            ),
        ),
        version = version,
    )

    private fun field(id: String, name: String, type: String): TabDataField = TabDataField(
        id = id,
        tableId = "table-1",
        name = name,
        fieldType = type,
    )

    private fun titleOf(record: TabDataRecord): String =
        (record.namedFields["标题"] as JsonPrimitive).content
}
