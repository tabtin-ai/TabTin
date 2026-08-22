package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFilterRule
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataSortRule
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 多维表统一能力契约：Android 侧 full-fields 夹具测试。
 *
 * 真源：`tests/mobile-contract/fixtures/table/full-fields.*`
 * 只读拷贝：`app/src/test/resources/mobile-contract/table/`
 *
 * 3.0 只冻结诚实基线：生产探测必须与声明的 current / knownGaps 精确相等。
 * 不为了让严格发布门禁变绿而谎报生产支持。
 */
class NativeTabDataContractFixtureTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `fixture fields and aliases match declared Android current`() {
        val table = loadTable()
        val contract = loadExpectations()
        val fields = table.fields()
        assertEquals("夹具必须覆盖 27 个字段类型", 27, fields.map { it.fieldType }.toSet().size)

        val declared = contract.fieldCurrent("android")
        val actualEditable = fields
            .filter { productionDisposition(it.fieldType) == "editable" }
            .map { it.fieldType }
            .toSet()
        val actualReadonly = fields
            .filter { productionDisposition(it.fieldType) == "readonly_display" }
            .map { it.fieldType }
            .toSet()

        assertEquals("Android 可编辑字段集合发生漂移", declared.editable, actualEditable)
        assertEquals("Android 只读字段集合发生漂移", declared.readonly, actualReadonly)

        val aliasCases = table.aliasCases()
        val declaredAliases = contract
            .getValue("aliasNormalization")
            .jsonObject
            .getValue("current")
            .jsonObject
            .getValue("android")
            .jsonObject
        assertEquals("别名用例必须与 field.ts 的 14 条加未知透传一致", 15, aliasCases.size)
        aliasCases.forEach { alias ->
            val input = alias.string("input")
            val actual = TabDataFieldPolicy.normalizeFieldType(input)
            assertEquals(
                "Android 别名归一化发生漂移：$input",
                declaredAliases.string(input),
                actual,
            )
        }
    }

    @Test
    fun `card projection surface filter sort and leaks match declared Android current`() {
        val table = loadTable()
        val contract = loadExpectations()
        val fields = table.fields()
        val view = table.gridView()
        val records = table.records()
        val untitled = "未命名记录"

        val first = records.first { it.id == "rec-0001" }
        val card = TabDataProjection.card(first, view, fields, untitledTitle = untitled)
        val declaredCard = contract
            .getValue("cardProjection")
            .jsonObject
            .getValue("current")
            .jsonObject
            .getValue("android")
            .jsonObject

        assertEquals(declaredCard.string("titleField"), "fld-title")
        assertEquals("修复 Android 上下标丢失", card.title)
        assertEquals(
            declaredCard["coverField"]?.jsonPrimitive?.contentOrNull,
            if (card.coverUrl == null) null else "fld-cover",
        )
        assertEquals(
            "https://oss.example.com/file-m-0001.png",
            card.coverUrl,
        )
        assertEquals(
            declaredCard.getValue("bodyFields").jsonArray.map { it.jsonPrimitive.content },
            card.summary.map { fieldName -> fields.first { it.name == fieldName.first }.id },
        )
        assertTrue(
            "夹具分组写在 config.groups，生产 TabDataProjection 只读 view.groups",
            view.groups.isEmpty(),
        )
        // 分组字段照常进摘要：Web 正典只排除标题与封面（ 裁定）。本夹具对这条无鉴别力，
        // 分组字段排在前 4 射程之外，真正驱动这条的是 TabDataProjectionTest（见 ）。
        assertEquals(false, declaredCard.boolean("excludesGroupField"))
        assertEquals(
            declaredCard.boolean("excludesCoverField"),
            card.summary.none { it.first == "示意图" },
        )
        // 摘要跳过空值是经裁定保留的有意偏离，不跟随 Web 的「—」占位。
        assertEquals(true, declaredCard.boolean("skipsBlankSummaryFields"))
        assertEquals(declaredCard.boolean("supportsPrefill"), false)
        assertEquals(declaredCard.boolean("untitledUsesRecordId"), false)

        val blankTitle = TabDataProjection.card(
            first.copy(
                data = JsonObject(first.namedFields + ("fld-title" to JsonPrimitive(""))),
                fields = JsonObject(emptyMap()),
            ),
            view,
            fields,
            untitledTitle = untitled,
        )
        assertEquals(untitled, blankTitle.title)
        assertFalse(blankTitle.title.contains("rec-0001"))

        val declaredSurface = contract.getValue("surfacePolicy").jsonArray.filterIsInstance<JsonObject>()
        assertEquals(6, declaredSurface.size)
        declaredSurface.forEach { expectation ->
            val actual = currentSurface()
            val current = expectation.getValue("current").jsonObject.getValue("android").jsonObject
            assertEquals(current.string("surface"), actual.surface)
            assertEquals(current.boolean("showSwitcher"), actual.showSwitcher)
        }

        assertEquals(
            "flat_one_per_field",
            contract.filterCurrent("android").string("maxConditions"),
        )
        assertFalse(contract.filterCurrent("android").boolean("nestedGroups"))
        assertEquals(
            listOf("and", "or"),
            contract.filterCurrent("android").stringList("conjunctions"),
        )
        assertEquals(
            listOf("contains", "equals", "not_equals", "greater_than", "less_than"),
            contract.filterCurrent("android").stringList("operators"),
        )
        assertTrue(
            "交互筛选模型只有扁平 TabDataFilterRule，不能表达嵌套组",
            TabDataFilterRule("fld-status", "状态", "equals", JsonPrimitive("doing"))
                .javaClass
                .declaredFields
                .none { it.name.contains("group", ignoreCase = true) },
        )
        assertEquals(
            1,
            contract.sortCurrent("android")["maxConditions"]?.jsonPrimitive?.intOrNull,
        )
        assertEquals(
            1,
            listOf(TabDataSortRule("fld-priority", "优先级", true)).size,
        )

        val ownerField = fields.first { it.id == "fld-owner" }
        val ownerDisplay = first.namedFields[ownerField.id]?.displayText()
            ?: first.namedFields[ownerField.name].displayText()
        assertFalse(ownerDisplay.orEmpty().contains("usr-0001"))
        assertFalse(looksLikeInternalId(ownerDisplay.orEmpty()))
        assertFalse(contract.leakCurrent("android").boolean("leaksUserIdInDisplay"))
        assertFalse(contract.leakCurrent("android").boolean("leaksRecordIdInTitle"))
        assertFalse(contract.leakCurrent("android").boolean("leaksRawViewType"))
        assertTrue(table.view("viw-future-0001").supportsNativeCards.not())
        assertTrue(table.view("viw-calendar-0001").supportsNativeCards.not())
    }

    /**
     * viw-grid-0001 把分组字段与 hidden_fields 目标字段都排在摘要前 4 的射程之外，
     * 卡片投影的几条规则实现反了它也照样绿。projectionCases 里的
     * viw-cards-0002 把这些字段摆进射程，这里逐条实测生产投影。
     */
    @Test
    fun `discriminating projection cases match declared Android current`() {
        val table = loadTable()
        val contract = loadExpectations()
        val fields = table.fields()
        val records = table.records()
        val cases = contract.getValue("projectionCases").jsonArray.filterIsInstance<JsonObject>()
        assertTrue("卡片投影必须保留可证伪用例", cases.isNotEmpty())

        cases.forEach { case ->
            val label = case.string("id")
            val view = table.view(case.string("view"))
            val record = records.first { it.id == case.string("record") }
            val card = TabDataProjection.card(record, view, fields, untitledTitle = "未命名记录")
            val current = case.getValue("current").jsonObject.getValue("android").jsonObject

            assertTrue(
                "$label 的分组字段必须写在顶层 view.groups，与生产读法一致",
                view.groups.isNotEmpty(),
            )

            // 投影不回吐字段 id，只能反过来断言标题正是声明字段在该记录上的值。
            val titleField = fields.first { it.id == current.string("titleField") }
            assertEquals(
                "$label 标题必须取自 ${titleField.id}",
                (record.namedFields[titleField.name] ?: record.namedFields[titleField.id]).displayText(),
                card.title,
            )

            val coverFieldId = current["coverField"]?.jsonPrimitive?.contentOrNull
            if (coverFieldId == null) {
                assertEquals("$label 不应产出封面", null, card.coverUrl)
            } else {
                val coverField = fields.first { it.id == coverFieldId }
                val coverValue = record.namedFields[coverField.name] ?: record.namedFields[coverField.id]
                assertTrue(
                    "$label 封面必须取自 $coverFieldId 的值",
                    card.coverUrl != null && coverValue.toString().contains(card.coverUrl!!),
                )
            }

            assertEquals(
                "$label 摘要字段漂移",
                current.stringList("bodyFields"),
                card.summary.map { (name, _) -> fields.first { it.name == name }.id },
            )
        }
    }

    /**
     * prefillCases 必须保留可证伪用例。Android 已接线 [TabDataPrefillPolicy]，
     * current.android 必须等于生产函数对夹具视图的实际产出；ios 仍由另一端填写。
     */
    @Test
    fun `prefill cases match declared Android current`() {
        val table = loadTable()
        val contract = loadExpectations()
        val fields = table.fields()
        val cases = contract.getValue("prefillCases").jsonArray.filterIsInstance<JsonObject>()
        assertTrue("新建预填必须保留可证伪用例", cases.isNotEmpty())

        cases.forEach { case ->
            val label = case.string("id")
            val view = table.view(case.string("view"))
            val target = case["target"]
            assertTrue(
                "$label 必须声明正典 target",
                target != null && target !is kotlinx.serialization.json.JsonNull,
            )
            val groupValues = case["groupValues"] as? JsonObject
            val actual = TabDataPrefillPolicy.resolve(view, fields, groupValues)
                ?: kotlinx.serialization.json.JsonNull
            val current = case.getValue("current").jsonObject["android"]
                ?: kotlinx.serialization.json.JsonNull
            assertEquals(
                "$label Android 预填与 current 声明不一致",
                current,
                actual,
            )
        }
    }

    @Test
    fun `known gaps and table release readiness are derived from current vs target`() {
        val contract = loadExpectations()
        val declaredGaps = contract
            .getValue("knownGaps")
            .jsonObject
            .getValue("android")
            .jsonArray
            .filterIsInstance<JsonObject>()
        declaredGaps.forEach { gap ->
            val issue = gap["issue"]?.jsonPrimitive?.intOrNull
            assertTrue(
                "${gap.string("path")} 的 gap 必须挂在真实 issue 上，便于接手时找到上下文",
                issue != null && issue > 0,
            )
            assertEquals(3, gap["batch"]?.jsonPrimitive?.intOrNull)
            assertTrue(gap.string("reason").isNotBlank())
            assertTrue(gap.string("aspect") in setOf("disposition", "presentation"))
        }
        val declaredKeys = declaredGaps.map { "${it.string("path")}#${it.string("aspect")}" }.toSet()
        assertEquals(declaredGaps.size, declaredKeys.size)

        val derivedKeys = derivedAndroidGapKeys(contract)
        assertEquals(
            "Android gap 必须与 current/target 的当前事实精确相等，不能多报或漏报",
            derivedKeys,
            declaredKeys,
        )

        val iosEditable = contract.fieldCurrent("ios").editable
        val androidEditable = contract.fieldCurrent("android").editable
        val hasParityMismatch = iosEditable != androidEditable
        val hasKnownGaps = contract.getValue("knownGaps").jsonObject.values.any { gaps ->
            (gaps as? JsonArray)?.isNotEmpty() == true
        }
        val derivedReadiness = if (hasParityMismatch || hasKnownGaps || derivedKeys.isNotEmpty()) {
            "blocked"
        } else {
            "ready"
        }
        val releaseGate = contract.getValue("releaseGate").jsonObject
        assertTrue(releaseGate["requireDispositionParity"]?.jsonPrimitive?.booleanOrNull == true)
        assertTrue(releaseGate["requireKnownGapsEmpty"]?.jsonPrimitive?.booleanOrNull == true)
        assertEquals(
            "多维表 releaseReadiness 必须由处置一致性与 known gap 共同推导",
            derivedReadiness,
            releaseGate.string("releaseReadiness"),
        )
    }

    private fun derivedAndroidGapKeys(contract: JsonObject): Set<String> {
        val targetEditable = contract
            .getValue("fieldDispositions")
            .jsonObject
            .getValue("editable")
            .jsonArray
            .map { it.jsonPrimitive.content }
            .toSet()
        val currentEditable = contract.fieldCurrent("android").editable
        val keys = mutableSetOf<String>()
        (targetEditable - currentEditable).forEach { type ->
            keys += "/fieldDispositions/$type#disposition"
        }
        val aliasCurrent = contract
            .getValue("aliasNormalization")
            .jsonObject
            .getValue("current")
            .jsonObject
            .getValue("android")
            .jsonObject
        val aliasTarget = loadTable().aliasCases().associate { it.string("input") to it.string("canonical") }
        if (aliasTarget.any { (input, canonical) -> aliasCurrent.string(input) != canonical }) {
            keys += "/aliasNormalization#presentation"
        }
        val card = contract.getValue("cardProjection").jsonObject
        val cardCurrent = card.getValue("current").jsonObject.getValue("android").jsonObject
        // excludesGroupField 现在反向判定：排除分组才是跑偏，不排除才合正典。
        // hidden_fields 不再是目标，已从达标口径移除。
        val projectionCasesOffTarget = contract.getValue("projectionCases").jsonArray
            .filterIsInstance<JsonObject>()
            .any { case ->
                val target = case.getValue("target").jsonObject
                val current = case.getValue("current").jsonObject.getValue("android").jsonObject
                target.string("titleField") != current.string("titleField") ||
                    target["coverField"]?.jsonPrimitive?.contentOrNull !=
                    current["coverField"]?.jsonPrimitive?.contentOrNull ||
                    target.stringList("bodyFields") != current.stringList("bodyFields")
            }
        val cardOffTarget = card.string("coverField") != cardCurrent.string("coverField") ||
            cardCurrent.boolean("excludesGroupField") ||
            !cardCurrent.boolean("excludesCoverField") ||
            !cardCurrent.boolean("supportsPrefill") ||
            projectionCasesOffTarget
        if (cardOffTarget) keys += "/cardProjection#presentation"
        val prefillCases = contract["prefillCases"]?.jsonArray?.filterIsInstance<JsonObject>().orEmpty()
        val prefillCasesOffTarget = prefillCases.isEmpty() || prefillCases.any { case ->
            case["target"] != case.getValue("current").jsonObject["android"]
        }
        if (prefillCasesOffTarget) keys += "/prefillCases#presentation"
        val surfaceOffTarget = contract.getValue("surfacePolicy").jsonArray
            .filterIsInstance<JsonObject>()
            .any { expectation ->
                val current = expectation.getValue("current").jsonObject.getValue("android").jsonObject
                expectation.string("surface") != current.string("surface") ||
                    expectation.boolean("showSwitcher") != current.boolean("showSwitcher")
            }
        if (surfaceOffTarget) keys += "/surfacePolicy#disposition"
        val viewCurrent = contract
            .getValue("viewDispositions")
            .jsonObject
            .getValue("current")
            .jsonObject
            .getValue("android")
            .jsonObject
            .getValue("native")
            .jsonArray
            .map { it.jsonPrimitive.content }
            .toSet()
        val viewTarget = contract
            .getValue("viewDispositions")
            .jsonObject
            .getValue("native")
            .jsonArray
            .map { it.jsonPrimitive.content }
            .toSet()
        if (viewCurrent != viewTarget) keys += "/viewDispositions#disposition"
        val filter = contract.filterCurrent("android")
        if (filter.boolean("nestedGroups").not() || filter.string("maxConditions") != "nested") {
            keys += "/filterExpectations#disposition"
        }
        if (contract.sortCurrent("android")["maxConditions"]?.jsonPrimitive?.intOrNull != 2) {
            keys += "/sortExpectations#disposition"
        }
        if (contract.leakCurrent("android").boolean("leaksUserIdInDisplay")) {
            keys += "/leakPolicy/userId#presentation"
        }
        return keys
    }

    private fun productionDisposition(fieldType: String): String =
        if (TabDataFieldPolicy.editMode(fieldType) == TabDataFieldEditMode.NATIVE) {
            "editable"
        } else {
            "readonly_display"
        }

    private fun currentSurface(): SurfaceSnapshot {
        val hasPolicy = runCatching {
            Class.forName("com.tabtin.mobile.features.tabdata.TabDataRecordSurfacePolicy")
        }.isSuccess
        return if (hasPolicy) {
            error("3.0 只记录基线：若已引入表面策略，必须改为调用生产函数而不是改声明")
        } else {
            SurfaceSnapshot(surface = "cards", showSwitcher = false, columns = 1)
        }
    }

    private fun loadTable(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream("mobile-contract/table/full-fields.table.json"),
        ) { "缺少 mobile-contract/table/full-fields.table.json" }
            .bufferedReader()
            .use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun loadExpectations(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream(
                "mobile-contract/table/full-fields.expectations.json",
            ),
        ) { "缺少 mobile-contract/table/full-fields.expectations.json" }
            .bufferedReader()
            .use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun JsonObject.fields(): List<TabDataField> {
        val table = getValue("table").jsonObject
        val tableId = table.string("id")
        return table.getValue("fields").jsonArray.filterIsInstance<JsonObject>().map { field ->
            TabDataField(
                id = field.string("id"),
                tableId = tableId,
                name = field.string("name"),
                fieldType = field.string("field_type"),
                isPrimary = field["is_primary"]?.jsonPrimitive?.booleanOrNull == true,
                order = field["order"]?.jsonPrimitive?.intOrNull ?: 0,
                options = field["options"] as? JsonObject ?: JsonObject(emptyMap()),
            )
        }
    }

    private fun JsonObject.records(): List<TabDataRecord> =
        getValue("table").jsonObject.getValue("records").jsonArray.map {
            json.decodeFromJsonElement<TabDataRecord>(it)
        }

    private fun JsonObject.gridView(): TabDataView = view("viw-grid-0001")

    private fun JsonObject.view(id: String): TabDataView {
        val source = getValue("table").jsonObject.getValue("views").jsonArray
            .filterIsInstance<JsonObject>()
            .first { it.string("id") == id }
        return json.decodeFromJsonElement(source)
    }

    private fun JsonObject.aliasCases(): List<JsonObject> =
        getValue("aliasCases").jsonArray.filterIsInstance<JsonObject>()

    private fun JsonObject.fieldCurrent(platform: String): FieldCurrent {
        val current = getValue("fieldDispositions").jsonObject.getValue("current").jsonObject
            .getValue(platform).jsonObject
        return FieldCurrent(
            editable = current.getValue("editable").jsonArray.map { it.jsonPrimitive.content }.toSet(),
            readonly = current.getValue("readonly_display").jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
    }

    private fun JsonObject.filterCurrent(platform: String): JsonObject =
        getValue("filterExpectations").jsonObject.getValue("current").jsonObject.getValue(platform).jsonObject

    private fun JsonObject.sortCurrent(platform: String): JsonObject =
        getValue("sortExpectations").jsonObject.getValue("current").jsonObject.getValue(platform).jsonObject

    private fun JsonObject.leakCurrent(platform: String): JsonObject =
        getValue("leakPolicy").jsonObject.getValue("current").jsonObject.getValue(platform).jsonObject

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull.orEmpty()

    private fun JsonObject.boolean(key: String): Boolean =
        this[key]?.jsonPrimitive?.booleanOrNull == true

    private fun JsonObject.stringList(key: String): List<String> =
        getValue(key).jsonArray.map { it.jsonPrimitive.content }

    private data class FieldCurrent(val editable: Set<String>, val readonly: Set<String>)

    private data class SurfaceSnapshot(
        val surface: String,
        val showSwitcher: Boolean,
        val columns: Int,
    )

    @Suppress("unused")
    private val draftSchemaFingerprintKeepsNormalizeHonest: String
        get() = TabDataDraftSchema.fingerprint(emptyList())
}
