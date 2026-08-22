package com.tabtin.mobile.data.repository

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
public class TabDataDraftStoreTest {
    private lateinit var context: Context
    private lateinit var store: TabDataDraftStore

    @Before
    public fun setup() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteSharedPreferences(TABDATA_DRAFT_PREFERENCES)
        store = TabDataDraftStore(context)
    }

    @After
    public fun teardown() {
        context.deleteSharedPreferences(TABDATA_DRAFT_PREFERENCES)
    }

    @Test
    public fun `draft survives store recreation and is isolated by every scope component`() {
        val scope = TabDataDraftScope("user-1", "org-1", "table-1", "record-1")
        val snapshot = snapshot(scope)
        assertTrue(store.save(snapshot))
        assertEquals(snapshot.copy(updatedAt = store.load(scope)!!.updatedAt), TabDataDraftStore(context).load(scope))

        assertNull(store.load(scope.copy(userId = "user-2")))
        assertNull(store.load(scope.copy(organizationId = "org-2")))
        assertNull(store.load(scope.copy(tableId = "table-2")))
        assertNull(store.load(scope.copy(recordId = "record-2")))
    }

    @Test
    public fun `new record clear table and clear all only remove intended drafts`() {
        val newRecord = TabDataDraftScope("user-1", "org-1", "table-1", TabDataDraftStore.NEW_RECORD_ID)
        val sameTable = newRecord.copy(recordId = "record-1")
        val otherTable = sameTable.copy(tableId = "table-2")
        listOf(newRecord, sameTable, otherTable).forEach { assertTrue(store.save(snapshot(it))) }

        assertTrue(store.hasTableDrafts("user-1", "org-1", "table-1"))
        assertFalse(store.hasTableDrafts("user-1", "org-2", "table-1"))

        assertTrue(store.clearTable("user-1", "org-1", "table-1"))
        assertFalse(store.hasTableDrafts("user-1", "org-1", "table-1"))
        assertNull(store.load(newRecord))
        assertNull(store.load(sameTable))
        assertEquals("本地", store.load(otherTable)?.draft?.get("标题")?.let { (it as JsonPrimitive).content })

        assertTrue(store.clearAll())
        assertNull(store.load(otherTable))
        assertFalse(store.save(snapshot(otherTable.copy(userId = ""))))
    }

    @Test
    public fun `list table drafts returns only matching identity scope`() {
        val matching = TabDataDraftScope("user-1", "org-1", "table-1", "record-1")
        val otherOrganization = matching.copy(organizationId = "org-2", recordId = "record-2")
        assertTrue(store.save(snapshot(matching)))
        assertTrue(store.save(snapshot(otherOrganization)))

        assertEquals(
            listOf(matching),
            store.listTableDrafts("user-1", "org-1", "table-1").map(TabDataDraftSnapshot::scope),
        )
        assertTrue(store.listTableDrafts("user-1", "org-missing", "table-1").isEmpty())
    }

    private fun snapshot(scope: TabDataDraftScope): TabDataDraftSnapshot = TabDataDraftSnapshot(
        scope = scope,
        original = JsonObject(mapOf("标题" to JsonPrimitive("远端"))),
        draft = JsonObject(mapOf("标题" to JsonPrimitive("本地"))),
        expectedVersion = 7,
        isCreating = scope.recordId == TabDataDraftStore.NEW_RECORD_ID,
        updatedAt = 0,
    )
}
