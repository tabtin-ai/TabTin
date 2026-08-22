package com.tabtin.mobile.features.doc

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.doc.CommentAnchor
import com.tabtin.mobile.data.model.doc.CommentMessage
import com.tabtin.mobile.data.model.doc.CommentThread
import com.tabtin.mobile.data.model.doc.CommentThreadListResponse
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocContent
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.features.doc.comment.DocCommentAnchorKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.util.TokenManager
import io.mockk.Runs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.slot
import io.mockk.unmockkStatic
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DocEditorViewModelCommentTest {

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
        every { Log.e(any(), any(), any()) } returns 0
        prefsStore = mutableMapOf()

        mockPrefsEditor = mockk(relaxed = true)
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

        mockContext = mockk(relaxed = true)
        every { mockContext.getSharedPreferences(any(), any()) } returns mockPrefs
        every { mockContext.getString(R.string.doc_comment_document) } returns "文档评论"
        every { mockContext.getString(R.string.doc_comment_block) } returns "块评论"
        every { mockContext.getString(R.string.doc_comment_orphaned) } returns "失联评论"
        every { mockContext.getString(R.string.doc_comment_anonymous) } returns "匿名"

        mockDocRepo = mockk(relaxed = true)
        mockTokenManager = mockk(relaxed = true)
        every { mockTokenManager.userId } returns "user-1"
        every { mockTokenManager.organizationId } returns "ws"
        every { mockTokenManager.isLoggedIn } returns true
        coEvery { mockDocRepo.listCommentThreads(any()) } returns CommentThreadListResponse()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    @Test
    fun `load projects existing block and document threads without using record ids as titles`() = runTest(testDispatcher) {
        val documentId = "doc-comments-1"
        stubDocument(
            documentId,
            content = paragraphDoc("pm-block-1", "第一段正文"),
            threads = listOf(
                thread(
                    id = "internal-thread-id",
                    scope = "block",
                    blockIds = listOf("pm-block-1"),
                    body = "块上已有评论",
                ),
                thread(
                    id = "internal-doc-thread",
                    scope = "document",
                    body = "文末已有评论",
                ),
            ),
        )

        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val presentations = vm.uiState.value.commentPresentations
        assertEquals(2, presentations.size)
        assertEquals(DocCommentAnchorKind.BLOCK, presentations[0].kind)
        assertEquals("第一段正文", presentations[0].title)
        assertFalse(presentations[0].title.contains("internal-thread-id"))
        assertEquals(DocCommentAnchorKind.DOCUMENT, presentations[1].kind)
        assertEquals("文档评论", presentations[1].title)
        assertFalse(presentations[1].title.contains("internal-doc-thread"))
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `successful document comment appears in the list`() = runTest(testDispatcher) {
        val documentId = "doc-comments-create"
        stubDocument(documentId, content = paragraphDoc("pm-block-1", "正文"))
        coEvery {
            mockDocRepo.createCommentThread(
                documentId = documentId,
                body = "文末一条",
                scope = "document",
                anchor = CommentAnchor(version = 1),
                selectedText = null,
            )
        } returns thread(
            id = "created-doc-thread",
            scope = "document",
            body = "文末一条",
            authorName = "Alice",
        )

        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        advanceUntilIdle()

        vm.createDocumentComment("文末一条")
        advanceUntilIdle()

        val created = vm.uiState.value.commentPresentations.single {
            it.threadId == "created-doc-thread"
        }
        assertEquals(DocCommentAnchorKind.DOCUMENT, created.kind)
        assertEquals("文末一条", created.body)
        assertFalse(created.title.contains("created-doc-thread"))
        coVerify(exactly = 1) {
            mockDocRepo.createCommentThread(
                documentId = documentId,
                body = "文末一条",
                scope = "document",
                anchor = CommentAnchor(version = 1),
                selectedText = null,
            )
        }
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `successful block comment uses persistent blockId and appears attached`() = runTest(testDispatcher) {
        val documentId = "doc-comments-block"
        stubDocument(documentId, content = paragraphDoc("pm-block-1", "第一段正文"))
        val anchorSlot = slot<CommentAnchor>()
        coEvery {
            mockDocRepo.createCommentThread(
                documentId = documentId,
                body = "块评",
                scope = "block",
                anchor = capture(anchorSlot),
                selectedText = any(),
            )
        } answers {
            thread(
                id = "created-block-thread",
                scope = "block",
                blockIds = anchorSlot.captured.blockIds,
                body = "块评",
            )
        }

        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val runtimeId = getBlocks(vm).single().id
        vm.createBlockComment(runtimeId, "块评")
        advanceUntilIdle()

        assertEquals(listOf("pm-block-1"), anchorSlot.captured.blockIds)
        assertEquals(1, anchorSlot.captured.version)
        val created = vm.uiState.value.commentPresentations.single {
            it.threadId == "created-block-thread"
        }
        assertEquals(DocCommentAnchorKind.BLOCK, created.kind)
        assertEquals("pm-block-1", created.matchedBlockId)
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `does not post comment when save state is conflict`() = runTest(testDispatcher) {
        val vm = createLoadedEditor("doc-comments-conflict")
        advanceUntilIdle()
        setUiState(vm) { it.copy(saveState = SaveState.CONFLICT) }

        vm.createDocumentComment("不该发出")
        advanceUntilIdle()

        coVerify(exactly = 0) {
            mockDocRepo.createCommentThread(any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `does not post comment when editor is read only by role`() = runTest(testDispatcher) {
        val documentId = "doc-comments-readonly"
        stubDocument(
            documentId,
            document = Doc(
                id = documentId,
                organizationId = "ws",
                spaceId = "sp",
                title = "只读",
                currentUserRole = "viewer",
            ),
            content = paragraphDoc("pm-block-1", "正文"),
        )

        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.isReadOnlyByRole)
        vm.createDocumentComment("不该发出")
        advanceUntilIdle()

        coVerify(exactly = 0) {
            mockDocRepo.createCommentThread(any(), any(), any(), any(), any())
        }
        assertTrue(vm.uiState.value.commentPresentations.isEmpty())
    }

    @Test
    fun `does not post comment when document requires full editor`() = runTest(testDispatcher) {
        val documentId = "doc-comments-full-editor"
        stubDocument(
            documentId,
            content = DocContent(
                descriptionJson = buildJsonObject {
                    put("type", "doc")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "htmlBlock")
                            put("attrs", JsonNull)
                        })
                    })
                },
            ),
        )

        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.requiresFullEditor)
        vm.createDocumentComment("不该发出")
        advanceUntilIdle()

        coVerify(exactly = 0) {
            mockDocRepo.createCommentThread(any(), any(), any(), any(), any())
        }
    }

    private fun createLoadedEditor(documentId: String): DocEditorViewModel {
        stubDocument(documentId, content = paragraphDoc("pm-block-1", "正文"))
        val vm = createVm(documentId)
        disablePermissionTimer(vm)
        return vm
    }

    private fun createVm(documentId: String): DocEditorViewModel {
        val mockStreamManager = mockk<StreamManager>(relaxed = true)
        every { mockStreamManager.currentPhase } returns MutableStateFlow(AgentPhase.IDLE)
        return DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager,
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to documentId, "organizationId" to "ws"),
            ),
            coroutineDispatcher = testDispatcher,
            ioDispatcher = testDispatcher,
        )
    }

    private fun stubDocument(
        documentId: String,
        document: Doc = Doc(
            id = documentId,
            organizationId = "ws",
            spaceId = "sp",
            title = "评论文档",
            currentUserRole = "editor",
        ),
        content: DocContent,
        threads: List<CommentThread> = emptyList(),
    ) {
        coEvery { mockDocRepo.getDocumentDetail(documentId) } returns DocDetailResponse(
            document = document,
            content = content,
        )
        coEvery { mockDocRepo.listCommentThreads(documentId) } returns CommentThreadListResponse(
            threads = threads,
            capabilities = listOf("comment_threads_v1"),
        )
    }

    private fun paragraphDoc(blockId: String, text: String): DocContent = DocContent(
        descriptionJson = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("attrs", buildJsonObject { put("blockId", blockId) })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", text)
                        })
                    })
                })
            })
        },
    )

    private fun thread(
        id: String,
        scope: String,
        body: String,
        blockIds: List<String> = emptyList(),
        authorName: String = "Alice",
    ): CommentThread = CommentThread(
        id = id,
        documentId = "doc-1",
        scope = scope,
        status = "open",
        anchor = CommentAnchor(version = 1, blockIds = blockIds),
        anchorStatus = if (scope == "document") "none" else "attached",
        messages = listOf(
            CommentMessage(
                id = "msg-$id",
                threadId = id,
                kind = "root",
                authorName = authorName,
                body = body,
            ),
        ),
    )

    private fun getBlocks(vm: DocEditorViewModel): List<DocBlock> {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(vm) as List<DocBlock>
    }

    private fun setUiState(
        vm: DocEditorViewModel,
        transform: (DocEditorViewModel.UiState) -> DocEditorViewModel.UiState,
    ) {
        val field = DocEditorViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val state = field.get(vm) as MutableStateFlow<DocEditorViewModel.UiState>
        state.value = transform(state.value)
    }

    private fun disablePermissionTimer(vm: DocEditorViewModel) {
        DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }.set(vm, mockk<Job>(relaxed = true))
    }
}
