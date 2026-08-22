package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
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
 * 人员字段目录解析契约：用 user-directory 夹具喂纯函数 resolver，
 * 逐条对齐 kind / displayName / avatarUrl，并堵住裸 UUID 泄漏。
 */
class TabDataMemberDirectoryContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `resolver matches user-directory fixture cases and never leaks ids`() {
        val table = loadTable()
        val expectations = loadExpectations()
        val directory = table.directory()
        val fields = table.fields()
        val records = table.records()
        val cases = expectations.getValue("cases").jsonArray.filterIsInstance<JsonObject>()
        assertTrue("夹具必须覆盖人员字段解析用例", cases.isNotEmpty())

        val leakPolicy = expectations.getValue("leakPolicy").jsonObject
        val forbiddenSubstrings = leakPolicy.getValue("forbiddenSubstrings").jsonArray
            .map { it.jsonPrimitive.content }
        val forbiddenPatterns = leakPolicy.getValue("forbiddenPatterns").jsonArray
            .filterIsInstance<JsonObject>()
            .map { Regex(it.string("pattern")) }

        cases.forEach { case ->
            val label = case.string("name")
            val record = records.first { it.id == case.string("record") }
            val field = fields.first { it.id == case.string("field") }
            val value = record.namedFields[field.name] ?: record.namedFields[field.id]
            val actual = directory.resolve(value)
            val expected = case.getValue("target").asMemberTargets()

            assertEquals("$label 解析条数漂移", expected.size, actual.size)
            expected.zip(actual).forEachIndexed { index, (want, got) ->
                assertEquals("$label[$index] kind", want.string("kind"), got.kind.wireValue)
                assertEquals("$label[$index] displayName", want.string("displayName"), got.displayName)
                assertEquals(
                    "$label[$index] avatarUrl",
                    want["avatarUrl"]?.jsonPrimitive?.contentOrNull,
                    got.avatarUrl,
                )
            }

            val visible = actual.joinToString("、") { it.displayName }
            forbiddenSubstrings.forEach { fragment ->
                assertFalse("$label 泄漏了 $fragment：$visible", visible.contains(fragment))
            }
            forbiddenPatterns.forEach { pattern ->
                assertFalse("$label 匹配裸 UUID：$visible", pattern.containsMatchIn(visible))
            }
            assertFalse("$label 空值不该显示未知", value.isEmptyUserValue() && visible.contains("未知"))
        }
    }

    private fun JsonElement?.isEmptyUserValue(): Boolean = when (this) {
        null, JsonNull -> true
        is JsonArray -> isEmpty()
        is kotlinx.serialization.json.JsonPrimitive -> contentOrNull.isNullOrBlank()
        else -> false
    }

    private fun JsonElement.asMemberTargets(): List<JsonObject> = when (this) {
        is JsonArray -> filterIsInstance<JsonObject>()
        is JsonObject -> if (containsKey("kind")) listOf(this) else emptyList()
        else -> emptyList()
    }

    private fun JsonObject.directory(): TabDataMemberDirectory {
        val block = getValue("directory").jsonObject
        val members = block.getValue("members").jsonArray.filterIsInstance<JsonObject>().map { member ->
            TabDataDirectoryMember(
                userId = member.string("userId"),
                displayName = member.string("displayName"),
                avatarUrl = member["avatarUrl"]?.jsonPrimitive?.contentOrNull,
            )
        }
        val snapshots = block.getValue("identitySnapshots").jsonArray
            .filterIsInstance<JsonObject>()
            .map { snapshot ->
                TabDataIdentitySnapshot(
                    userId = snapshot.string("userId"),
                    displayName = snapshot.string("displayName"),
                    leftAt = snapshot["leftAt"]?.jsonPrimitive?.contentOrNull,
                )
            }
        return TabDataMemberDirectory(members = members, identitySnapshots = snapshots)
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

    private fun loadTable(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream("mobile-contract/table/user-directory.table.json"),
        ) { "缺少 mobile-contract/table/user-directory.table.json" }
            .bufferedReader()
            .use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun loadExpectations(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream(
                "mobile-contract/table/user-directory.expectations.json",
            ),
        ) { "缺少 mobile-contract/table/user-directory.expectations.json" }
            .bufferedReader()
            .use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull.orEmpty()
}
