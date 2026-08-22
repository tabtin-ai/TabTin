package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import com.tabtin.mobile.data.model.tabdata.TabDataView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataPrefillPolicyTest {
    private val status = field("fld-status", "状态", "select")
    private val owner = field("fld-owner", "负责人", "user")
    private val due = field("fld-due", "截止日期", "date")
    private val progress = field("fld-progress", "进度", "percent")
    private val done = field("fld-done", "已验收", "checkbox")
    private val priority = field("fld-priority", "优先级", "rating")
    private val tags = field("fld-tags", "标签", "multi_select")
    private val title = field("fld-title", "任务名称", "text")
    private val link = field("fld-project", "所属项目", "link")
    private val attachment = field("fld-spec", "需求文档", "attachment")
    private val fields = listOf(
        status, owner, due, progress, done, priority, tags, title, link, attachment,
    )

    @Test
    public fun `or filter logic skips the entire filters branch`() {
        val view = view(
            filters = listOf(
                filter("fld-status", "is", JsonPrimitive("doing")),
                filter("fld-owner", "equals", JsonPrimitive("usr-0001")),
            ),
            groups = listOf(group("fld-tags")),
            filterLogic = "or",
        )
        val actual = TabDataPrefillPolicy.resolve(
            view,
            fields,
            JsonObject(mapOf("标签" to JsonPrimitive("urgent"))),
        )
        assertEquals(JsonObject(mapOf("标签" to JsonPrimitive("urgent"))), actual)
        assertNull("状态出现即仍处理了筛选段", actual?.get("状态"))
        assertNull(actual?.get("负责人"))
    }

    @Test
    public fun `missing enabled is treated as enabled and false is skipped`() {
        val view = view(
            filters = listOf(
                filter("fld-done", "is", JsonPrimitive(true), enabled = null),
                filter("fld-priority", "equals", JsonPrimitive(5), enabled = false),
            ),
        )
        val actual = TabDataPrefillPolicy.resolve(view, fields)
        assertEquals(JsonPrimitive(true), actual?.get("已验收"))
        assertNull("优先级=5 被禁用，出现即没跳过", actual?.get("优先级"))
    }

    @Test
    public fun `operators are case insensitive and trimmed`() {
        val view = view(
            filters = listOf(
                filter("fld-due", "IS", JsonPrimitive("2026-08-20")),
                filter("fld-tags", "  IS_ANY_OF  ", JsonArray(listOf(JsonPrimitive("urgent")))),
            ),
        )
        val actual = TabDataPrefillPolicy.resolve(view, fields)
        assertEquals(JsonPrimitive("2026-08-20"), actual?.get("截止日期"))
        assertEquals(JsonPrimitive("urgent"), actual?.get("标签"))
    }

    @Test
    public fun `field lookup falls back from id to name`() {
        val view = view(
            filters = listOf(
                filter("进度", "equals", JsonPrimitive(0.4)),
            ),
        )
        val actual = TabDataPrefillPolicy.resolve(view, fields)
        assertEquals(JsonPrimitive(0.4), actual?.get("进度"))
        assertNull("结果 key 必须是字段名", actual?.get("fld-progress"))
        assertNull(actual?.get("fld-status"))
    }

    @Test
    public fun `conflicting filters clear the entire filters result`() {
        val view = view(
            filters = listOf(
                filter("fld-status", "is", JsonPrimitive("doing")),
                filter("fld-owner", "equals", JsonPrimitive("usr-0001")),
                filter("fld-status", "is", JsonPrimitive("todo")),
            ),
            groups = listOf(group("fld-status")),
        )
        val actual = TabDataPrefillPolicy.resolve(
            view,
            fields,
            JsonObject(mapOf("状态" to JsonPrimitive("done"))),
        )
        assertEquals(JsonObject(mapOf("状态" to JsonPrimitive("done"))), actual)
        assertNull("负责人若还在，就是只清了冲突字段", actual?.get("负责人"))
    }

    @Test
    public fun `groups overlay filters using field names and skip empty values`() {
        val view = view(
            filters = listOf(filter("fld-status", "is", JsonPrimitive("doing"))),
            groups = listOf(group("fld-status")),
        )
        val overlay = TabDataPrefillPolicy.resolve(
            view,
            fields,
            JsonObject(mapOf("状态" to JsonPrimitive("todo"), "优先级" to JsonPrimitive(3))),
        )
        assertEquals(JsonPrimitive("todo"), overlay?.get("状态"))

        val emptyKeepsFilter = TabDataPrefillPolicy.resolve(
            view,
            fields,
            JsonObject(mapOf("状态" to JsonPrimitive(""))),
        )
        assertEquals(JsonPrimitive("doing"), emptyKeepsFilter?.get("状态"))
    }

    @Test
    public fun `result keys are field names and empty result is null`() {
        val view = view(
            filters = listOf(filter("fld-status", "is", JsonPrimitive("doing"))),
        )
        val actual = TabDataPrefillPolicy.resolve(view, fields)
        assertEquals(setOf("状态"), actual?.keys)
        assertNull(actual?.get("fld-status"))
        assertNull(TabDataPrefillPolicy.resolve(view(filters = emptyList()), fields))
    }

    @Test
    public fun `does not read nested filter set config filters or filter groups`() {
        val trapConfig = JsonObject(
            mapOf(
                "filter_logic" to JsonPrimitive("and"),
                "filters" to JsonObject(
                    mapOf(
                        "conjunction" to JsonPrimitive("and"),
                        "conditions" to JsonArray(
                            listOf(
                                JsonObject(
                                    mapOf(
                                        "field" to JsonPrimitive("fld-status"),
                                        "operator" to JsonPrimitive("is"),
                                        "value" to JsonPrimitive("todo"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                "groups" to JsonArray(listOf(group("fld-priority"))),
                "filter_groups" to JsonObject(
                    mapOf(
                        "conjunction" to JsonPrimitive("and"),
                        "groups" to JsonArray(
                            listOf(
                                JsonObject(
                                    mapOf(
                                        "conjunction" to JsonPrimitive("and"),
                                        "conditions" to JsonArray(
                                            listOf(
                                                JsonObject(
                                                    mapOf(
                                                        "field" to JsonPrimitive("fld-tags"),
                                                        "operator" to JsonPrimitive("is"),
                                                        "value" to JsonPrimitive("review"),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val view = TabDataView(
            id = "view-1",
            tableId = "table-1",
            name = "主视图",
            viewType = "grid",
            filter = JsonObject(
                mapOf(
                    "conjunction" to JsonPrimitive("and"),
                    "filterSet" to JsonArray(
                        listOf(
                            JsonObject(
                                mapOf(
                                    "field_id" to JsonPrimitive("fld-title"),
                                    "operator" to JsonPrimitive("equals"),
                                    "value" to JsonPrimitive("TRAP-FROM-NESTED-FILTER"),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
            filters = listOf(filter("fld-status", "is", JsonPrimitive("doing"))),
            groups = listOf(group("fld-status")),
            config = trapConfig,
        )
        val actual = TabDataPrefillPolicy.resolve(
            view,
            fields,
            JsonObject(mapOf("优先级" to JsonPrimitive(3))),
        )
        assertEquals(JsonPrimitive("doing"), actual?.get("状态"))
        assertNull("读了顶层 filter 就会多出任务名称", actual?.get("任务名称"))
        assertNull("读了 config.filters 会把状态改成 todo", actual?.get("标题"))
        assertNull("读了 config.groups 才会写入优先级", actual?.get("优先级"))
        assertNull("读了 filter_groups 会写入标签", actual?.get("标签"))
    }

    @Test
    public fun `single element array operators unwrap and multi element is skipped`() {
        val single = view(
            filters = listOf(
                filter("fld-tags", "is_any_of", JsonArray(listOf(JsonPrimitive("urgent")))),
                filter("fld-status", "in", JsonArray(listOf(JsonPrimitive("doing")))),
            ),
        )
        val unwrapped = TabDataPrefillPolicy.resolve(single, fields)
        assertEquals(JsonPrimitive("urgent"), unwrapped?.get("标签"))
        assertEquals(JsonPrimitive("doing"), unwrapped?.get("状态"))

        val multi = view(
            filters = listOf(
                filter(
                    "fld-tags",
                    "is_any_of",
                    JsonArray(listOf(JsonPrimitive("urgent"), JsonPrimitive("review"))),
                ),
                filter("fld-owner", "equals", JsonPrimitive("usr-0001")),
            ),
        )
        val skipped = TabDataPrefillPolicy.resolve(multi, fields)
        assertNull(skipped?.get("标签"))
        assertEquals(JsonPrimitive("usr-0001"), skipped?.get("负责人"))
    }

    @Test
    public fun `create-time writable specials are kept even when mobile ui is readonly`() {
        val view = view(
            filters = listOf(
                filter("fld-score", "equals", JsonPrimitive("1.6")),
                filter("fld-project", "equals", JsonArray(listOf(JsonPrimitive("rec-1001")))),
                filter("fld-spec", "equals", JsonPrimitive("file-a-0001")),
            ),
        )
        val actual = TabDataPrefillPolicy.resolve(view, fields)
        assertNull(actual?.get("综合得分"))
        assertEquals(JsonArray(listOf(JsonPrimitive("rec-1001"))), actual?.get("所属项目"))
        assertEquals(JsonPrimitive("file-a-0001"), actual?.get("需求文档"))
    }

    @Test
    public fun `kanban group values use the grouping field name`() {
        val view = view(groups = listOf(group("fld-owner")))
        val values = TabDataPrefillPolicy.groupValuesFrom(
            view,
            fields,
            TabDataRecordGroup(groupValue = JsonPrimitive("usr-0001"), groupLabel = "林小满"),
        )
        assertEquals(JsonObject(mapOf("负责人" to JsonPrimitive("usr-0001"))), values)
        assertTrue(TabDataPrefillPolicy.resolve(view, fields, values)?.containsKey("负责人") == true)
    }

    private fun field(id: String, name: String, type: String): TabDataField = TabDataField(
        id = id,
        tableId = "table-1",
        name = name,
        fieldType = type,
    )

    private fun filter(
        fieldId: String,
        operator: String,
        value: kotlinx.serialization.json.JsonElement,
        enabled: Boolean? = true,
    ): JsonObject = JsonObject(
        buildMap {
            put("field_id", JsonPrimitive(fieldId))
            put("operator", JsonPrimitive(operator))
            put("value", value)
            if (enabled != null) put("enabled", JsonPrimitive(enabled))
        },
    )

    private fun group(fieldId: String): JsonObject =
        JsonObject(mapOf("field_id" to JsonPrimitive(fieldId)))

    private fun view(
        filters: List<JsonObject> = emptyList(),
        groups: List<JsonObject> = emptyList(),
        filterLogic: String? = "and",
    ): TabDataView = TabDataView(
        id = "view-1",
        tableId = "table-1",
        name = "主视图",
        viewType = "grid",
        filters = filters,
        groups = groups,
        config = if (filterLogic == null) {
            JsonObject(emptyMap())
        } else {
            JsonObject(mapOf("filter_logic" to JsonPrimitive(filterLogic)))
        },
    )
}
