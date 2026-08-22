package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

public class TabDataProjectionTest {
    private val title = field("field-title", "标题", "text", primary = true, order = 0)
    private val status = field("field-status", "状态", "select", order = 1)
    private val owner = field("field-owner", "负责人", "user", order = 2)
    private val note = field("field-note", "摘要", "long_text", order = 3)
    private val cover = field("field-cover", "封面", "attachment", order = 4)

    @Test
    public fun `configured blank title stays unnamed instead of guessing another field`() {
        val view = view(
            config = JsonObject(mapOf("card_title_field" to JsonPrimitive(title.id))),
        )
        val record = record(
            "标题" to JsonPrimitive(""),
            "摘要" to JsonPrimitive("不应冒充标题"),
        )

        val card = TabDataProjection.card(
            record,
            view,
            listOf(title, note),
            untitledTitle = "未命名记录",
        )

        assertEquals("未命名记录", card.title)
    }

    @Test
    public fun `unconfigured title follows primary then first visible field`() {
        val primaryNote = listOf(note.copy(isPrimary = true), status)
        assertEquals(
            "正文标题",
            TabDataProjection.card(
                record("摘要" to JsonPrimitive("正文标题")),
                view(),
                primaryNote,
                untitledTitle = "Untitled record",
            ).title,
        )
        assertEquals(
            "Untitled record",
            TabDataProjection.card(
                TabDataRecord(id = "12345678-abcd-efgh", fields = JsonObject(emptyMap())),
                view(),
                listOf(status),
                untitledTitle = "Untitled record",
            ).title,
        )
    }

    /**
     * 末档回落服从 mobileTableProjection.ts：取第一个**可见**字段，不挑类型。此前限定
     * text/long_text，会跳过排在更前面、且真有值的非文本字段，落到「未命名记录」。
     */
    @Test
    public fun `title fallback takes first visible field regardless of type`() {
        val card = TabDataProjection.card(
            record("状态" to JsonPrimitive("处理中"), "摘要" to JsonPrimitive("")),
            view(visibleFields = listOf(status.id, note.id)),
            listOf(status, note.copy(isPrimary = false)),
            untitledTitle = "Untitled record",
        )

        assertEquals("处理中", card.title)
    }

    /** 隐藏字段不该冒充标题：可见集合为空时才回落到未命名。 */
    @Test
    public fun `title fallback ignores fields hidden by the view`() {
        val card = TabDataProjection.card(
            record("标题" to JsonPrimitive("被隐藏的标题"), "摘要" to JsonPrimitive("可见摘要")),
            view(visibleFields = listOf(note.id)),
            listOf(title, note.copy(isPrimary = false)),
            untitledTitle = "Untitled record",
        )

        assertEquals("可见摘要", card.title)
    }

    /**
     * 未配置 card_cover_field 时回落到第一个 attachment 可见字段，服从
     * mobileTableProjection.ts 的封面链。
     */
    @Test
    public fun `cover falls back to first attachment visible field`() {
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("有封面"),
                "封面" to JsonArray(
                    listOf(JsonObject(mapOf("url" to JsonPrimitive("https://example.test/fallback.png")))),
                ),
            ),
            view(visibleFields = listOf(title.id, cover.id)),
            listOf(title, cover),
            untitledTitle = "Untitled record",
        )

        assertEquals("https://example.test/fallback.png", card.coverUrl)
    }

    /**
     * 分组字段照常进摘要。Web 正典只排除标题与封面（mobileTableProjection.ts:84），移动端
     * 曾多排一层分组，导致同一条记录在 Web 与原生上摘要不是同一组字段。
     */
    @Test
    public fun `summary is view driven and excludes only title cover and blanks`() {
        val view = view(
            groups = listOf(JsonObject(mapOf("field_id" to JsonPrimitive(status.id)))),
            visibleFields = listOf(title.id, status.id, owner.id, note.id, cover.id),
            config = JsonObject(
                mapOf(
                    "card_title_field" to JsonPrimitive(title.id),
                    "card_cover_field" to JsonPrimitive(cover.id),
                ),
            ),
        )
        val record = record(
            "标题" to JsonPrimitive("修复导入"),
            "状态" to JsonPrimitive("处理中"),
            "负责人" to JsonObject(mapOf("name" to JsonPrimitive("小林"))),
            "摘要" to JsonPrimitive("保留移动端字段投影"),
            "封面" to JsonArray(
                listOf(JsonObject(mapOf("url" to JsonPrimitive("https://example.test/cover.png")))),
            ),
        )

        val card = TabDataProjection.card(
            record,
            view,
            listOf(title, status, owner, note, cover),
            untitledTitle = "Untitled record",
        )

        assertEquals("修复导入", card.title)
        assertEquals("https://example.test/cover.png", card.coverUrl)
        assertEquals(
            listOf("状态" to "处理中", "负责人" to "小林", "摘要" to "保留移动端字段投影"),
            card.summary,
        )
    }

    @Test
    public fun `only attachment can become card cover`() {
        val urlField = field("field-url", "网址", "url", order = 0)
        val view = view(config = JsonObject(mapOf("card_cover_field" to JsonPrimitive(urlField.id))))
        val card = TabDataProjection.card(
            record("网址" to JsonPrimitive("https://example.test/not-cover.png")),
            view,
            listOf(urlField),
            untitledTitle = "Untitled record",
        )

        assertNull(card.coverUrl)
    }

    /** 摘要中的日期使用本地化文本，不直接暴露存储格式。 */
    @Test
    public fun `card date fields render localized text instead of wire format`() {
        val dayField = field(id = "fld-day", name = "截止日", type = "date", order = 1)
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "截止日" to JsonPrimitive("2026-08-18"),
            ),
            view(),
            listOf(titleField, dayField),
            untitledTitle = "Untitled record",
        )

        val summary = card.summary.toMap()
        val expectedDay = TabDataDateCodec.displayDate(LocalDate.of(2026, 8, 18))
        assertEquals(expectedDay, summary["截止日"])
        assertFalse(summary.getValue("截止日").contains("T"))
    }

    /** 日期字段当标题时同样要格式化，否则卡片标题就是一串 ISO。 */
    @Test
    public fun `card title formats date field`() {
        val dayField = field(id = "fld-day", name = "截止日", type = "date", primary = true, order = 0)
        val card = TabDataProjection.card(
            record("截止日" to JsonPrimitive("2026-08-18")),
            view(),
            listOf(dayField),
            untitledTitle = "Untitled record",
        )

        assertEquals(TabDataDateCodec.displayDate(LocalDate.of(2026, 8, 18)), card.title)
    }

    /**
     * 卡片摘要 percent 必须走 Web 正典，不能露出后端比值原文。
     * 期望串与 iOS / `formatPercentCellValue` 相同：0.85 → 85%，不是 0.85。
     */
    @Test
    public fun `card percent fields render web formatted text instead of raw ratio`() {
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val progress = field(id = "fld-progress", name = "完成度", type = "percent", order = 1)
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "完成度" to JsonPrimitive(0.85),
            ),
            view(),
            listOf(titleField, progress),
            untitledTitle = "Untitled record",
        )

        assertEquals("85%", card.summary.toMap()["完成度"])
    }

    @Test
    public fun `card percent title and dirty values follow web fallback`() {
        val progress = field(id = "fld-progress", name = "完成度", type = "percent", primary = true, order = 0)
        assertEquals(
            "85%",
            TabDataProjection.card(
                record("完成度" to JsonPrimitive("0.85")),
                view(),
                listOf(progress),
                untitledTitle = "Untitled record",
            ).title,
        )
        assertEquals(
            "n/a",
            TabDataProjection.card(
                record("完成度" to JsonPrimitive("n/a")),
                view(),
                listOf(progress),
                untitledTitle = "Untitled record",
            ).title,
        )
    }

    /**
     * 卡片摘要 currency 必须带符号和精度，不能露出裸数字。
     * 正典：symbol + toFixed(precision)，默认 ¥ / 2。
     */
    @Test
    public fun `card currency fields render symbol and precision instead of raw number`() {
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val amount = field(id = "fld-amount", name = "金额", type = "currency", order = 1)
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "金额" to JsonPrimitive(12.3),
            ),
            view(),
            listOf(titleField, amount),
            untitledTitle = "Untitled record",
        )

        assertEquals("¥12.30", card.summary.toMap()["金额"])
    }

    /**
     * 卡片摘要 rating 必须画星星，不能露出裸数字。
     * 正典：0...max 整数，默认 max = 5。
     */
    @Test
    public fun `card rating fields render stars instead of raw number`() {
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val priority = field(id = "fld-priority", name = "优先级", type = "rating", order = 1)
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "优先级" to JsonPrimitive(3),
            ),
            view(),
            listOf(titleField, priority),
            untitledTitle = "Untitled record",
        )

        assertEquals("★★★☆☆", card.summary.toMap()["优先级"])
    }

    @Test
    public fun `card currency and rating honor field options`() {
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val amount = field(
            id = "fld-amount",
            name = "金额",
            type = "currency",
            order = 1,
            options = JsonObject(
                mapOf(
                    "symbol" to JsonPrimitive("$"),
                    "precision" to JsonPrimitive(1),
                ),
            ),
        )
        val priority = field(
            id = "fld-priority",
            name = "优先级",
            type = "rating",
            order = 2,
            options = JsonObject(mapOf("max" to JsonPrimitive(10))),
        )
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "金额" to JsonPrimitive(12.3),
                "优先级" to JsonPrimitive(3),
            ),
            view(),
            listOf(titleField, amount, priority),
            untitledTitle = "Untitled record",
        )

        assertEquals("$12.3", card.summary.toMap()["金额"])
        assertEquals("★★★☆☆☆☆☆☆☆", card.summary.toMap()["优先级"])
    }

    /** created_time / last_modified_time 在 Web 上也是原样输出，不要擅自领先一步。 */
    @Test
    public fun `card leaves computed timestamp fields as backend returns them`() {
        val stampField = field(id = "fld-updated", name = "最后更新时间", type = "last_modified_time", order = 1)
        val titleField = field(id = "fld-title", name = "标题", type = "text", primary = true, order = 0)
        val card = TabDataProjection.card(
            record(
                "标题" to JsonPrimitive("回访"),
                "最后更新时间" to JsonPrimitive("2026-08-17T11:25:38.373230+00:00"),
            ),
            view(),
            listOf(titleField, stampField),
            untitledTitle = "Untitled record",
        )

        assertEquals("2026-08-17T11:25:38.373230+00:00", card.summary.toMap()["最后更新时间"])
    }

    @Test
    public fun `dirty projection sends only changed field values`() {
        val original = mapOf("标题" to JsonPrimitive("旧标题"), "状态" to JsonPrimitive("待处理"))
        val draft = original + mapOf("标题" to JsonPrimitive("新标题"))

        assertEquals(
            JsonObject(mapOf("标题" to JsonPrimitive("新标题"))),
            TabDataProjection.dirtyFields(original, draft),
        )
    }

    private fun field(
        id: String,
        name: String,
        type: String,
        primary: Boolean = false,
        order: Int,
        options: JsonObject = JsonObject(emptyMap()),
    ): TabDataField = TabDataField(
        id = id,
        tableId = "table-1",
        name = name,
        fieldType = type,
        isPrimary = primary,
        order = order,
        options = options,
    )

    private fun view(
        config: JsonObject = JsonObject(emptyMap()),
        visibleFields: List<String> = emptyList(),
        groups: List<JsonObject> = emptyList(),
    ): TabDataView = TabDataView(
        id = "view-1",
        tableId = "table-1",
        name = "主视图",
        viewType = "grid",
        config = config,
        visibleFields = visibleFields,
        groups = groups,
    )

    private fun record(vararg fields: Pair<String, kotlinx.serialization.json.JsonElement>): TabDataRecord =
        TabDataRecord(id = "record-1", fields = JsonObject(mapOf(*fields)))
}
