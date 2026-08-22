package com.tabtin.mobile.features.doc

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocContent
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.TokenManager
import io.mockk.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * RV-002 回归测试：HTTP 403 权限撤销检测
 * 验证 DocEditorViewModel 对权限撤销的识别、状态转换和操作阻断。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DocEditorViewModelPermissionTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var mockDocRepo: DocRepository
    private lateinit var mockContext: Context
    private lateinit var mockTokenManager: TokenManager
    private lateinit var prefsStore: MutableMap<String, Any?>
    private lateinit var mockPrefsEditor: SharedPreferences.Editor

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockkStatic(Log::class)
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        prefsStore = mutableMapOf()

        mockPrefsEditor = mockk<SharedPreferences.Editor>(relaxed = true)
        every { mockPrefsEditor.putString(any(), any()) } answers {
            prefsStore[firstArg()] = secondArg<String?>(); mockPrefsEditor
        }
        every { mockPrefsEditor.putLong(any(), any()) } answers {
            prefsStore[firstArg()] = secondArg<Long>(); mockPrefsEditor
        }
        every { mockPrefsEditor.remove(any()) } answers {
            prefsStore.remove(firstArg()); mockPrefsEditor
        }
        every { mockPrefsEditor.commit() } answers { true }
        every { mockPrefsEditor.apply() } just Runs

        val mockPrefs = mockk<SharedPreferences>()
        every { mockPrefs.edit() } returns mockPrefsEditor
        every { mockPrefs.getString(any(), any()) } answers {
            prefsStore[firstArg()] as? String ?: secondArg()
        }
        every { mockPrefs.getLong(any(), any()) } answers {
            prefsStore[firstArg()] as? Long ?: secondArg()
        }

        mockContext = mockk<Context>(relaxed = true)
        every { mockContext.getSharedPreferences(any(), any()) } returns mockPrefs
        every { mockContext.getString(any()) } returns "Permission revoked"

        mockDocRepo = mockk<DocRepository>(relaxed = true)
        mockTokenManager = mockk(relaxed = true)
        every { mockTokenManager.userId } returns "user-1"
        every { mockTokenManager.organizationId } returns "ws"
        every { mockTokenManager.isLoggedIn } returns true
        // W A0.3.续：默认 stub `getDocumentDetail` 返回真实构造的 DocDetailResponse，
        // 避开 mockk relaxed 模式自动 mock 嵌套 data class 时触发 kotlin-reflect
        // 反射递归（W A0.3 反思 §5.1 jstack 抓栈实证 RV-002 500 hang 根因）。
        // 各 case 的特定 stub（如 `coEvery { ... "doc-perm-1" } throws 403`）
        // 通过精确参数匹配优先于本默认 stub，原行为不变。
        coEvery { mockDocRepo.getDocumentDetail(any()) } returns DocDetailResponse(
            document = Doc(id = "stub", organizationId = "ws", spaceId = "sp", title = "Stub"),
            content = editableEmptyDocContent(),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    private fun mockStreamManager(): StreamManager {
        val sm = mockk<StreamManager>(relaxed = true)
        every { sm.currentPhase } returns MutableStateFlow(AgentPhase.IDLE)
        return sm
    }

    private fun createVm(documentId: String = ""): DocEditorViewModel {
        if (documentId.isNotEmpty()) {
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns DocDetailResponse(
                document = Doc(
                    id = documentId, organizationId = "ws", spaceId = "sp", title = "Test"
                ),
                content = editableEmptyDocContent(),
            )
        }
        return DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager(),
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to documentId, "organizationId" to "ws"),
            ),
            // W A0.3.续7：注入 testDispatcher 让 ViewModel 内 withContext(coroutineDispatcher) 走
            // testDispatcher 调度，避免 Dispatchers.Default 真实线程池逃出 advanceTimeBy/advanceUntilIdle 控制。
            coroutineDispatcher = testDispatcher,
            // W D：ioDispatcher 同款注入。Permission 路径目前不走 IO，但 createVm helper 统一注入
            // 防御未来 onImagePicked 走入 Permission case 时 advanceUntilIdle 失控。
            ioDispatcher = testDispatcher,
        )
    }

    private fun injectBlocks(vm: DocEditorViewModel, blocks: List<DocBlock>) {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        field.set(vm, blocks.toMutableList())
    }

    private fun getBlocks(vm: DocEditorViewModel): List<DocBlock> {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(vm) as List<DocBlock>
    }

    private fun callOnCleared(vm: DocEditorViewModel) {
        val method = ViewModel::class.java.getDeclaredMethod("onCleared")
        method.isAccessible = true
        method.invoke(vm)
    }

    private fun draftKey(prefix: String, documentId: String): String =
        "${prefix}_${docDraftScope("user-1", "ws", documentId)}"

    private fun editableEmptyDocContent(): DocContent = DocContent(
        descriptionJson = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {})
        },
    )

    // W A0.3.续2：注入非 null mock Job 让 startPermissionCheckIfNeeded 走 early return（main:1181），
    // 阻断 viewModelScope.launch { while(true) { delay(60_000)... } } 让 advanceUntilIdle 不再 spin（详 W A0.3.续 反思 §3.2）。
    private fun disablePermissionTimer(vm: DocEditorViewModel) {
        DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }.set(vm, mockk<Job>(relaxed = true))
    }

    private fun make403(): HttpException {
        val body = "Forbidden".toResponseBody(null)
        return HttpException(Response.error<Any>(403, body))
    }

    // ── RV-002: 加载文档时 403 → 权限撤销 ──

    @Test
    fun `RV-002 load returns 403 transitions to PERMISSION_DENIED`() = runTest(testDispatcher) {
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-1") } throws make403()

        val vm = DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager(),
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to "doc-perm-1", "organizationId" to "ws"),
            ),
            coroutineDispatcher = testDispatcher,
            ioDispatcher = testDispatcher,
        )
        advanceUntilIdle()

        assertEquals(
            "SaveState should be PERMISSION_DENIED after 403 on load",
            SaveState.PERMISSION_DENIED,
            vm.uiState.value.saveState,
        )
        assertTrue(
            "isPermissionRevoked flag should be true",
            vm.uiState.value.isPermissionRevoked,
        )
        assertFalse(
            "isLoading should be false",
            vm.uiState.value.isLoading,
        )
        assertTrue(vm.uiState.value.blockViews.isEmpty())
        assertEquals("", vm.uiState.value.title)
    }

    // ── RV-002: 保存 403 先重查读取权，避免 editor→viewer 时丢草稿 ──

    @Test
    fun `save 403 with viewer detail preserves draft and becomes read only`() = runTest(testDispatcher) {
        val vm = createVm("doc-perm-2")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws make403()
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-2") } returns DocDetailResponse(
            document = Doc(
                id = "doc-perm-2",
                organizationId = "ws",
                title = "Server title",
                latestVersion = 2,
                currentUserRole = "viewer",
            ),
            content = editableEmptyDocContent(),
        )

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "will-get-403", emptyList())
        vm.onTitleChanged("Local draft title")
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertFalse(vm.uiState.value.isPermissionRevoked)
        assertTrue(vm.uiState.value.isReadOnlyByRole)
        assertEquals("Local draft title", vm.uiState.value.title)
        assertEquals("will-get-403", getBlocks(vm).single().text)
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", "doc-perm-2")))
    }

    @Test
    fun `save 403 downgrade persists original base and recreation never auto saves`() =
        runTest(testDispatcher) {
            val documentId = "doc-perm-recreate"
            val editorDetail = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Editor v1",
                    latestVersion = 1,
                    updatedAt = "2026-08-13T00:00:00Z",
                    currentUserRole = "editor",
                ),
                content = editableEmptyDocContent(),
            )
            val viewerDetail = DocDetailResponse(
                document = editorDetail.document.copy(
                    title = "Viewer v2",
                    latestVersion = 2,
                    updatedAt = "2026-08-13T00:01:00Z",
                    currentUserRole = "viewer",
                ),
                content = editableEmptyDocContent(),
            )
            var remote = editorDetail
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } throws make403()
            disablePermissionTimer(vm)
            runCurrent()

            val blockId = getBlocks(vm).single().id
            vm.onTextChanged(blockId, "local draft after downgrade", emptyList())
            remote = viewerDetail
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
            assertTrue(vm.uiState.value.isReadOnlyByRole)
            assertEquals(1L, prefsStore[draftKey("draft_base_version", documentId)])
            assertEquals(
                "2026-08-13T00:00:00Z",
                prefsStore[draftKey("draft_base_updated_at", documentId)],
            )

            callOnCleared(vm)
            clearMocks(mockDocRepo, recordedCalls = true, answers = false)
            val recreated = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns viewerDetail
            disablePermissionTimer(recreated)
            runCurrent()
            advanceTimeBy(2_000)
            runCurrent()

            assertEquals("local draft after downgrade", getBlocks(recreated).single().text)
            assertEquals(SaveState.CONFLICT, recreated.uiState.value.saveState)
            assertTrue(recreated.uiState.value.isReadOnlyByRole)
            coVerify(exactly = 0) {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            }
        }

    // ── RV-002: 权限撤销后不再重试保存 ──

    @Test
    fun `RV-002 permission denied does not trigger save retry`() = runTest(testDispatcher) {
        val vm = createVm("doc-perm-3")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        var saveCount = 0
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } answers {
            saveCount++
            throw make403()
        }
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-3") } returns DocDetailResponse(
            document = Doc(
                id = "doc-perm-3",
                organizationId = "ws",
                title = "Viewer",
                currentUserRole = "viewer",
            ),
            content = editableEmptyDocContent(),
        )

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "no-retry-after-403", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertEquals(1, saveCount)

        advanceTimeBy(DocEditorViewModel.INITIAL_RETRY_DELAY_MS * 4)
        assertEquals(
            "No additional save attempts should occur after permission denied",
            1,
            saveCount,
        )
    }

    // ── RV-002: 写失败后读取也被拒绝，才撤销并清理 ──

    @Test
    fun `RV-002 subsequent saves blocked after permission revoked`() = runTest(testDispatcher) {
        val vm = createVm("doc-perm-4")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws make403()
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-4") } throws make403()

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "trigger-403", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()
        assertTrue(vm.uiState.value.isPermissionRevoked)

        clearMocks(mockDocRepo, answers = false)
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } returns mockk(relaxed = true)

        vm.saveDocument()
        advanceUntilIdle()

        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    // ── RV-002: 权限撤销后 reload 被阻断 ──

    @Test
    fun `RV-002 reload blocked after permission revoked`() = runTest(testDispatcher) {
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-5") } throws make403()

        val vm = DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager(),
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to "doc-perm-5", "organizationId" to "ws"),
            ),
            coroutineDispatcher = testDispatcher,
            ioDispatcher = testDispatcher,
        )
        advanceUntilIdle()
        assertTrue(vm.uiState.value.isPermissionRevoked)

        clearMocks(mockDocRepo, answers = false)
        coEvery { mockDocRepo.getDocumentDetail("doc-perm-5") } returns DocDetailResponse(
            document = Doc(id = "doc-perm-5", organizationId = "ws", spaceId = "sp", title = "T"),
            content = DocContent(),
        )

        vm.reload()
        advanceUntilIdle()

        coVerify(exactly = 0) { mockDocRepo.getDocumentDetail("doc-perm-5") }
    }

    // ── RV-002: 定时权限检查常量验证 ──

    @Test
    fun `RV-002 permission check interval is 60 seconds`() {
        assertEquals(60_000L, DocEditorViewModel.PERMISSION_CHECK_INTERVAL_MS)
    }

    // ── RV-002: 普通 500 错误不触发权限撤销 ──

    @Test
    fun `RV-002 500 error does not trigger permission revoked`() = runTest(testDispatcher) {
        val vm = createVm("doc-perm-6")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val body = "Internal Server Error".toResponseBody(null)
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            HttpException(Response.error<Any>(500, body))

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "server-error", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertFalse(
            "isPermissionRevoked should remain false for non-403 errors",
            vm.uiState.value.isPermissionRevoked,
        )
        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)
    }

    // ── RV-002: PERMISSION_DENIED SaveState 枚举值存在 ──

    @Test
    fun `RV-002 PERMISSION_DENIED enum value exists and is distinct`() {
        val denied = SaveState.PERMISSION_DENIED
        assertNotEquals(SaveState.IDLE, denied)
        assertNotEquals(SaveState.DIRTY, denied)
        assertNotEquals(SaveState.SAVING, denied)
        assertNotEquals(SaveState.SAVED, denied)
        assertNotEquals(SaveState.FAILED, denied)
        assertNotEquals(SaveState.CONFLICT, denied)
    }

    // ── RV-002: 定时权限检查检测到 403 触发撤销 ──

    @Test
    fun `RV-002 periodic permission check detects 403 and revokes`() = runTest(testDispatcher) {
        val vm = createVm("doc-perm-7")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isPermissionRevoked)

        coEvery { mockDocRepo.getDocumentDetail("doc-perm-7") } throws make403()

        // W A0.3.续2：清 mockJob 后反射调 private startPermissionCheckIfNeeded 真启 timer；
        // 第一次 tick 检测 403 → handlePermissionRevoked → cancel + return@launch → loop 终止 → idle。
        val jobField = DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }
        jobField.set(vm, null)
        DocEditorViewModel::class.java.getDeclaredMethod("startPermissionCheckIfNeeded")
            .apply { isAccessible = true }.invoke(vm)
        runCurrent()

        advanceTimeBy(DocEditorViewModel.PERMISSION_CHECK_INTERVAL_MS + 100)
        advanceUntilIdle()

        assertTrue(
            "Permission should be revoked after periodic check detects 403",
            vm.uiState.value.isPermissionRevoked,
        )
        assertEquals(SaveState.PERMISSION_DENIED, vm.uiState.value.saveState)
    }

    @Test
    fun `web return editor downgrade immediately makes native document read only`() = runTest(testDispatcher) {
        val documentId = "doc-web-downgrade"
        var detail = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Editable",
                latestVersion = 1,
                currentUserRole = "editor",
            ),
            content = editableEmptyDocContent(),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { detail }
        disablePermissionTimer(vm)
        runCurrent()

        detail = detail.copy(
            document = detail.document.copy(
                title = "Viewer copy",
                latestVersion = 2,
                currentUserRole = "viewer",
            ),
        )
        vm.refreshOnResume()
        runCurrent()

        assertTrue(vm.uiState.value.isReadOnlyByRole)
        assertEquals("Viewer copy", vm.uiState.value.title)
        vm.onTitleChanged("Must not edit")
        vm.saveDocument()
        runCurrent()

        assertEquals("Viewer copy", vm.uiState.value.title)
        coVerify(exactly = 0) {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `periodic permission check applies viewer downgrade without waiting for 403`() = runTest(testDispatcher) {
        val documentId = "doc-periodic-downgrade"
        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        runCurrent()
        coEvery { mockDocRepo.getDocumentDetail(documentId) } returns DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Read only",
                latestVersion = 2,
                currentUserRole = "viewer",
            ),
            content = editableEmptyDocContent(),
        )

        val jobField = DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }
        jobField.set(vm, null)
        DocEditorViewModel::class.java.getDeclaredMethod("startPermissionCheckIfNeeded")
            .apply { isAccessible = true }.invoke(vm)
        runCurrent()
        advanceTimeBy(DocEditorViewModel.PERMISSION_CHECK_INTERVAL_MS + 100)
        runCurrent()

        assertTrue(vm.uiState.value.isReadOnlyByRole)
        assertFalse(vm.uiState.value.isPermissionRevoked)
        assertEquals("Read only", vm.uiState.value.title)
        jobField.get(vm).let { it as? Job }?.cancel()
    }

    @Test
    fun `periodic permission check revokes stale editor after organization switch`() = runTest(testDispatcher) {
        var activeOrganizationId = "ws"
        every { mockTokenManager.organizationId } answers { activeOrganizationId }
        val vm = createVm("doc-org-switched")
        disablePermissionTimer(vm)
        advanceUntilIdle()
        assertFalse(vm.uiState.value.isPermissionRevoked)

        activeOrganizationId = "other-org"
        val jobField = DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }
        jobField.set(vm, null)
        DocEditorViewModel::class.java.getDeclaredMethod("startPermissionCheckIfNeeded")
            .apply { isAccessible = true }.invoke(vm)
        runCurrent()

        advanceTimeBy(DocEditorViewModel.PERMISSION_CHECK_INTERVAL_MS + 100)
        runCurrent()

        assertTrue(vm.uiState.value.isPermissionRevoked)
        assertEquals(SaveState.PERMISSION_DENIED, vm.uiState.value.saveState)
        assertTrue(vm.uiState.value.blockViews.isEmpty())
    }

    @Test
    fun `organization switch immediately blocks edits and save requests`() = runTest(testDispatcher) {
        var activeOrganizationId = "ws"
        every { mockTokenManager.organizationId } answers { activeOrganizationId }
        val vm = createVm("doc-org-edit-blocked")
        disablePermissionTimer(vm)
        advanceUntilIdle()
        clearMocks(mockDocRepo, answers = false)

        activeOrganizationId = "other-org"
        vm.onTitleChanged("Must not leak")
        vm.saveDocument()
        runCurrent()

        assertTrue(vm.uiState.value.isPermissionRevoked)
        assertEquals(SaveState.PERMISSION_DENIED, vm.uiState.value.saveState)
        assertEquals("", vm.uiState.value.title)
        assertTrue(vm.uiState.value.blockViews.isEmpty())
        coVerify(exactly = 0) {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `cross organization response fails closed and clears document state`() = runTest(testDispatcher) {
        coEvery { mockDocRepo.getDocumentDetail("doc-cross-org") } returns DocDetailResponse(
            document = Doc(
                id = "doc-cross-org",
                organizationId = "other-org",
                title = "Secret",
            ),
            content = DocContent(),
        )
        val vm = DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager(),
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to "doc-cross-org", "organizationId" to "ws"),
            ),
            coroutineDispatcher = testDispatcher,
            ioDispatcher = testDispatcher,
        )
        advanceUntilIdle()

        assertTrue(vm.uiState.value.isPermissionRevoked)
        assertEquals(SaveState.PERMISSION_DENIED, vm.uiState.value.saveState)
        assertEquals("", vm.uiState.value.title)
        assertTrue(vm.uiState.value.blockViews.isEmpty())
    }

    @Test
    fun `same organization detail for another document is rejected without creating a draft`() =
        runTest(testDispatcher) {
            val routeDocumentId = "doc-route"
            coEvery { mockDocRepo.getDocumentDetail(routeDocumentId) } returns DocDetailResponse(
                document = Doc(
                    id = "doc-from-another-response",
                    organizationId = "ws",
                    title = "Wrong document",
                ),
                content = editableEmptyDocContent(),
            )
            val vm = DocEditorViewModel(
                docRepository = mockDocRepo,
                ossUploadService = mockk<OSSUploadService>(relaxed = true),
                tokenManager = mockTokenManager,
                streamManager = mockStreamManager(),
                appContext = mockContext,
                savedStateHandle = SavedStateHandle(
                    mapOf("documentId" to routeDocumentId, "organizationId" to "ws"),
                ),
                coroutineDispatcher = testDispatcher,
                ioDispatcher = testDispatcher,
            )
            advanceUntilIdle()

            assertFalse(vm.uiState.value.isPermissionRevoked)
            assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
            assertEquals("", vm.uiState.value.title)
            assertTrue(vm.uiState.value.blockViews.isEmpty())
            assertTrue(prefsStore.isEmpty())
        }
}
