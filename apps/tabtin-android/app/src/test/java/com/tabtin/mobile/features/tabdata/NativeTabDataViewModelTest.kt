package com.tabtin.mobile.features.tabdata

import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldConflict
import com.tabtin.mobile.data.model.tabdata.TabDataCreateFieldRequest
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataUpdateOutcome
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import com.tabtin.mobile.data.repository.TabDataDraftStore
import com.tabtin.mobile.data.repository.TabDataDraftScope
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.repository.TabDataRepository
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.slot
import io.mockk.every
import io.mockk.verify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
public class NativeTabDataViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var repository: TabDataRepository
    private lateinit var draftStore: TabDataDraftStore
    private lateinit var tokenManager: TokenManager
    private lateinit var organizationRepository: OrganizationRepository
    private lateinit var memberDirectoryStore: TabDataMemberDirectoryStore
    private lateinit var webSocketService: WebSocketService
    private lateinit var selectedOrganization: MutableStateFlow<Organization?>
    private lateinit var connectionState: MutableStateFlow<WSConnectionState>
    private var activeOrganizationId: String? = "org-1"
    private var currentUserId: String? = "user-1"
    private var isLoggedIn: Boolean = true

    @Before
    public fun setup() {
        Dispatchers.setMain(dispatcher)
        repository = mockk()
        draftStore = mockk(relaxed = true)
        tokenManager = mockk(relaxed = true)
        organizationRepository = mockk()
        memberDirectoryStore = mockk(relaxed = true)
        webSocketService = mockk(relaxed = true)
        selectedOrganization = MutableStateFlow(Organization(id = "org-1", name = "组织一"))
        connectionState = MutableStateFlow(WSConnectionState.Disconnected)
        every { webSocketService.connectionState } returns connectionState
        activeOrganizationId = "org-1"
        currentUserId = "user-1"
        isLoggedIn = true
        every { tokenManager.userId } answers { currentUserId }
        every { tokenManager.organizationId } answers { activeOrganizationId }
        every { tokenManager.isLoggedIn } answers { isLoggedIn }
        every { organizationRepository.selectedOrganization } returns selectedOrganization
        every { memberDirectoryStore.snapshot(any()) } returns TabDataMemberDirectory.Empty
        coEvery { memberDirectoryStore.warmUp(any(), any()) } returns TabDataMemberDirectory.Empty
        every { draftStore.load(any()) } returns null
        every { draftStore.hasTableDrafts(any(), any(), any()) } returns false
        every { draftStore.save(any()) } returns true
    }

    @After
    public fun teardown() {
        Dispatchers.resetMain()
    }

    @Test
    public fun `initial load selects table default view`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val other = view("view-other")
        stubInitial(listOf(other, defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns
            TabDataViewRecordsResponse(records = listOf(record("record-1")), total = 1, matchedTotal = 1)

        val vm = newViewModel()
        advanceUntilIdle()

        assertEquals(defaultView.id, vm.uiState.value.selectedViewId)
        assertEquals(listOf("record-1"), vm.uiState.value.records.map(TabDataRecord::id))
        assertFalse(vm.uiState.value.isLoading)
    }

    @Test
    public fun `initial load preserves default view OR filter logic`() = runTest(dispatcher) {
        val defaultView = view(
            id = "view-default",
            filterLogic = "or",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()

        val vm = newViewModel()
        advanceUntilIdle()

        assertEquals("or", vm.uiState.value.filterLogic)
        coVerify {
            repository.loadViewRecords(
                view = defaultView,
                page = 1,
                pageSize = NativeTabDataViewModel.PAGE_SIZE,
                search = "",
                filters = emptyList<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>(),
                filterLogic = "or",
                sorts = emptyList<com.tabtin.mobile.data.model.tabdata.TabDataSortRule>(),
                groupOffsets = emptyMap<String, Int>(),
            )
        }
    }

    @Test
    public fun `table without views exits loading into localized empty state`() = runTest(dispatcher) {
        stubInitial(emptyList(), defaultViewId = "missing-view")

        val vm = newViewModel()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isLoading)
        assertEquals(null, vm.uiState.value.errorRes)
        assertEquals(null, vm.uiState.value.selectedView)
        coVerify(exactly = 0) {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        }
    }

    @Test
    public fun `initial null selected organization does not revoke a matching routed session`() = runTest(dispatcher) {
        selectedOrganization.value = null
        stubInitial(emptyList(), defaultViewId = "missing-view")

        val vm = newViewModel()
        advanceUntilIdle()

        assertEquals("table-1", vm.uiState.value.table?.id)
        assertFalse(vm.uiState.value.isLoading)
        verify(exactly = 0) { draftStore.clearTable(any(), any(), any()) }
    }

    @Test
    public fun `organization switch clears sensitive state and ignores late detail response`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        val detailResponse = CompletableDeferred<TabDataRecord>()
        coEvery { repository.loadRecord(record.id) } coAnswers { detailResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        runCurrent()
        activeOrganizationId = "org-2"
        selectedOrganization.value = Organization(id = "org-2", name = "组织二")
        runCurrent()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.records.isEmpty())
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }

        detailResponse.complete(record.copy(fields = JsonObject(mapOf("标题" to JsonPrimitive("迟到详情")))))
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())
    }

    @Test
    public fun `resume reloads schema and falls back when current view was deleted`() = runTest(dispatcher) {
        val originalView = view("view-original")
        stubInitial(listOf(originalView), defaultViewId = originalView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()
        val vm = newViewModel()
        advanceUntilIdle()

        val fallbackView = view("view-fallback")
        val newDefaultView = view("view-new-default")
        coEvery { repository.loadTable("table-1") } returns table(
            name = "Web 更新后的项目",
            defaultViewId = newDefaultView.id,
        )
        coEvery { repository.loadViews("table-1") } returns listOf(fallbackView, newDefaultView)
        coEvery { repository.loadFields("table-1") } returns listOf(
            TabDataField(
                id = "field-summary",
                tableId = "table-1",
                name = "摘要",
                fieldType = "long_text",
                isPrimary = true,
            ),
        )

        vm.refreshOnResume()
        advanceUntilIdle()

        assertEquals("Web 更新后的项目", vm.uiState.value.table?.name)
        assertEquals(newDefaultView.id, vm.uiState.value.selectedViewId)
        assertEquals(listOf("field-summary"), vm.uiState.value.fields.map(TabDataField::id))
        coVerify(exactly = 2) { repository.loadTable("table-1") }
        coVerify(exactly = 2) { repository.loadViews("table-1") }
        coVerify(exactly = 2) { repository.loadFields("table-1") }
        coVerify {
            repository.loadViewRecords(
                view = newDefaultView,
                page = 1,
                pageSize = NativeTabDataViewModel.PAGE_SIZE,
                search = "",
                filters = emptyList<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>(),
                filterLogic = "and",
                sorts = emptyList<com.tabtin.mobile.data.model.tabdata.TabDataSortRule>(),
                groupOffsets = emptyMap<String, Int>(),
            )
        }
    }

    @Test
    public fun `resume preserves current view when it still exists`() = runTest(dispatcher) {
        val first = view("view-first")
        val current = view("view-current")
        stubInitial(listOf(first, current), defaultViewId = first.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()
        val vm = newViewModel()
        advanceUntilIdle()
        vm.selectView(current.id)
        advanceUntilIdle()

        val newDefault = view("view-new-default")
        coEvery { repository.loadTable("table-1") } returns table(defaultViewId = newDefault.id)
        coEvery { repository.loadViews("table-1") } returns listOf(newDefault, current)

        vm.refreshOnResume()
        advanceUntilIdle()

        assertEquals(current.id, vm.uiState.value.selectedViewId)
    }

    @Test
    public fun `resume removes query rules for fields deleted in full editor`() = runTest(dispatcher) {
        val current = view("view-current")
        stubInitial(listOf(current), defaultViewId = current.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()
        val vm = newViewModel()
        advanceUntilIdle()
        val oldField = vm.uiState.value.fields.single()
        vm.addFilter(oldField, "contains", JsonPrimitive("旧条件"))
        advanceUntilIdle()
        vm.setSort(oldField, descending = true)
        advanceUntilIdle()

        coEvery { repository.loadFields("table-1") } returns listOf(
            TabDataField(
                id = "field-summary",
                tableId = "table-1",
                name = "摘要",
                fieldType = "long_text",
                isPrimary = true,
            ),
        )

        vm.refreshOnResume()
        advanceUntilIdle()

        assertEquals(current.id, vm.uiState.value.selectedViewId)
        assertTrue(vm.uiState.value.filters.isEmpty())
        assertTrue(vm.uiState.value.sorts.isEmpty())
    }

    @Test
    public fun `permission downgrade on resume closes stale detail and blocks save`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))

        coEvery { repository.loadTable("table-1") } returns table(
            defaultViewId = defaultView.id,
            currentUserRole = "viewer",
        )
        vm.refreshOnResume()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.canWrite)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())

        vm.saveDetail()
        advanceUntilIdle()

        coVerify(exactly = 0) { repository.updateRecord(any(), any(), any()) }
        coVerify(exactly = 0) { repository.createRecord(any(), any()) }
    }

    @Test
    public fun `save in progress rejects delete until save completes`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val saveResponse = CompletableDeferred<TabDataUpdateOutcome>()
        coEvery { repository.updateRecord(record.id, any(), any()) } coAnswers { saveResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))

        vm.saveDetail()

        assertTrue(vm.uiState.value.isSaving)
        vm.deleteRecord()
        runCurrent()
        coVerify(exactly = 0) { repository.deleteRecord(any(), any()) }

        saveResponse.complete(TabDataUpdateOutcome(record.copy(version = 8)))
        advanceUntilIdle()
    }

    @Test
    public fun `delete in progress rejects save until delete completes`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val deleteResponse = CompletableDeferred<Unit>()
        coEvery { repository.deleteRecord(record.id, 7) } coAnswers { deleteResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))

        vm.deleteRecord()

        assertTrue(vm.uiState.value.isDeleting)
        vm.saveDetail()
        runCurrent()
        coVerify(exactly = 0) { repository.updateRecord(any(), any(), any()) }

        deleteResponse.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    public fun `late save after organization switch cannot remove old draft or restore detail`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val saveResponse = CompletableDeferred<TabDataUpdateOutcome>()
        coEvery { repository.updateRecord(record.id, any(), any()) } coAnswers { saveResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))

        vm.saveDetail()
        runCurrent()
        activeOrganizationId = "org-2"
        selectedOrganization.value = Organization(id = "org-2", name = "组织二")
        runCurrent()
        saveResponse.complete(TabDataUpdateOutcome(record.copy(version = 8)))
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())
        verify(exactly = 0) {
            draftStore.remove(match { scope -> scope.recordId == record.id })
        }
    }

    @Test
    public fun `late delete after organization switch cannot publish deletion state`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val deleteResponse = CompletableDeferred<Unit>()
        coEvery { repository.deleteRecord(record.id, record.version) } coAnswers { deleteResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()

        vm.deleteRecord()
        runCurrent()
        activeOrganizationId = "org-2"
        selectedOrganization.value = Organization(id = "org-2", name = "组织二")
        runCurrent()
        deleteResponse.complete(Unit)
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.mutationMessageRes)
        verify(exactly = 0) {
            draftStore.remove(match { scope -> scope.recordId == record.id })
        }
    }

    @Test
    public fun `latest record tap wins when an earlier detail responds late`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val first = record("record-a")
        val second = record("record-b")
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first, second), total = 2, matchedTotal = 2)
        val firstResponse = CompletableDeferred<TabDataRecord>()
        coEvery { repository.loadRecord(first.id) } coAnswers { firstResponse.await() }
        coEvery { repository.loadRecord(second.id) } returns second
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(first)
        runCurrent()
        vm.openRecord(second)
        advanceUntilIdle()
        assertEquals(second.id, vm.uiState.value.selectedRecord?.id)

        firstResponse.complete(first)
        advanceUntilIdle()

        assertEquals(second.id, vm.uiState.value.selectedRecord?.id)
        assertEquals(JsonPrimitive("原始"), vm.uiState.value.detailDraft["标题"])
    }

    @Test
    public fun `openRecord seeds list record before detail response`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1")
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        val detailResponse = CompletableDeferred<TabDataRecord>()
        coEvery { repository.loadRecord(record.id) } coAnswers { detailResponse.await() }
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        runCurrent()

        assertEquals(record.id, vm.uiState.value.selectedRecord?.id)
        assertEquals(JsonPrimitive("原始"), vm.uiState.value.detailDraft["标题"])
        assertTrue(vm.uiState.value.isDetailLoading)

        detailResponse.complete(record.copy(fields = JsonObject(mapOf("标题" to JsonPrimitive("详情")))))
        advanceUntilIdle()

        assertEquals(JsonPrimitive("详情"), vm.uiState.value.detailDraft["标题"])
        assertFalse(vm.uiState.value.isDetailLoading)
    }

    @Test
    public fun `version conflict preserves local draft`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1", version = 7)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns
            TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } throws AppError.VersionConflict
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        val title = vm.uiState.value.fields.single()
        vm.updateDraft(title, JsonPrimitive("本地草稿"))

        vm.saveDetail()
        advanceUntilIdle()

        assertEquals(
            com.tabtin.mobile.R.string.tabdata_save_version_conflict_retry,
            vm.uiState.value.mutationMessageRes,
        )
        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertTrue(vm.uiState.value.canEditDetail)
        assertEquals(JsonPrimitive("本地草稿"), vm.uiState.value.detailDraft[title.name])
        coVerify(exactly = 1) { repository.updateRecord(record.id, any(), any()) }
    }

    @Test
    public fun `wrong update response identity keeps draft and locks further writes`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } returns
            TabDataUpdateOutcome(record("wrong-record", version = 8))
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        val title = vm.uiState.value.fields.single()
        vm.updateDraft(title, JsonPrimitive("本地草稿"))

        vm.saveDetail()
        advanceUntilIdle()

        assertTrue(vm.uiState.value.detailWriteBlocked)
        assertEquals(JsonPrimitive("本地草稿"), vm.uiState.value.detailDraft[title.name])
        verify(exactly = 0) { draftStore.remove(any()) }
    }

    @Test
    public fun `save permission denial revalidates viewer and preserves local draft read only`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } throws
            AppError.RequestFailed("编辑权限已变更", "PERMISSION_DENIED")
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        val title = vm.uiState.value.fields.single()
        vm.updateDraft(title, JsonPrimitive("本地草稿"))

        val remote = record.copy(
            fields = JsonObject(mapOf("标题" to JsonPrimitive("远端正文"))),
            version = 8,
        )
        coEvery { repository.loadTable("table-1") } returns table(
            defaultViewId = defaultView.id,
            currentUserRole = "viewer",
        )
        coEvery { repository.loadRecord(record.id) } returns remote

        vm.saveDetail()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.canWrite)
        assertEquals(remote, vm.uiState.value.selectedRecord)
        assertEquals(remote, vm.uiState.value.records.single())
        assertEquals(JsonPrimitive("本地草稿"), vm.uiState.value.detailDraft[title.name])
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_permission_changed_draft_preserved,
            vm.uiState.value.conflictMessageRes,
        )
        verify(exactly = 0) { draftStore.remove(any()) }
        verify(exactly = 0) { draftStore.clearTable(any(), any(), any()) }
        coVerify(exactly = 1) { repository.updateRecord(record.id, any(), any()) }
        coVerify(exactly = 2) { repository.loadTable("table-1") }
    }

    @Test
    public fun `save permission denial whose read is also denied clears protected table drafts`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val record = record("record-1", version = 7)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } throws
            AppError.RequestFailed("编辑权限已变更", "PERMISSION_DENIED")
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))
        coEvery { repository.loadTable("table-1") } throws
            AppError.RequestFailed("资源已不可见", "PERMISSION_DENIED")

        vm.saveDetail()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())
        assertTrue(vm.uiState.value.records.isEmpty())
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
    }

    @Test
    public fun `save busy preserves local draft and shows retryable message`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1", version = 7)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } throws
            AppError.RequestFailed(errorCode = TabDataRepository.SAVE_BUSY_CODE)
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        val title = vm.uiState.value.fields.single()
        vm.updateDraft(title, JsonPrimitive("本地草稿"))

        vm.saveDetail()
        advanceUntilIdle()

        assertEquals(JsonPrimitive("本地草稿"), vm.uiState.value.detailDraft[title.name])
        assertEquals(com.tabtin.mobile.R.string.tabdata_save_busy, vm.uiState.value.mutationMessageRes)
        assertNull(vm.uiState.value.mutationMessage)
        verify(exactly = 0) { draftStore.remove(any()) }
    }

    @Test
    public fun `missing response organization fails closed and clears table drafts`() = runTest(dispatcher) {
        stubInitial(listOf(view("view-default")), defaultViewId = "view-default", organizationId = null)

        val vm = newViewModel()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertTrue(vm.uiState.value.views.isEmpty())
        assertTrue(vm.uiState.value.fields.isEmpty())
        assertTrue(vm.uiState.value.records.isEmpty())
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
        coVerify(exactly = 0) { repository.loadViews(any()) }
    }

    @Test
    public fun `different response organization fails closed and clears table drafts`() = runTest(dispatcher) {
        stubInitial(listOf(view("view-default")), defaultViewId = "view-default", organizationId = "org-2")

        val vm = newViewModel()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertTrue(vm.uiState.value.views.isEmpty())
        assertTrue(vm.uiState.value.fields.isEmpty())
        assertTrue(vm.uiState.value.records.isEmpty())
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
        coVerify(exactly = 0) { repository.loadViews(any()) }
    }

    @Test
    public fun `same organization wrong table response fails closed and preserves drafts`() = runTest(dispatcher) {
        stubInitial(listOf(view("view-default")), defaultViewId = "view-default")
        coEvery { repository.loadTable("table-1") } returns table().copy(id = "wrong-table")

        val vm = newViewModel()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertTrue(vm.uiState.value.views.isEmpty())
        assertTrue(vm.uiState.value.fields.isEmpty())
        assertTrue(vm.uiState.value.records.isEmpty())
        assertEquals(TabDataResponseMismatchException().message, vm.uiState.value.errorMessage)
        verify(exactly = 0) { draftStore.clearTable(any(), any(), any()) }
        coVerify(exactly = 0) { repository.loadViews(any()) }
    }

    @Test
    public fun `route and active organization mismatch fails closed before request`() = runTest(dispatcher) {
        every { tokenManager.organizationId } returns "org-2"

        val vm = newViewModel()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertFalse(vm.uiState.value.isLoading)
        coVerify(exactly = 0) { repository.loadTable(any()) }
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
        verify(exactly = 1) { draftStore.clearTable("user-1", "org-2", "table-1") }
    }

    @Test
    public fun `record page permission loss clears table and sensitive detail state`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1")
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        assertEquals(record.id, vm.uiState.value.selectedRecord?.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } throws AppError.RequestFailed("不可见", "NOT_FOUND")

        vm.refresh()
        advanceUntilIdle()

        assertNull(vm.uiState.value.table)
        assertNull(vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())
        assertTrue(vm.uiState.value.records.isEmpty())
        assertTrue(vm.uiState.value.groups.isEmpty())
        verify(atLeast = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
    }

    @Test
    public fun `failed detail request clears stale card record`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1")
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns
            TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } throws AppError.RequestFailed("记录已不存在")
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        advanceUntilIdle()

        assertEquals(null, vm.uiState.value.selectedRecord)
        assertTrue(vm.uiState.value.detailDraft.isEmpty())
        assertEquals("记录已不存在", vm.uiState.value.mutationMessage)
    }

    @Test
    public fun `closed persisted detail draft still requires explicit discard confirmation`() = runTest(dispatcher) {
        stubInitial(emptyList(), defaultViewId = "missing")
        every { draftStore.hasTableDrafts("user-1", "org-1", "table-1") } returns true
        val vm = newViewModel()
        advanceUntilIdle()
        val event = async { vm.events.first() }
        runCurrent()

        vm.requestFullEditor()

        assertEquals(NativeTabDataEvent.ConfirmDiscardDraftsForFullEditor, event.await())
    }

    @Test
    public fun `initial offline load exposes scoped draft read only without schema or mutation`() = runTest(dispatcher) {
        val snapshot = TabDataDraftSnapshot(
            scope = TabDataDraftScope("user-1", "org-1", "table-1", TabDataDraftStore.NEW_RECORD_ID),
            original = JsonObject(emptyMap()),
            draft = JsonObject(mapOf("标题" to JsonPrimitive("离线草稿"))),
            isCreating = true,
        )
        coEvery { repository.loadTable("table-1") } throws RuntimeException("offline")
        every { draftStore.listTableDrafts("user-1", "org-1", "table-1") } returns listOf(snapshot)
        val vm = newViewModel()
        advanceUntilIdle()

        assertEquals(listOf(snapshot), vm.uiState.value.offlineDrafts)
        assertFalse(vm.uiState.value.canWrite)
        assertFalse(vm.uiState.value.hasResumableCreationDraft)

        vm.openOfflineDraft(TabDataDraftStore.NEW_RECORD_ID)
        assertEquals(JsonPrimitive("离线草稿"), vm.uiState.value.detailDraft["标题"])
        assertTrue(vm.uiState.value.detailWriteBlocked)
        assertFalse(vm.uiState.value.canEditDetail)

        vm.saveDetail()
        advanceUntilIdle()
        coVerify(exactly = 0) { repository.createRecord(any(), any()) }
        coVerify(exactly = 0) { repository.updateRecord(any(), any(), any()) }
        coVerify(exactly = 0) { repository.deleteRecord(any(), any()) }
    }

    @Test
    public fun `field creation refreshes confirmed schema before closing sheet`() = runTest(dispatcher) {
        val view = view("view-default")
        stubInitial(listOf(view), defaultViewId = view.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()
        val vm = newViewModel()
        advanceUntilIdle()
        val status = TabDataField(
            id = "field-status",
            tableId = "table-1",
            name = "状态",
            fieldType = "select",
            order = 1,
        )
        val request = slot<TabDataCreateFieldRequest>()
        coEvery { repository.createField(capture(request)) } returns status
        coEvery { repository.loadFields("table-1") } returns listOf(
            TabDataField(
                id = "field-title",
                tableId = "table-1",
                name = "标题",
                fieldType = "text",
                isPrimary = true,
            ),
            status,
        )
        val event = async { vm.events.first() }
        runCurrent()

        vm.createField(" 状态 ", TabDataCreateFieldType.SELECT, listOf("待办", "完成"))
        advanceUntilIdle()

        assertEquals(NativeTabDataEvent.FieldCreated, event.await())
        assertEquals(listOf("field-title", "field-status"), vm.uiState.value.fields.map(TabDataField::id))
        assertEquals("状态", request.captured.name)
        assertEquals("select", request.captured.fieldType)
        assertEquals(2, request.captured.options["choices"]?.let { it as kotlinx.serialization.json.JsonArray }?.size)
        assertFalse(vm.uiState.value.isCreatingField)
        assertNull(vm.uiState.value.fieldCreationError)
    }

    @Test
    public fun `failed field creation keeps confirmed schema and sheet error`() = runTest(dispatcher) {
        stubInitial(emptyList(), defaultViewId = "missing")
        val vm = newViewModel()
        advanceUntilIdle()
        coEvery { repository.createField(any()) } throws RuntimeException("offline")

        vm.createField("备注", TabDataCreateFieldType.LONG_TEXT)
        advanceUntilIdle()

        assertEquals(listOf("field-title"), vm.uiState.value.fields.map(TabDataField::id))
        assertEquals("offline", vm.uiState.value.fieldCreationError)
        assertFalse(vm.uiState.value.isCreatingField)
        coVerify(exactly = 1) { repository.loadFields("table-1") }
    }

    @Test
    public fun `confirmed discard clears all table drafts before opening full editor`() = runTest(dispatcher) {
        stubInitial(emptyList(), defaultViewId = "missing")
        every { draftStore.clearTable("user-1", "org-1", "table-1") } returns true
        val vm = newViewModel()
        advanceUntilIdle()
        val event = async { vm.events.first() }
        runCurrent()

        vm.discardTableDraftsAndOpenFullEditor()

        verify(exactly = 1) { draftStore.clearTable("user-1", "org-1", "table-1") }
        assertEquals(NativeTabDataEvent.OpenFullEditor, event.await())
    }

    @Test
    public fun `save submits field id keys and edit-start snapshot for dirty fields only`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        val note = TabDataField(
            id = "field-note",
            tableId = "table-1",
            name = "备注",
            fieldType = "text",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery { repository.loadFields("table-1") } returns listOf(title, note)
        val record = TabDataRecord(
            id = "record-1",
            tableId = "table-1",
            fields = JsonObject(
                mapOf(
                    "标题" to JsonPrimitive("别人改过的标题"),
                    "备注" to JsonPrimitive("别人没动的备注"),
                ),
            ),
            version = 9,
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        val snapshot = TabDataDraftSnapshot(
            scope = TabDataDraftScope("user-1", "org-1", "table-1", record.id),
            original = JsonObject(
                mapOf(
                    "标题" to JsonPrimitive("编辑起点标题"),
                    "备注" to JsonPrimitive("编辑起点备注"),
                ),
            ),
            draft = JsonObject(
                mapOf(
                    "标题" to JsonPrimitive("我改的标题"),
                    "备注" to JsonPrimitive("编辑起点备注"),
                ),
            ),
            expectedVersion = 1,
            fieldIdentities = TabDataDraftSchema.identities(listOf(title, note)),
            schemaFingerprint = TabDataDraftSchema.fingerprint(listOf(title, note)),
        )
        every { draftStore.load(match { it.recordId == record.id }) } returns snapshot
        val dataSlot = slot<JsonObject>()
        val snapshotSlot = slot<JsonObject>()
        coEvery { repository.updateRecord(record.id, capture(dataSlot), capture(snapshotSlot)) } returns
            TabDataUpdateOutcome(record.copy(version = 10))
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        advanceUntilIdle()
        assertFalse(vm.uiState.value.detailWriteBlocked)

        vm.saveDetail()
        advanceUntilIdle()

        assertEquals(setOf("field-title"), dataSlot.captured.keys)
        assertEquals(setOf("field-title"), snapshotSlot.captured.keys)
        assertFalse("标题" in dataSlot.captured)
        assertFalse("标题" in snapshotSlot.captured)
        assertEquals(JsonPrimitive("我改的标题"), dataSlot.captured["field-title"])
        assertEquals(JsonPrimitive("编辑起点标题"), snapshotSlot.captured["field-title"])
        assertFalse("field-note" in snapshotSlot.captured)
    }

    @Test
    public fun `opening a newer remote version does not lock overlapping-safe draft writes`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1", version = 9)
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        every { draftStore.load(match { it.recordId == record.id }) } returns TabDataDraftSnapshot(
            scope = TabDataDraftScope("user-1", "org-1", "table-1", record.id),
            original = JsonObject(mapOf("标题" to JsonPrimitive("编辑起点"))),
            draft = JsonObject(mapOf("标题" to JsonPrimitive("本地草稿"))),
            expectedVersion = 1,
            fieldIdentities = TabDataDraftSchema.identities(listOf(title)),
            schemaFingerprint = TabDataDraftSchema.fingerprint(listOf(title)),
        )
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        advanceUntilIdle()

        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertTrue(vm.uiState.value.canEditDetail)
        assertNull(vm.uiState.value.conflictMessageRes)
        assertEquals(JsonPrimitive("本地草稿"), vm.uiState.value.detailDraft["标题"])
    }

    @Test
    public fun `schema incompatible draft still locks writes`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1", version = 9)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        every { draftStore.load(match { it.recordId == record.id }) } returns TabDataDraftSnapshot(
            scope = TabDataDraftScope("user-1", "org-1", "table-1", record.id),
            original = JsonObject(mapOf("标题" to JsonPrimitive("编辑起点"))),
            draft = JsonObject(mapOf("标题" to JsonPrimitive("本地草稿"))),
            expectedVersion = 1,
        )
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openRecord(record)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.detailWriteBlocked)
        assertFalse(vm.uiState.value.canEditDetail)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_version_conflict_message,
            vm.uiState.value.conflictMessageRes,
        )
    }

    @Test
    public fun `successful save with advisory conflicts closes detail and stays editable`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        val record = record("record-1", version = 7)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(record.id) } returns record
        coEvery { repository.updateRecord(record.id, any(), any()) } returns TabDataUpdateOutcome(
            record = record.copy(
                version = 8,
                fields = JsonObject(mapOf("标题" to JsonPrimitive("本地草稿"))),
            ),
            conflicts = listOf(
                TabDataFieldConflict(recordId = record.id, fieldId = "field-title"),
            ),
        )
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(record)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("本地草稿"))
        val event = async { vm.events.first() }
        runCurrent()

        vm.saveDetail()
        advanceUntilIdle()

        assertEquals(NativeTabDataEvent.CloseDetail, event.await())
        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_collaborative_field_changed,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(listOf("标题"), vm.uiState.value.mutationMessageFields)
        assertNull(vm.uiState.value.mutationMessageCount)
        verify { draftStore.remove(match { it.recordId == record.id }) }
    }

    @Test
    public fun `opening a table subscribes to table events`() = runTest(dispatcher) {
        stubInitial(listOf(view("view-default")), defaultViewId = "view-default")
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse()

        newViewModel()
        advanceUntilIdle()

        verify { webSocketService.subscribe(listOf("table.events.table-1")) }
        verify { webSocketService.onEnvelope(match { it.startsWith("tabdata-realtime-table-1") }, any()) }
    }

    @Test
    public fun `realtime inline records merge by id and keep dirty draft fields`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1", version = 1)
        val second = record("record-2", version = 1)
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first, second), total = 2, matchedTotal = 2)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("我正在输入"))

        vm.handleTableEnvelope(
            tableDeltaEnvelope(
                action = "update_record",
                recordIds = listOf("record-1", "record-2"),
                records = listOf(
                    first.copy(version = 4, fields = JsonObject(mapOf("标题" to JsonPrimitive("别人改的标题")))),
                    second.copy(version = 3, fields = JsonObject(mapOf("标题" to JsonPrimitive("第二条远端")))),
                ),
                latestVersion = 4,
            ),
        )
        advanceUntilIdle()

        assertEquals(listOf("record-1", "record-2"), vm.uiState.value.records.map(TabDataRecord::id))
        assertEquals("别人改的标题", (vm.uiState.value.records[0].namedFields["标题"] as JsonPrimitive).content)
        assertEquals("第二条远端", (vm.uiState.value.records[1].namedFields["标题"] as JsonPrimitive).content)
        assertEquals(JsonPrimitive("我正在输入"), vm.uiState.value.detailDraft["标题"])
        assertEquals(JsonPrimitive("别人改的标题"), vm.uiState.value.detailOriginal["标题"])
        assertEquals(4L, vm.uiState.value.selectedRecord?.version)
        coVerify(exactly = 1) {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        }
    }

    @Test
    public fun `realtime delta without records refreshes the current view`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record("record-1")), total = 1, matchedTotal = 1)
        val vm = newViewModel()
        advanceUntilIdle()

        vm.handleTableEnvelope(
            tableDeltaEnvelope(action = "update_record", recordIds = listOf("record-1")),
        )
        advanceUntilIdle()

        coVerify(exactly = 2) {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        }
    }

    @Test
    public fun `rls affected realtime delta refreshes even with inline records`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record("record-1")), total = 1, matchedTotal = 1)
        val vm = newViewModel()
        advanceUntilIdle()

        vm.handleTableEnvelope(
            tableDeltaEnvelope(
                action = "update_record",
                recordIds = listOf("record-1"),
                records = listOf(
                    record("record-1").copy(fields = JsonObject(mapOf("标题" to JsonPrimitive("不该直接合并")))),
                ),
                latestVersion = 9,
                rlsAffected = true,
            ),
        )
        advanceUntilIdle()

        assertEquals("原始", (vm.uiState.value.records.single().namedFields["标题"] as JsonPrimitive).content)
        coVerify(exactly = 2) {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        }
    }

    @Test
    public fun `remote delete of the open dirty record keeps the draft`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single(), JsonPrimitive("还没保存"))

        vm.handleTableEnvelope(
            tableDeltaEnvelope(action = "delete_record", recordIds = listOf("record-1")),
        )
        advanceUntilIdle()

        assertTrue(vm.uiState.value.records.none { it.id == "record-1" })
        assertEquals(JsonPrimitive("还没保存"), vm.uiState.value.detailDraft["标题"])
        assertEquals("record-1", vm.uiState.value.selectedRecord?.id)
        assertTrue(vm.uiState.value.detailWriteBlocked)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_record_deleted_remotely,
            vm.uiState.value.conflictMessageRes,
        )
    }

    @Test
    public fun `field structure event reloads schema and keeps dirty draft fields`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1")
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        val status = TabDataField(
            id = "field-status",
            tableId = "table-1",
            name = "状态",
            fieldType = "select",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery { repository.loadFields("table-1") } returnsMany listOf(
            listOf(title),
            listOf(title, status),
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(vm.uiState.value.fields.single { it.id == "field-title" }, JsonPrimitive("还没保存"))

        vm.handleTableEnvelope(
            tableStructureEnvelope(type = "table.events.field", action = "create_field"),
        )
        advanceUntilIdle()

        assertEquals(listOf("field-title", "field-status"), vm.uiState.value.fields.map(TabDataField::id))
        assertEquals(JsonPrimitive("还没保存"), vm.uiState.value.detailDraft["标题"])
        assertEquals("record-1", vm.uiState.value.selectedRecord?.id)
        assertFalse(vm.uiState.value.detailWriteBlocked)
        // 只加字段、没有丢掉正在编辑的值：保持泛化「表结构已更新」，不弹点名告知。
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_schema_updated,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(emptyList<String>(), vm.uiState.value.mutationMessageFields)
        assertNull(vm.uiState.value.mutationMessageCount)
        coVerify(exactly = 2) { repository.loadFields("table-1") }
        coVerify(exactly = 2) { repository.loadTable("table-1") }
        coVerify(exactly = 2) { repository.loadViews("table-1") }
    }

    @Test
    public fun `view structure event reloads schema`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record("record-1")), total = 1, matchedTotal = 1)
        val vm = newViewModel()
        advanceUntilIdle()

        vm.handleTableEnvelope(
            tableStructureEnvelope(type = "table.events.view", action = "update_view"),
        )
        advanceUntilIdle()

        coVerify(exactly = 2) { repository.loadTable("table-1") }
        coVerify(exactly = 2) { repository.loadViews("table-1") }
        coVerify(exactly = 2) { repository.loadFields("table-1") }
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_schema_updated,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(emptyList<String>(), vm.uiState.value.mutationMessageFields)
        assertNull(vm.uiState.value.mutationMessageCount)
    }

    @Test
    public fun `structure event for another table is ignored`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(record("record-1")), total = 1, matchedTotal = 1)
        val vm = newViewModel()
        advanceUntilIdle()

        vm.handleTableEnvelope(
            tableStructureEnvelope(
                type = "table.events.field",
                action = "create_field",
                tableId = "table-other",
            ),
        )
        advanceUntilIdle()

        coVerify(exactly = 1) { repository.loadFields("table-1") }
        assertNull(vm.uiState.value.mutationMessageRes)
    }

    @Test
    public fun `schema reload drops a deleted field key but keeps other dirty values`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1")
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        val status = TabDataField(
            id = "field-status",
            tableId = "table-1",
            name = "状态",
            fieldType = "select",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery { repository.loadFields("table-1") } returnsMany listOf(
            listOf(title, status),
            listOf(title),
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(title, JsonPrimitive("标题还在改"))
        vm.updateDraft(status, JsonPrimitive("本地状态"))

        vm.handleTableEnvelope(
            tableStructureEnvelope(type = "table.events.field", action = "delete_field"),
        )
        advanceUntilIdle()

        assertEquals(listOf("field-title"), vm.uiState.value.fields.map(TabDataField::id))
        assertEquals(JsonPrimitive("标题还在改"), vm.uiState.value.detailDraft["标题"])
        assertNull(vm.uiState.value.detailDraft["状态"])
        assertEquals("record-1", vm.uiState.value.selectedRecord?.id)
        assertTrue(vm.uiState.value.isDetailDirty)
        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_schema_dropped_field,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(listOf("状态"), vm.uiState.value.mutationMessageFields)
        assertNull(vm.uiState.value.mutationMessageCount)
    }

    @Test
    public fun `schema reload uses plural notice when multiple dirty fields are dropped`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1")
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        val status = TabDataField(
            id = "field-status",
            tableId = "table-1",
            name = "状态",
            fieldType = "select",
        )
        val note = TabDataField(
            id = "field-note",
            tableId = "table-1",
            name = "备注",
            fieldType = "text",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery { repository.loadFields("table-1") } returnsMany listOf(
            listOf(title, status, note),
            listOf(title),
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(title, JsonPrimitive("标题还在改"))
        vm.updateDraft(status, JsonPrimitive("本地状态"))
        vm.updateDraft(note, JsonPrimitive("本地备注"))

        vm.handleTableEnvelope(
            tableStructureEnvelope(type = "table.events.field", action = "delete_field"),
        )
        advanceUntilIdle()

        assertEquals(JsonPrimitive("标题还在改"), vm.uiState.value.detailDraft["标题"])
        assertNull(vm.uiState.value.detailDraft["状态"])
        assertNull(vm.uiState.value.detailDraft["备注"])
        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertTrue(vm.uiState.value.canEditDetail)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_schema_dropped_fields,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(listOf("状态"), vm.uiState.value.mutationMessageFields)
        assertEquals(2, vm.uiState.value.mutationMessageCount)
    }

    @Test
    public fun `schema reload names a field whose type no longer matches the draft`() = runTest(dispatcher) {
        val defaultView = view("view-default")
        val first = record("record-1")
        val title = TabDataField(
            id = "field-title",
            tableId = "table-1",
            name = "标题",
            fieldType = "text",
            isPrimary = true,
        )
        val status = TabDataField(
            id = "field-status",
            tableId = "table-1",
            name = "状态",
            fieldType = "select",
        )
        stubInitial(listOf(defaultView), defaultViewId = defaultView.id)
        coEvery { repository.loadFields("table-1") } returnsMany listOf(
            listOf(title, status),
            listOf(title, status.copy(fieldType = "number")),
        )
        coEvery {
            repository.loadViewRecords(
                view = any(), page = any(), pageSize = any(), search = any(),
                filters = any<List<com.tabtin.mobile.data.model.tabdata.TabDataFilterRule>>(),
                filterLogic = any(), sorts = any(), groupOffsets = any(),
            )
        } returns TabDataViewRecordsResponse(records = listOf(first), total = 1, matchedTotal = 1)
        coEvery { repository.loadRecord(first.id) } returns first
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openRecord(first)
        advanceUntilIdle()
        vm.updateDraft(title, JsonPrimitive("标题还在改"))
        vm.updateDraft(status, JsonPrimitive("本地状态"))

        vm.handleTableEnvelope(
            tableStructureEnvelope(type = "table.events.field", action = "update_field"),
        )
        advanceUntilIdle()

        assertEquals(JsonPrimitive("标题还在改"), vm.uiState.value.detailDraft["标题"])
        // 字段还在，只是类型对不上：丢掉本地草稿，回落到 schema 初值，不阻塞其余字段。
        assertEquals(JsonNull, vm.uiState.value.detailDraft["状态"])
        assertFalse(vm.uiState.value.detailWriteBlocked)
        assertEquals(
            com.tabtin.mobile.R.string.tabdata_schema_dropped_field,
            vm.uiState.value.mutationMessageRes,
        )
        assertEquals(listOf("状态"), vm.uiState.value.mutationMessageFields)
        assertNull(vm.uiState.value.mutationMessageCount)
    }

    private fun tableStructureEnvelope(
        type: String,
        action: String,
        tableId: String = "table-1",
    ): WSEnvelope = WSEnvelope(
        type = type,
        payload = buildJsonObject {
            put("table_id", tableId)
            put("action", action)
            put("metadata", buildJsonObject { put("user_id", "user-1") })
        },
        tableId = tableId,
    )

    private fun tableDeltaEnvelope(
        action: String,
        recordIds: List<String>,
        records: List<TabDataRecord> = emptyList(),
        latestVersion: Long? = null,
        rlsAffected: Boolean = false,
        actorUserId: String = "user-2",
    ): WSEnvelope = WSEnvelope(
        type = "table.events.delta",
        payload = buildJsonObject {
            put("table_id", "table-1")
            put("action", action)
            put("record_ids", buildJsonArray { recordIds.forEach { add(JsonPrimitive(it)) } })
            if (records.isNotEmpty()) {
                put(
                    "records",
                    buildJsonArray {
                        records.forEach { record ->
                            add(
                                buildJsonObject {
                                    put("id", record.id)
                                    put("table_id", record.tableId ?: "table-1")
                                    record.version?.let { put("version", it) }
                                    put("fields", record.fields)
                                },
                            )
                        }
                    },
                )
            }
            latestVersion?.let { put("latest_version", it) }
            if (rlsAffected) put("rls_affected", true)
            put("metadata", buildJsonObject { put("user_id", actorUserId) })
        },
        tableId = "table-1",
    )

    private fun stubInitial(
        views: List<TabDataView>,
        defaultViewId: String,
        organizationId: String? = "org-1",
    ) {
        coEvery { repository.loadTable("table-1") } returns table(
            organizationId = organizationId,
            defaultViewId = defaultViewId,
        )
        coEvery { repository.loadViews("table-1") } returns views
        coEvery { repository.loadFields("table-1") } returns listOf(
            TabDataField(id = "field-title", tableId = "table-1", name = "标题", fieldType = "text", isPrimary = true),
        )
    }

    private fun newViewModel(): NativeTabDataViewModel = NativeTabDataViewModel(
        repository,
        draftStore,
        tokenManager,
        organizationRepository,
        memberDirectoryStore,
        webSocketService,
        SavedStateHandle(mapOf("resourceId" to "table-1", "organizationId" to "org-1")),
    )

    private fun table(
        name: String = "项目",
        organizationId: String? = "org-1",
        defaultViewId: String? = "view-default",
        currentUserRole: String? = "editor",
    ): TabDataTable = TabDataTable(
        id = "table-1",
        name = name,
        organizationId = organizationId,
        defaultViewId = defaultViewId,
        currentUserRole = currentUserRole,
    )

    private fun view(id: String, filterLogic: String = "and"): TabDataView = TabDataView(
        id = id,
        tableId = "table-1",
        name = id,
        viewType = "grid",
        config = JsonObject(mapOf("filter_logic" to JsonPrimitive(filterLogic))),
    )

    private fun record(id: String, version: Long = 1): TabDataRecord = TabDataRecord(
        id = id,
        tableId = "table-1",
        fields = JsonObject(mapOf("标题" to JsonPrimitive("原始"))),
        version = version,
    )
}
