package com.tabtin.mobile.data.model

import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateItem
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateRequest
import com.tabtin.mobile.data.model.tabdata.TabDataCreateRecordRequest
import com.tabtin.mobile.data.model.tabdata.TabDataFilterRule
import com.tabtin.mobile.data.model.tabdata.TabDataFieldsResponse
import com.tabtin.mobile.data.model.tabdata.TabDataUpdateRecordRequest
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import com.tabtin.mobile.data.repository.mobileFilterLogic
import com.tabtin.mobile.data.repository.legacyFilterQuery
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataNativeWireContractTest {
    @Test
    public fun `known desktop views remain readable through native cards`() {
        val nativeTypes = listOf("grid", "list", "kanban", "  Grid  ")
        val summaryTypes = listOf("gallery", "calendar", "form", "flashcard", "pivot", "gantt")

        nativeTypes.forEach { viewType ->
            assertTrue(
                viewType,
                TabDataView(id = "view-1", name = "视图", viewType = viewType).supportsNativeCards,
            )
        }
        summaryTypes.forEach { viewType ->
            assertFalse(
                viewType,
                TabDataView(id = "view-2", name = "视图", viewType = viewType).supportsNativeCards,
            )
        }
    }

    @Test
    public fun `kanban records decode from metadata groups instead of top level records`() {
        val payload = json.decodeFromString<TabDataViewRecordsResponse>(
            """{
              "view":{"id":"view-1","table_id":"table-1","name":"看板","view_type":"kanban"},
              "total":2,"matched_total":2,"page":1,"page_size":50,"latest_version":42,
              "metadata":{"view_type":"kanban","groups":[
                {"group_value":"todo","group_label":"待处理","color":"#999999","records":[
                  {"id":"record-1","fields":{"标题":"第一条"},"version":7}
                ],"count":2,"offset":0,"per_group_limit":1,"has_more":true}
              ]}
            }""".trimIndent(),
        )

        assertTrue(payload.records.isEmpty())
        assertEquals("record-1", payload.metadata.groups.single().records.single().id)
        assertTrue(payload.metadata.groups.single().hasMore)
        assertEquals(42L, payload.latestVersion)
    }

    @Test
    public fun `object shaped metadata groups do not discard top level records`() {
        val payload = json.decodeFromString<TabDataViewRecordsResponse>(
            """{
              "records":[
                {"id":"record-1","table_id":"table-1","fields":{"标题":"仍可读取"},"version":8}
              ],
              "total":1,"matched_total":1,"page":1,"page_size":50,
              "metadata":{"needs_configuration":false,"groups":{"fields":{},"nodes":{}}}
            }""".trimIndent(),
        )

        assertEquals("record-1", payload.records.single().id)
        assertEquals("仍可读取", (payload.records.single().namedFields["标题"] as? JsonPrimitive)?.content)
        assertTrue(payload.metadata.groups.isEmpty())
    }

    @Test
    public fun `legacy record page decodes when nested view omits table id`() {
        val payload = json.decodeFromString<TabDataViewRecordsResponse>(
            """{
              "view":{"id":"view-1","name":"表格视图","view_type":"grid"},
              "records":[],"total":0,"page":1,"page_size":50
            }""".trimIndent(),
        )

        assertEquals("", payload.view?.tableId)
    }

    @Test
    public fun `field response keeps schema version and unknown options`() {
        val payload = json.decodeFromString<TabDataFieldsResponse>(
            """{"fields":[{"id":"field-1","table_id":"table-1","name":"状态","field_type":"select","is_primary":false,"order":1,"is_hidden":false,"options":{"choices":[{"name":"待处理","color":"gray"}]}}],"total":1,"schema_version":9}""",
        )

        assertEquals(9, payload.schemaVersion)
        assertEquals("待处理", payload.fields.single().choices.single().label)
    }

    @Test
    public fun `record writes use name keys and optimistic version`() {
        val fields = JsonObject(mapOf("标题" to JsonPrimitive("移动端")))
        val createJson = json.encodeToString(TabDataCreateRecordRequest("table-1", fields, fieldKeyType = "id"))
        val updateJson = json.encodeToString(
            TabDataUpdateRecordRequest(fields, fieldKeyType = "id", expectedVersion = 3_000_000_000L),
        )

        assertTrue(createJson.contains("\"field_key_type\":\"id\""))
        assertTrue(updateJson.contains("\"field_key_type\":\"id\""))
        assertTrue(updateJson.contains("\"expected_version\":3000000000"))
        assertFalse(updateJson.contains("\"data\""))
    }

    @Test
    public fun `bulk update writes use field id keys and base snapshot`() {
        val data = JsonObject(mapOf("field-title" to JsonPrimitive("新")))
        val snapshot = JsonObject(mapOf("field-title" to JsonPrimitive("旧")))
        val encoded = json.encodeToString(
            TabDataBulkUpdateRequest(
                updates = listOf(
                    TabDataBulkUpdateItem(
                        recordId = "record-1",
                        data = data,
                        baseSnapshot = snapshot,
                    ),
                ),
                operationGroupId = "group-1",
            ),
        )

        assertTrue(encoded.contains("\"record_id\":\"record-1\""))
        assertTrue(encoded.contains("\"base_snapshot\""))
        assertTrue(encoded.contains("\"field-title\""))
        assertTrue(encoded.contains("\"operation_group_id\":\"group-1\""))
        assertFalse(encoded.contains("expected_version"))
    }

    @Test
    public fun `view filter logic keeps persisted OR semantics`() {
        val view = TabDataView(
            id = "view-1",
            tableId = "table-1",
            name = "任一满足",
            config = JsonObject(mapOf("filter_logic" to JsonPrimitive("OR"))),
        )

        assertEquals("or", view.configuredFilterLogic)
        assertEquals(null, mobileFilterLogic(view, emptyList(), requestedLogic = "and"))
        assertEquals(
            "and",
            mobileFilterLogic(
                view,
                listOf(TabDataFilterRule("field-1", "状态", "equals", JsonPrimitive("open"))),
                requestedLogic = "and",
            ),
        )
        assertEquals(
            "and",
            view.copy(config = JsonObject(mapOf("filter_logic" to JsonPrimitive("unsupported"))))
                .configuredFilterLogic,
        )
    }

    @Test
    public fun `nested filter set decodes and wins over legacy filters`() {
        val view = json.decodeFromString<TabDataView>(
            """{"id":"view-1","table_id":"table-1","name":"筛选","filter":{"conjunction":"or","filterSet":[{"field_id":"new"}]},"filters":[{"field_id":"legacy"}],"config":{"filter_logic":"and"}}""",
        )

        assertEquals("or", view.configuredFilterLogic)
        assertEquals(null, view.legacyFilterQuery())
        assertEquals(null, mobileFilterLogic(view, emptyList(), requestedLogic = "and"))
    }

    @Test
    public fun `invalid nested filter safely falls back to legacy filters`() {
        val legacy = JsonObject(mapOf("field_id" to JsonPrimitive("legacy")))
        val view = TabDataView(
            id = "view-1",
            tableId = "table-1",
            name = "筛选",
            filter = JsonObject(mapOf("conjunction" to JsonPrimitive("or"))),
            filters = listOf(legacy),
        )

        assertEquals(JsonArray(listOf(legacy)), view.legacyFilterQuery())
    }
}
