package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataUserFieldPolicyTest {
    private val directory = TabDataMemberDirectory(
        members = listOf(
            TabDataDirectoryMember(userId = "member-1", displayName = "林小满"),
        ),
        identitySnapshots = listOf(
            TabDataIdentitySnapshot(userId = "departed-1", displayName = "周叙"),
        ),
    )

    @Test
    public fun `user field is native while computed user fields stay full mode only`() {
        assertTrue(TabDataUserFieldPolicy.isEditableUserField(field("负责人", "user")))
        assertFalse(TabDataUserFieldPolicy.isEditableUserField(field("创建人", "created_by")))
        assertFalse(TabDataUserFieldPolicy.isEditableUserField(field("修改人", "last_modified_by")))
        assertEquals(TabDataFieldEditMode.NATIVE, TabDataFieldPolicy.editMode("user"))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("created_by"))
        assertEquals(TabDataFieldEditMode.FULL_MODE_ONLY, TabDataFieldPolicy.editMode("last_modified_by"))
    }

    @Test
    public fun `multiple is expressed by options multiple or isMultiple`() {
        assertFalse(TabDataUserFieldPolicy.isMultiple(field("负责人", "user")))
        assertTrue(
            TabDataUserFieldPolicy.isMultiple(
                field("评审人", "user", JsonObject(mapOf("multiple" to JsonPrimitive(true)))),
            ),
        )
        assertTrue(
            TabDataUserFieldPolicy.isMultiple(
                field("评审人", "user", JsonObject(mapOf("isMultiple" to JsonPrimitive(true)))),
            ),
        )
        assertFalse(
            TabDataUserFieldPolicy.isMultiple(
                field("负责人", "user", JsonObject(mapOf("multiple" to JsonPrimitive(false)))),
            ),
        )
        assertFalse(
            TabDataUserFieldPolicy.isMultiple(
                field("创建人", "created_by", JsonObject(mapOf("multiple" to JsonPrimitive(true)))),
            ),
        )
        assertTrue(
            TabDataUserFieldPolicy.isMultiple(
                field("评审人", "user").copy(isMultipleCellValue = true),
            ),
        )
    }

    @Test
    public fun `encode matches desktop save contract`() {
        assertEquals(JsonNull, TabDataUserFieldPolicy.encode(emptyList(), multiple = false))
        assertEquals(JsonPrimitive("member-1"), TabDataUserFieldPolicy.encode(listOf("member-1"), multiple = false))
        assertEquals(
            JsonPrimitive("member-1"),
            TabDataUserFieldPolicy.encode(listOf("member-1", "member-2"), multiple = false),
        )
        assertEquals(JsonNull, TabDataUserFieldPolicy.encode(emptyList(), multiple = true))
        assertEquals(
            JsonArray(listOf(JsonPrimitive("member-1"), JsonPrimitive("departed-1"))),
            TabDataUserFieldPolicy.encode(listOf("member-1", "departed-1"), multiple = true),
        )
    }

    @Test
    public fun `selected ids accept scalar array and embedded object`() {
        assertEquals(listOf("member-1"), TabDataUserFieldPolicy.selectedIds(JsonPrimitive("member-1")))
        assertEquals(
            listOf("member-1", "departed-1"),
            TabDataUserFieldPolicy.selectedIds(
                JsonArray(listOf(JsonPrimitive("member-1"), JsonPrimitive("departed-1"))),
            ),
        )
        assertEquals(
            listOf("member-1"),
            TabDataUserFieldPolicy.selectedIds(
                JsonObject(mapOf("id" to JsonPrimitive("member-1"), "name" to JsonPrimitive("旧名"))),
            ),
        )
    }

    @Test
    public fun `toggle and remove keep write-back as ids`() {
        val single = JsonPrimitive("member-1")
        assertEquals(JsonNull, TabDataUserFieldPolicy.toggle(single, "member-1", multiple = false))
        assertEquals(JsonPrimitive("member-2"), TabDataUserFieldPolicy.toggle(single, "member-2", multiple = false))

        val multiple = JsonArray(listOf(JsonPrimitive("member-1")))
        assertEquals(
            JsonArray(listOf(JsonPrimitive("member-1"), JsonPrimitive("departed-1"))),
            TabDataUserFieldPolicy.toggle(multiple, "departed-1", multiple = true),
        )
        assertEquals(
            JsonNull,
            TabDataUserFieldPolicy.remove(multiple, "member-1", multiple = true),
        )
    }

    @Test
    public fun `departed selected ids still resolve after rewrite`() {
        val rewritten = TabDataUserFieldPolicy.encode(listOf("departed-1", "member-1"), multiple = true)
        val resolved = directory.resolve(rewritten)
        assertEquals(listOf("周叙（已离职）", "林小满"), resolved.map(TabDataMemberRef::displayName))
        assertEquals(listOf(TabDataMemberKind.DEPARTED, TabDataMemberKind.MEMBER), resolved.map(TabDataMemberRef::kind))
    }

    @Test
    public fun `dirty fields now include native user edits`() {
        val fields = listOf(field("负责人", "user"), field("创建人", "created_by"))
        val original = mapOf(
            "负责人" to JsonPrimitive("member-1"),
            "创建人" to JsonPrimitive("member-1"),
        )
        val draft = mapOf(
            "负责人" to JsonPrimitive("member-2"),
            "创建人" to JsonPrimitive("member-2"),
        )
        val dirty = TabDataDraftPolicy.dirtyFields(original, draft, fields)
        assertEquals(JsonPrimitive("member-2"), dirty["负责人"])
        assertFalse("创建人" in dirty)
    }

    private fun field(
        name: String,
        type: String,
        options: JsonObject = JsonObject(emptyMap()),
    ): TabDataField = TabDataField(
        id = "field-$name",
        tableId = "table-1",
        name = name,
        fieldType = type,
        options = options,
    )
}
