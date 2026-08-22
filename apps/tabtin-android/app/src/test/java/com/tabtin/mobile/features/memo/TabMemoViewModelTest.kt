package com.tabtin.mobile.features.memo

import android.content.Context
import android.text.format.DateFormat
import android.util.Log
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.TabMemoApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.memo.MemoAppHomeFeatureFlags
import com.tabtin.mobile.data.model.memo.MemoCollectionListResponse
import com.tabtin.mobile.data.model.memo.MemoDetail
import com.tabtin.mobile.data.model.memo.MemoHeatmapResponse
import com.tabtin.mobile.data.model.memo.MemoListResponse
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TabMemoViewModelTest {

    private val context = mockk<Context>(relaxed = true)
    private val tabMemoApi = mockk<TabMemoApi>()
    private val dispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        mockkStatic(Log::class)
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any(), any<String>()) } returns 0
        every { Log.w(any(), any<String>(), any()) } returns 0
        every { Log.e(any(), any()) } returns 0
        every { Log.e(any(), any(), any()) } returns 0
        mockkStatic(DateFormat::class)
        every { DateFormat.getBestDateTimePattern(any(), any()) } returns "MMM d"
        every { context.getString(any()) } returns "err"
        every { context.getString(R.string.memo_today) } returns "Today"
        every { context.getString(R.string.memo_yesterday) } returns "Yesterday"
        every { context.getString(R.string.common_loading_failed) } returns "load failed"
        every { context.getString(R.string.memo_save_busy) } returns "save busy"
        every { context.getString(R.string.memo_send_failed) } returns "send failed"

        coEvery { tabMemoApi.listCollections(any(), any()) } returns ApiEnvelope(
            success = true,
            data = MemoCollectionListResponse(items = emptyList()),
        )
        coEvery { tabMemoApi.getHeatmap(any(), any()) } returns ApiEnvelope(
            success = true,
            data = MemoHeatmapResponse(buckets = emptyList(), days = 84),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
        unmockkStatic(DateFormat::class)
    }

    @Test
    fun `cancelOutstandingListRequests prevents stale list write-back`() = runTest(dispatcher) {
        val firstPage = CompletableDeferred<ApiEnvelope<MemoListResponse>>()
        coEvery {
            tabMemoApi.listMemos(
                organizationId = "org-a",
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } coAnswers { firstPage.await() }
        coEvery {
            tabMemoApi.listMemos(
                organizationId = "org-b",
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(
            MemoListResponse(
                items = listOf(memo("b-1")),
                nextCursor = "",
                hasMore = false,
            ),
        )

        val vm = newViewModel()
        vm.loadMemos("org-a", "", force = true)
        assertTrue(vm.uiState.value.isLoading)

        vm.cancelOutstandingListRequests()
        vm.loadMemos("org-b", "", force = true)
        advanceUntilIdle()

        assertEquals(listOf("b-1"), vm.uiState.value.memos.map { it.id })

        firstPage.complete(
            envelope(
                MemoListResponse(
                    items = listOf(memo("stale-a")),
                    nextCursor = "c1",
                    hasMore = true,
                ),
            ),
        )
        advanceUntilIdle()

        assertEquals(listOf("b-1"), vm.uiState.value.memos.map { it.id })
        assertFalse(vm.uiState.value.memos.any { it.id == "stale-a" })
    }

    @Test
    fun `loadMore reuses active list query snapshot including today bounds`() = runTest(dispatcher) {
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = null,
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(
            MemoListResponse(
                items = listOf(memo("m1")),
                nextCursor = "cursor-2",
                hasMore = true,
            ),
        )
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = "cursor-2",
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(
            MemoListResponse(
                items = listOf(memo("m2")),
                nextCursor = "",
                hasMore = false,
            ),
        )

        val vm = newViewModel()
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()
        vm.setViewKind(MemoViewKind.TODAY)
        advanceUntilIdle()

        val expected = MemoListQuerySnapshot.forView(
            organizationId = "org-1",
            spaceId = "",
            viewKind = MemoViewKind.TODAY,
            status = FilterStatus.ACTIVE.apiValue,
        )
        assertFalse(expected.createdAfter.isNullOrBlank())
        assertFalse(expected.createdBefore.isNullOrBlank())

        vm.loadMore()
        advanceUntilIdle()

        coVerify {
            tabMemoApi.listMemos(
                organizationId = "org-1",
                spaceId = null,
                status = "active",
                sort = "-created_at",
                limit = any(),
                cursor = "cursor-2",
                search = null,
                color = null,
                collectionId = null,
                memoType = "note,bookmark",
                tags = null,
                source = any(),
                createdAfter = expected.createdAfter,
                createdBefore = expected.createdBefore,
            )
        }
        assertEquals(listOf("m1", "m2"), vm.uiState.value.memos.map { it.id })
    }

    @Test
    fun `disabled diary flag blocks setViewKind and diary feed load`() = runTest(dispatcher) {
        assertFalse(MemoAppHomeFeatureFlags.IS_ORGANIZATION_AGENT_DIARY_ENABLED)
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(MemoListResponse(items = listOf(memo("m1")), hasMore = false))

        val vm = newViewModel()
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()
        assertEquals(MemoViewKind.ALL, vm.uiState.value.viewKind)

        vm.setViewKind(MemoViewKind.AGENT_DIARY)
        advanceUntilIdle()

        assertEquals(MemoViewKind.ALL, vm.uiState.value.viewKind)
        assertTrue(MemoViewKind.visibleKinds().none { it == MemoViewKind.AGENT_DIARY })
        coVerify(exactly = 0) { tabMemoApi.listOrgDiaryFeed(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `createMemo optimistically inserts then replaces with server memo`() = runTest(dispatcher) {
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(MemoListResponse(items = emptyList(), hasMore = false))
        coEvery { tabMemoApi.createMemo(any()) } returns envelope(
            MemoDetail(
                id = "server-1",
                contentPlaintext = "hello",
                contentMarkdown = "hello",
                createdAt = "2026-07-31T10:00:00Z",
                updatedAt = "2026-07-31T10:00:00Z",
            ),
        )

        val vm = newViewModel()
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()

        vm.createMemo(contentMarkdown = "hello")
        advanceUntilIdle()

        assertEquals(listOf("server-1"), vm.uiState.value.memos.map { it.id })
        assertFalse(vm.uiState.value.memos.any { it.id.startsWith("local-") })
        assertFalse(vm.uiState.value.createSaveBusy)
    }

    @Test
    fun `createMemoWithOptionalImage attachment failure keeps memoId for retry`() = runTest(dispatcher) {
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(MemoListResponse(items = emptyList(), hasMore = false))
        coEvery { tabMemoApi.createMemo(any()) } returns envelope(
            MemoDetail(
                id = "server-att",
                contentPlaintext = "with image",
                contentMarkdown = "with image",
                createdAt = "2026-07-31T10:00:00Z",
                updatedAt = "2026-07-31T10:00:00Z",
            ),
        )
        val oss = mockk<OSSUploadService>()
        coEvery {
            oss.directUploadFromUri(any(), any(), any(), any(), any(), any(), any())
        } throws RuntimeException("oss fail")
        every { context.getString(R.string.memo_attachment_upload_failed) } returns "att failed"

        val vm = TabMemoViewModel(
            context = context,
            tabMemoApi = tabMemoApi,
            ossUploadService = oss,
            webSocketService = mockk<WebSocketService>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true) {
                every { organizationId } returns "org-1"
            },
        )
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()

        val imageUri = mockk<android.net.Uri>(relaxed = true)
        vm.createMemoWithOptionalImage(
            contentMarkdown = "with image",
            imageUri = imageUri,
            imageFileName = "1.jpg",
            imageContentType = "image/jpeg",
            imageFileSize = 100L,
        )
        advanceUntilIdle()

        assertEquals("server-att", vm.uiState.value.pendingAttachmentMemoId)
        assertEquals(listOf("server-att"), vm.uiState.value.memos.map { it.id })
        assertFalse(vm.uiState.value.isCreating)
        assertFalse(vm.uiState.value.isUploadingAttachment)
        coVerify(exactly = 1) { tabMemoApi.createMemo(any()) }

        coEvery {
            oss.directUploadFromUri(any(), any(), any(), any(), any(), any(), any())
        } returns com.tabtin.mobile.data.api.UploadResult(
            fileId = "fr-1",
            accessUrl = "",
            fileName = "1.jpg",
        )
        coEvery { tabMemoApi.addAttachment("server-att", any()) } returns ApiEnvelope(
            success = true,
            data = com.tabtin.mobile.data.model.memo.AttachmentOut(
                id = "att-1",
                fileType = "image",
                fileName = "1.jpg",
            ),
        )

        vm.retryPendingImageAttachment(
            imageUri = imageUri,
            imageFileName = "1.jpg",
            imageContentType = "image/jpeg",
            imageFileSize = 100L,
        )
        advanceUntilIdle()

        assertEquals(null, vm.uiState.value.pendingAttachmentMemoId)
        coVerify(exactly = 1) { tabMemoApi.createMemo(any()) }
        coVerify(exactly = 1) { tabMemoApi.addAttachment("server-att", any()) }
    }

    @Test
    fun `createMemo SAVE_BUSY after retry sets createSaveBusy and drops optimistic row`() = runTest(dispatcher) {
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(MemoListResponse(items = emptyList(), hasMore = false))
        coEvery { tabMemoApi.createMemo(any()) } throws AppError.RequestFailed("busy", "SAVE_BUSY")

        val vm = newViewModel()
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()

        vm.createMemo(contentMarkdown = "draft body")
        advanceUntilIdle()

        assertTrue(vm.uiState.value.createSaveBusy)
        assertEquals("save busy", vm.uiState.value.loadError)
        assertTrue(vm.uiState.value.memos.none { it.id.startsWith("local-") })
        coVerify(atLeast = 2) { tabMemoApi.createMemo(any()) }
    }

    @Test
    fun `archive and trash hit distinct endpoints`() = runTest(dispatcher) {
        coEvery {
            tabMemoApi.listMemos(
                organizationId = any(),
                spaceId = any(),
                status = any(),
                sort = any(),
                limit = any(),
                cursor = any(),
                search = any(),
                color = any(),
                collectionId = any(),
                memoType = any(),
                tags = any(),
                source = any(),
                createdAfter = any(),
                createdBefore = any(),
            )
        } returns envelope(
            MemoListResponse(
                items = listOf(memo("a1"), memo("t1")),
                hasMore = false,
            ),
        )
        coEvery { tabMemoApi.archiveMemo("a1", any()) } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))
        coEvery { tabMemoApi.trashMemo("t1", any()) } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))

        val vm = newViewModel()
        vm.loadMemos("org-1", "", force = true)
        advanceUntilIdle()

        vm.archiveMemo("a1")
        advanceUntilIdle()
        assertTrue(vm.trashMemo("t1"))
        advanceUntilIdle()

        coVerify(exactly = 1) { tabMemoApi.archiveMemo("a1", any()) }
        coVerify(exactly = 1) { tabMemoApi.trashMemo("t1", any()) }
        coVerify(exactly = 0) { tabMemoApi.deleteMemo(any()) }
        coVerify(exactly = 0) { tabMemoApi.archiveMemo("t1", any()) }
        coVerify(exactly = 0) { tabMemoApi.trashMemo("a1", any()) }
        assertEquals(emptyList<String>(), vm.uiState.value.memos.map { it.id })
    }

    private fun newViewModel(): TabMemoViewModel = TabMemoViewModel(
        context = context,
        tabMemoApi = tabMemoApi,
        ossUploadService = mockk<OSSUploadService>(relaxed = true),
        webSocketService = mockk<WebSocketService>(relaxed = true),
        tokenManager = mockk<TokenManager>(relaxed = true),
    )

    private fun memo(id: String): MemoSummary = MemoSummary(
        id = id,
        contentPlaintext = "memo $id",
        createdAt = "2026-07-31T10:00:00Z",
        updatedAt = "2026-07-31T10:00:00Z",
    )

    private fun <T> envelope(data: T): ApiEnvelope<T> = ApiEnvelope(success = true, data = data)
}
