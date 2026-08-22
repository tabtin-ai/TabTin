package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateRequest
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateResponse
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import com.tabtin.mobile.data.repository.TabDataRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Query

public class TabDataNativeApiContractTest {
    @Test
    public fun `native table endpoints keep backend paths`() {
        assertEquals("tabdata/tables/{id}", annotationPath("getTable", GET::class.java))
        assertEquals("tabdata/tables/{id}/views", annotationPath("listViews", GET::class.java))
        assertEquals("tabdata/tables/{id}/fields", annotationPath("listFields", GET::class.java))
        assertEquals("tabdata/fields", annotationPath("createField", POST::class.java))
        assertEquals("tabdata/views/{id}/records", annotationPath("getViewRecords", GET::class.java))
        assertEquals("tabdata/records/{id}", annotationPath("getRecord", GET::class.java))
        assertEquals("tabdata/records", annotationPath("createRecord", POST::class.java))
        assertEquals("tabdata/records/{id}", annotationPath("updateRecord", PUT::class.java))
        assertEquals("tabdata/records/bulk-update", annotationPath("bulkUpdateRecords", POST::class.java))
        assertEquals("tabdata/records/{id}", annotationPath("deleteRecord", DELETE::class.java))
    }

    @Test
    public fun `view records expose independent kanban paging and query overrides`() {
        val method = TabDataApi::class.java.declaredMethods.single { it.name == "getViewRecords" }
        val queryNames = method.parameterAnnotations
            .flatMap { it.toList() }
            .filterIsInstance<Query>()
            .map { it.value }
            .toSet()

        assertTrue(
            queryNames.containsAll(
                setOf(
                    "page", "page_size", "field_key_type", "search", "search_hide_not_match_rows",
                    "filters", "filter_logic", "groups", "sorts", "per_group_limit", "group_offsets",
                ),
            ),
        )
    }

    @Test
    public fun `native search always asks backend to hide non matching rows`() = runTest {
        val api = mockk<TabDataApi>()
        coEvery {
            api.getViewRecords(
                viewId = "view-1",
                page = 1,
                pageSize = 50,
                fieldKeyType = "name",
                search = "needle",
                searchHideNotMatchRows = true,
                filtersJson = null,
                filterLogic = null,
                groupsJson = null,
                sortsJson = null,
                perGroupLimit = null,
                groupOffsetsJson = null,
            )
        } returns ApiEnvelope(success = true, data = TabDataViewRecordsResponse())

        TabDataRepository(api).loadViewRecords(
            view = TabDataView(
                id = "view-1",
                tableId = "table-1",
                name = "All records",
            ),
            search = " needle ",
        )

        coVerify(exactly = 1) {
            api.getViewRecords(
                viewId = "view-1",
                page = 1,
                pageSize = 50,
                fieldKeyType = "name",
                search = "needle",
                searchHideNotMatchRows = true,
                filtersJson = null,
                filterLogic = null,
                groupsJson = null,
                sortsJson = null,
                perGroupLimit = null,
                groupOffsetsJson = null,
            )
        }
    }

    @Test
    public fun `record page inherits route table id when legacy nested view omits it`() = runTest {
        val api = mockk<TabDataApi>()
        val routeView = TabDataView(
            id = "view-1",
            tableId = "table-1",
            name = "All records",
        )
        coEvery {
            api.getViewRecords(
                viewId = "view-1",
                page = 1,
                pageSize = 50,
                fieldKeyType = "name",
                search = null,
                searchHideNotMatchRows = true,
                filtersJson = null,
                filterLogic = null,
                groupsJson = null,
                sortsJson = null,
                perGroupLimit = null,
                groupOffsetsJson = null,
            )
        } returns ApiEnvelope(
            success = true,
            data = TabDataViewRecordsResponse(
                view = routeView.copy(tableId = ""),
            ),
        )

        val response = TabDataRepository(api).loadViewRecords(routeView)

        assertEquals("table-1", response.view?.tableId)
    }

    @Test
    public fun `nested view filter omits legacy filter query and lets backend use authoritative filter set`() = runTest {
        val api = mockk<TabDataApi>()
        coEvery {
            api.getViewRecords(
                viewId = "view-1", page = 1, pageSize = 50, fieldKeyType = "name",
                search = null, searchHideNotMatchRows = true, filtersJson = null,
                filterLogic = null, groupsJson = null, sortsJson = null,
                perGroupLimit = null, groupOffsetsJson = null,
            )
        } returns ApiEnvelope(success = true, data = TabDataViewRecordsResponse())
        val nested = JsonObject(
            mapOf(
                "conjunction" to JsonPrimitive("or"),
                "filterSet" to JsonArray(listOf(JsonObject(mapOf("field_id" to JsonPrimitive("new"))))),
            ),
        )

        TabDataRepository(api).loadViewRecords(
            TabDataView(
                id = "view-1", tableId = "table-1", name = "All",
                filter = nested,
                filters = listOf(JsonObject(mapOf("field_id" to JsonPrimitive("legacy")))),
            ),
        )

        coVerify(exactly = 1) {
            api.getViewRecords(
                viewId = "view-1", page = 1, pageSize = 50, fieldKeyType = "name",
                search = null, searchHideNotMatchRows = true, filtersJson = null,
                filterLogic = null, groupsJson = null, sortsJson = null,
                perGroupLimit = null, groupOffsetsJson = null,
            )
        }
    }

    @Test
    public fun `record writes expose field key type in body contract`() {
        val createMethod = TabDataApi::class.java.declaredMethods.single { it.name == "createRecord" }
        val updateMethod = TabDataApi::class.java.declaredMethods.single { it.name == "updateRecord" }
        assertTrue(createMethod.parameterAnnotations.flatten().none { it is Query && it.value == "field_key_type" })
        assertTrue(updateMethod.parameterAnnotations.flatten().none { it is Query && it.value == "field_key_type" })
    }

    @Test
    public fun `bulk update asks backend for field id keys`() {
        val method = TabDataApi::class.java.declaredMethods.single { it.name == "bulkUpdateRecords" }
        assertTrue(
            method.parameterAnnotations.flatten().filterIsInstance<Query>()
                .any { it.value == "field_key_type" },
        )
    }

    @Test
    public fun `repository update uses bulk update without expected version`() = runTest {
        val api = mockk<TabDataApi>()
        val record = TabDataRecord(id = "record-1", tableId = "table-1")
        val body = slot<TabDataBulkUpdateRequest>()
        coEvery {
            api.bulkUpdateRecords(capture(body), fieldKeyType = "id")
        } returns ApiEnvelope(
            success = true,
            data = TabDataBulkUpdateResponse(successCount = 1, records = listOf(record)),
        )

        val outcome = TabDataRepository(api).updateRecord(
            recordId = "record-1",
            dirtyFields = JsonObject(mapOf("field-title" to JsonPrimitive("新"))),
            baseSnapshot = JsonObject(mapOf("field-title" to JsonPrimitive("旧"))),
        )

        assertEquals(record.id, outcome.record.id)
        assertTrue(outcome.conflicts.isEmpty())
        assertEquals("record-1", body.captured.updates.single().recordId)
        assertEquals(setOf("field-title"), body.captured.updates.single().data.keys)
        assertTrue(body.captured.operationGroupId.isNotBlank())
        coVerify(exactly = 0) { api.updateRecord(any(), any()) }
    }

    @Test
    public fun `delete exposes optimistic expected version query`() {
        val method = TabDataApi::class.java.declaredMethods.single { it.name == "deleteRecord" }
        assertTrue(
            method.parameterAnnotations.flatten().filterIsInstance<Query>()
                .any { it.value == "expected_version" },
        )
    }

    private fun <T : Annotation> annotationPath(
        methodName: String,
        type: Class<T>,
    ): String {
        val method = TabDataApi::class.java.declaredMethods.single { it.name == methodName }
        val annotation = method.getAnnotation(type)
        return when (annotation) {
            is GET -> annotation.value
            is POST -> annotation.value
            is PUT -> annotation.value
            is DELETE -> annotation.value
            else -> error("Unsupported annotation")
        }
    }
}
