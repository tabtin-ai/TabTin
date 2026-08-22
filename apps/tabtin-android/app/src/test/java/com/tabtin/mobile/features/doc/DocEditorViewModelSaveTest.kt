package com.tabtin.mobile.features.doc

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocContent
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.model.doc.SaveContentResponse
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.TokenManager
import io.mockk.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * 回归测试：CR-001 (onCleared 数据丢失)、CR-006 (草稿持久化)、CR-007 (保存失败重试)
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DocEditorViewModelSaveTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var mockDocRepo: DocRepository
    private lateinit var mockContext: Context
    private lateinit var mockTokenManager: TokenManager
    private lateinit var prefsStore: MutableMap<String, Any?>
    private lateinit var mockPrefsEditor: SharedPreferences.Editor

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        // W A0.3.续4：unit test JVM 没有 Android framework，未 mock 时 Log.d/w/e 抛
        // RuntimeException("Method X in android.util.Log not mocked!")，被 checkAndRestoreDraft
        // 内 catch (Exception) (main:484) 静默吞掉，导致 _uiState.update title (main:479-481)
        // 在 Log.d (main:478) 异常前被跳过 → fail #2 真因（详 W A0.3.续3 反思 §3.2 + §9.4
        // 探针实证；行号已对齐 W A0.3.续4 加 clearDraft 内 cancel 6 行后的后移基线）。
        mockkStatic(Log::class)
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.e(any(), any(), any()) } returns 0
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

        mockDocRepo = mockk<DocRepository>(relaxed = true)
        mockTokenManager = mockk(relaxed = true)
        every { mockTokenManager.userId } returns "user-1"
        every { mockTokenManager.organizationId } returns "ws"
        every { mockTokenManager.isLoggedIn } returns true
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    private fun createVm(
        documentId: String = "",
        initialContent: DocContent? = null,
    ): DocEditorViewModel {
        if (documentId.isNotEmpty()) {
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns DocDetailResponse(
                document = Doc(
                    id = documentId, organizationId = "ws", spaceId = "sp", title = "Test"
                ),
                content = initialContent ?: editableEmptyDocContent(),
            )
        }
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
            // W A0.3.续7：注入 testDispatcher 让 ViewModel 的 saveIfNeeded/loadDocument/checkAndRestoreDraft
            // 内 withContext(coroutineDispatcher) 走 testDispatcher 调度，避免 Dispatchers.Default 真实
            // 线程池逃出 advanceTimeBy/advanceUntilIdle 控制；同时让 mockkStatic(Log) 在 testDispatcher
            // thread 上保持有效（Default 线程池 mockkStatic thread-confined 限制）。
            coroutineDispatcher = testDispatcher,
            // W D：ioDispatcher 同款注入。Save 路径目前不走 IO，但 createVm helper 统一注入
            // 防御未来 onImagePicked 走入 Save case 时 advanceUntilIdle 失控。
            ioDispatcher = testDispatcher,
        )
    }

    private fun createVmFromNativeRoute(documentId: String): DocEditorViewModel {
        coEvery { mockDocRepo.getDocumentDetail(documentId) } returns DocDetailResponse(
            document = Doc(
                id = documentId, organizationId = "ws", spaceId = "sp", title = "Native route",
            ),
            content = editableEmptyDocContent(),
        )
        val mockStreamManager = mockk<StreamManager>(relaxed = true)
        every { mockStreamManager.currentPhase } returns MutableStateFlow(AgentPhase.IDLE)
        return DocEditorViewModel(
            docRepository = mockDocRepo,
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager,
            appContext = mockContext,
            savedStateHandle = SavedStateHandle(
                mapOf("resourceId" to documentId, "organizationId" to "ws"),
            ),
            coroutineDispatcher = testDispatcher,
            ioDispatcher = testDispatcher,
        )
    }

    private fun injectBlocks(vm: DocEditorViewModel, blocks: List<DocBlock>) {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        field.set(vm, blocks.toMutableList())
    }

    private fun editableEmptyDocContent(): DocContent = DocContent(
        descriptionJson = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {})
        },
    )

    private fun editableTextDocContent(blockId: String?, text: String): DocContent = DocContent(
        descriptionJson = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    if (blockId != null) {
                        put("attrs", buildJsonObject { put("blockId", blockId) })
                    }
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

    private fun paragraphNode(blockId: String?, text: String): JsonObject = buildJsonObject {
        put("type", "paragraph")
        if (blockId != null) put("attrs", buildJsonObject { put("blockId", blockId) })
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "text")
                put("text", text)
            })
        })
    }

    private fun headingNode(blockId: String?, text: String): JsonObject = buildJsonObject {
        put("type", "heading")
        put("attrs", buildJsonObject {
            put("level", 2)
            if (blockId != null) put("blockId", blockId)
        })
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "text")
                put("text", text)
            })
        })
    }

    private fun documentContent(vararg nodes: JsonObject): DocContent = DocContent(
        descriptionJson = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray { nodes.forEach(::add) })
        },
    )

    private fun draftKey(prefix: String, documentId: String): String =
        "${prefix}_${docDraftScope("user-1", "ws", documentId)}"

    // W A0.3.续3：复用 PermissionTest helper（line 129-134），注入非 null mock Job 让
    // startPermissionCheckIfNeeded 走 early return（main:1181），阻断 viewModelScope.launch {
    // while(true) { delay(60_000)... } } 让 advanceUntilIdle 不再 spin（详 W A0.3.续 反思 §3.2）。
    private fun disablePermissionTimer(vm: DocEditorViewModel) {
        DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }.set(vm, mockk<Job>(relaxed = true))
    }

    private fun getBlocks(vm: DocEditorViewModel): List<DocBlock> {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(vm) as List<DocBlock>
    }

    private fun getRetryCount(vm: DocEditorViewModel): Int {
        val field = DocEditorViewModel::class.java.getDeclaredField("retryCount")
        field.isAccessible = true
        return field.getInt(vm)
    }

    private fun getFocusedBlockId(vm: DocEditorViewModel): String? {
        val field = DocEditorViewModel::class.java.getDeclaredField("focusedBlockId")
        field.isAccessible = true
        return field.get(vm) as String?
    }

    private enum class ConcurrentResponseMutation {
        ADD_RAW,
        DELETE_BLOCK,
        REORDER_BLOCKS,
        CHANGE_KIND,
    }

    private fun assertConcurrentStructuralResponseConflicts(mutation: ConcurrentResponseMutation) =
        runTest(testDispatcher) {
            val documentId = "doc-concurrent-${mutation.name.lowercase()}"
            val first = paragraphNode("stable-a", "initial a")
            val second = paragraphNode("stable-b", "initial b")
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Concurrent response",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = documentContent(first, second),
            )
            val firstRequestStarted = CompletableDeferred<Unit>()
            val releaseResponse = CompletableDeferred<Unit>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requestCount += 1
                if (requestCount == 1) {
                    firstRequestStarted.complete(Unit)
                    releaseResponse.await()
                    val savedFirst = paragraphNode("stable-a", "saved a")
                    val remoteNodes = when (mutation) {
                        ConcurrentResponseMutation.ADD_RAW -> arrayOf(
                            savedFirst,
                            second,
                            buildJsonObject {
                                put("type", "futureWidget")
                                put("attrs", buildJsonObject { put("futureKey", "preserve") })
                            },
                        )
                        ConcurrentResponseMutation.DELETE_BLOCK -> arrayOf(savedFirst)
                        ConcurrentResponseMutation.REORDER_BLOCKS -> arrayOf(second, savedFirst)
                        ConcurrentResponseMutation.CHANGE_KIND -> arrayOf(
                            headingNode("stable-a", "saved a"),
                            second,
                        )
                    }
                    SaveContentResponse(
                        document = initial.document.copy(latestVersion = 2),
                        content = documentContent(*remoteNodes),
                    )
                } else {
                    SaveContentResponse(document = initial.document.copy(latestVersion = 3))
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            val firstRuntimeId = getBlocks(vm).first().id
            vm.onTextChanged(firstRuntimeId, "saved a", emptyList())
            advanceTimeBy(1_200)
            runCurrent()
            assertTrue(firstRequestStarted.isCompleted)

            vm.onTextChanged(firstRuntimeId, "newer local a", emptyList())
            releaseResponse.complete(Unit)
            runCurrent()
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(1, requestCount)
            assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
            assertEquals(listOf("newer local a", "initial b"), getBlocks(vm).map(DocBlock::text))
            assertTrue(prefsStore.containsKey(draftKey("draft_blocks", documentId)))
        }

    private fun callOnCleared(vm: DocEditorViewModel) {
        val method = ViewModel::class.java.getDeclaredMethod("onCleared")
        method.isAccessible = true
        method.invoke(vm)
    }

    @Test
    fun `html block with incomplete attrs falls back without failing`() = runTest(testDispatcher) {
        val documentId = "doc-html-only"
        val vm = createVm(
            documentId = documentId,
            initialContent = DocContent(
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
        disablePermissionTimer(vm)

        advanceUntilIdle()

        assertNull(vm.uiState.value.errorRes)
        assertFalse(vm.uiState.value.isLoading)
        assertTrue(vm.uiState.value.requiresFullEditor)
        val block = getBlocks(vm).single()
        assertEquals(BlockKind.UNSUPPORTED, block.kind)
        assertEquals("htmlBlock", block.unsupportedType)
        assertTrue(block.rawNode?.containsKey("attrs") == true)
        assertNull(block.rawNode?.get("attrs"))
        assertEquals(1, vm.uiState.value.blockViews.size)
    }

    // ── CR-001: onCleared 必须持久化未保存数据 ──

    @Test
    fun `draft scope isolates user organization and rejects missing identity`() {
        val base = docDraftScope("user-1", "org-1", "doc-1")

        assertNotEquals(base, docDraftScope("user-2", "org-1", "doc-1"))
        assertNotEquals(base, docDraftScope("user-1", "org-2", "doc-1"))
        assertNotEquals(
            docDraftScope("a_b", "c", "doc-1"),
            docDraftScope("a", "b_c", "doc-1"),
        )
        assertNull(docDraftScope(null, "org-1", "doc-1"))
        assertNull(docDraftScope("user-1", null, "doc-1"))
    }

    @Test
    fun `draft from another user is never restored for the same document`() = runTest(testDispatcher) {
        val draftBlock = DocBlock(
            id = "foreign",
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("another user's draft")),
        )
        val foreignScope = requireNotNull(docDraftScope("user-1", "ws", "doc-shared"))
        prefsStore["draft_blocks_$foreignScope"] = ProseMirrorParser.serializeBlocks(listOf(draftBlock)).toString()
        prefsStore["draft_title_$foreignScope"] = "Foreign draft"
        prefsStore["draft_ts_$foreignScope"] = System.currentTimeMillis()
        every { mockTokenManager.userId } returns "user-2"

        val vm = createVm("doc-shared")
        disablePermissionTimer(vm)
        runCurrent()

        assertEquals("Test", vm.uiState.value.title)
        assertTrue(getBlocks(vm).none { it.text == "another user's draft" })
    }

    @Test
    fun `missing user identity disables draft persistence`() = runTest(testDispatcher) {
        every { mockTokenManager.userId } returns null
        val vm = createVm("doc-no-user")
        disablePermissionTimer(vm)
        advanceUntilIdle()
        injectBlocks(
            vm,
            listOf(
                DocBlock(
                    id = "b1",
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan("text")),
                ),
            ),
        )
        vm.onTextChanged("b1", "private draft", emptyList())
        advanceTimeBy(100)

        callOnCleared(vm)

        verify(exactly = 0) { mockPrefsEditor.commit() }
        assertTrue(prefsStore.isEmpty())
    }

    @Test
    fun `native cloud route resourceId loads the requested document`() = runTest(testDispatcher) {
        val vm = createVmFromNativeRoute("doc-native-route")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        assertEquals("doc-native-route", vm.uiState.value.documentId)
        assertEquals("Native route", vm.uiState.value.title)
        coVerify(exactly = 1) { mockDocRepo.getDocumentDetail("doc-native-route") }
    }

    @Test
    fun `editing content preserves the remote document envelope on save`() = runTest(testDispatcher) {
        val documentId = "doc-envelope"
        val source = buildJsonObject {
            put("type", "tabtinDocV2")
            put("attrs", buildJsonObject {
                put("layout", "wide")
                put("schemaVersion", 2)
            })
            put("futureKey", buildJsonObject { put("mode", "tracked") })
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", "before")
                        })
                    })
                })
            })
        }
        val savedJson = slot<JsonObject>()
        coEvery {
            mockDocRepo.saveContent(
                documentId,
                capture(savedJson),
                any(),
                any(),
                any(),
                any(),
                any(),
            )
        } returns SaveContentResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Test",
                latestVersion = 1,
            ),
        )
        val vm = createVm(documentId, DocContent(descriptionJson = source))
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "after", emptyList())
        advanceTimeBy(1_300)
        runCurrent()

        val expected = buildJsonObject {
            source.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", "after")
                        })
                    })
                })
            })
        }
        assertEquals(expected, savedJson.captured)
    }

    @Test
    fun `successful normalized response becomes the envelope and identity source for the next save`() =
        runTest(testDispatcher) {
            val documentId = "doc-success-normalized"
            val initialJson = buildJsonObject {
                put("type", "doc")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "paragraph")
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "text")
                                put("text", "initial")
                            })
                        })
                    })
                })
            }
            val normalizedJson = buildJsonObject {
                put("type", "tabtinDocV2")
                put("serverEnvelope", buildJsonObject { put("schemaRevision", 8) })
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "paragraph")
                        put("attrs", buildJsonObject {
                            put("blockId", "server-stable-block")
                            put("textAlign", JsonNull)
                        })
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "text")
                                put("text", "first save")
                            })
                        })
                    })
                })
            }
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Normalized",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = DocContent(descriptionJson = initialJson),
            )
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                if (requestCount == 1) {
                    SaveContentResponse(
                        document = initial.document.copy(latestVersion = 2),
                        content = DocContent(descriptionJson = normalizedJson),
                    )
                } else {
                    SaveContentResponse(document = initial.document.copy(latestVersion = 3))
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "first save", emptyList())
            advanceTimeBy(1_300)
            runCurrent()
            assertEquals("server-stable-block", getBlocks(vm).single().blockId)

            vm.onTextChanged(getBlocks(vm).single().id, "second save", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            val secondRequest = requests[1]
            assertEquals("tabtinDocV2", secondRequest.getValue("type").jsonPrimitive.content)
            assertEquals(normalizedJson["serverEnvelope"], secondRequest["serverEnvelope"])
            val paragraph = secondRequest.getValue("content").jsonArray.single().jsonObject
            assertEquals(
                "server-stable-block",
                paragraph.getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
            assertEquals(
                "second save",
                paragraph.getValue("content").jsonArray.single().jsonObject
                    .getValue("text").jsonPrimitive.content,
            )
        }

    @Test
    fun `concurrent edit rejects successful response that adds an opaque block`() =
        assertConcurrentStructuralResponseConflicts(ConcurrentResponseMutation.ADD_RAW)

    @Test
    fun `concurrent edit rejects successful response that deletes a block`() =
        assertConcurrentStructuralResponseConflicts(ConcurrentResponseMutation.DELETE_BLOCK)

    @Test
    fun `concurrent edit rejects successful response that reorders blocks`() =
        assertConcurrentStructuralResponseConflicts(ConcurrentResponseMutation.REORDER_BLOCKS)

    @Test
    fun `concurrent edit rejects successful response that changes block kind`() =
        assertConcurrentStructuralResponseConflicts(ConcurrentResponseMutation.CHANGE_KIND)

    @Test
    fun `successful identity normalization is retained by undo and the next save`() =
        runTest(testDispatcher) {
            val documentId = "doc-success-identity-undo"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Undo identity",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "initial"),
            )
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                if (requestCount == 1) {
                    SaveContentResponse(
                        document = initial.document.copy(latestVersion = 2),
                        content = editableTextDocContent("server-stable", "edited"),
                    )
                } else {
                    SaveContentResponse(document = initial.document.copy(latestVersion = 3))
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "edited", emptyList())
            advanceTimeBy(1_300)
            runCurrent()
            assertEquals("server-stable", getBlocks(vm).single().blockId)

            vm.undo()
            assertEquals("initial", getBlocks(vm).single().text)
            assertEquals("server-stable", getBlocks(vm).single().blockId)
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(2, requests.size)
            assertEquals(
                "server-stable",
                requests[1].getValue("content").jsonArray.single().jsonObject
                    .getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
        }

    @Test
    fun `authoritative response preserves focus through preinsert and reorder`() =
        runTest(testDispatcher) {
            val documentId = "doc-response-focus-reorder"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Focus reorder",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = documentContent(
                    paragraphNode("stable-a", "initial a"),
                    paragraphNode(null, "initial b"),
                ),
            )
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } returns SaveContentResponse(
                document = initial.document.copy(latestVersion = 2),
                content = documentContent(
                    buildJsonObject {
                        put("type", "futureWidget")
                        put("attrs", buildJsonObject { put("futureKey", "server") })
                    },
                    paragraphNode("server-b", "initial b"),
                    paragraphNode("stable-a", "saved a"),
                ),
            )
            disablePermissionTimer(vm)
            runCurrent()

            val initialBlocks = getBlocks(vm)
            val aRuntimeId = initialBlocks[0].id
            val bRuntimeId = initialBlocks[1].id
            vm.onFocusChanged(bRuntimeId)
            vm.onTextChanged(aRuntimeId, "saved a", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(listOf("", "initial b", "saved a"), getBlocks(vm).map(DocBlock::text))
            assertEquals(bRuntimeId, getBlocks(vm)[1].id)
            assertEquals(aRuntimeId, getBlocks(vm)[2].id)
            assertEquals(bRuntimeId, getFocusedBlockId(vm))
        }

    @Test
    fun `authoritative deletion clears focus instead of jumping to the first block`() =
        runTest(testDispatcher) {
            val documentId = "doc-response-focus-delete"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Focus delete",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = documentContent(
                    paragraphNode("stable-a", "initial a"),
                    paragraphNode("stable-b", "initial b"),
                ),
            )
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } returns SaveContentResponse(
                document = initial.document.copy(latestVersion = 2),
                content = documentContent(paragraphNode("stable-a", "saved a")),
            )
            disablePermissionTimer(vm)
            runCurrent()

            val initialBlocks = getBlocks(vm)
            vm.onFocusChanged(initialBlocks[1].id)
            vm.onTextChanged(initialBlocks[0].id, "saved a", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(listOf("saved a"), getBlocks(vm).map(DocBlock::text))
            assertNull(getFocusedBlockId(vm))
        }

    @Test
    fun `web return refresh replaces clean native content title and version`() = runTest(testDispatcher) {
        val documentId = "doc-web-clean"
        var detail = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Before Web",
                latestVersion = 1,
                updatedAt = "2026-08-13T00:00:00Z",
                currentUserRole = "editor",
            ),
            content = editableTextDocContent("b1", "old body"),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { detail }
        disablePermissionTimer(vm)
        runCurrent()

        detail = DocDetailResponse(
            document = detail.document.copy(
                title = "Changed on Web",
                latestVersion = 2,
                updatedAt = "2026-08-13T00:01:00Z",
            ),
            content = editableTextDocContent("b2", "new body"),
        )
        vm.refreshOnResume()
        runCurrent()

        assertEquals("Changed on Web", vm.uiState.value.title)
        assertEquals("new body", getBlocks(vm).single().text)
        assertEquals(2, getDocument(vm)?.latestVersion)
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
    }

    @Test
    fun `web return keeps dirty draft and enters conflict when remote version changed`() = runTest(testDispatcher) {
        val documentId = "doc-web-dirty"
        var detail = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Server v1",
                latestVersion = 1,
                updatedAt = "2026-08-13T00:00:00Z",
                currentUserRole = "editor",
            ),
            content = editableTextDocContent("b1", "server v1"),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { detail }
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "local draft", emptyList())
        vm.onTitleChanged("Local title")
        detail = DocDetailResponse(
            document = detail.document.copy(
                title = "Server v2",
                latestVersion = 2,
                updatedAt = "2026-08-13T00:01:00Z",
            ),
            content = editableTextDocContent("b2", "server v2"),
        )
        vm.refreshOnResume()
        runCurrent()

        assertEquals("Local title", vm.uiState.value.title)
        assertEquals("local draft", getBlocks(vm).single().text)
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertNotNull(vm.uiState.value.conflictMessage)
        assertEquals(2, getDocument(vm)?.latestVersion)
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `older resume response cannot overwrite a newer refresh`() = runTest(testDispatcher) {
        val documentId = "doc-web-order"
        val initial = DocDetailResponse(
            document = Doc(id = documentId, organizationId = "ws", title = "Initial", latestVersion = 1),
            content = editableTextDocContent("b0", "initial"),
        )
        val firstResume = CompletableDeferred<DocDetailResponse>()
        val secondResume = CompletableDeferred<DocDetailResponse>()
        var request = 0
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } coAnswers {
            when (request++) {
                0 -> initial
                1 -> firstResume.await()
                else -> secondResume.await()
            }
        }
        disablePermissionTimer(vm)
        runCurrent()

        vm.refreshOnResume()
        runCurrent()
        vm.refreshOnResume()
        runCurrent()
        secondResume.complete(
            DocDetailResponse(
                document = initial.document.copy(title = "Newest", latestVersion = 3),
                content = editableTextDocContent("b3", "newest"),
            ),
        )
        runCurrent()
        firstResume.complete(
            DocDetailResponse(
                document = initial.document.copy(title = "Stale", latestVersion = 2),
                content = editableTextDocContent("b2", "stale"),
            ),
        )
        runCurrent()

        assertEquals("Newest", vm.uiState.value.title)
        assertEquals("newest", getBlocks(vm).single().text)
        assertEquals(3, getDocument(vm)?.latestVersion)
    }

    @Test
    fun `late web return snapshot cannot overwrite a newer native save`() = runTest(testDispatcher) {
        val documentId = "doc-web-save-order"
        val initial = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Initial",
                latestVersion = 1,
                updatedAt = "2026-08-13T00:00:00Z",
            ),
            content = editableTextDocContent("b1", "initial"),
        )
        val delayedWebSnapshot = CompletableDeferred<DocDetailResponse>()
        var detailRequest = 0
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } coAnswers {
            if (detailRequest++ == 0) initial else delayedWebSnapshot.await()
        }
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } returns
            SaveContentResponse(
                document = initial.document.copy(
                    title = "Native saved",
                    latestVersion = 2,
                    updatedAt = "2026-08-13T00:02:00Z",
                ),
            )
        disablePermissionTimer(vm)
        runCurrent()

        vm.refreshOnResume()
        runCurrent()
        vm.onTextChanged(getBlocks(vm).single().id, "native saved body", emptyList())
        vm.onTitleChanged("Native saved")
        advanceTimeBy(1_300)
        runCurrent()
        assertEquals(SaveState.SAVED, vm.uiState.value.saveState)

        delayedWebSnapshot.complete(initial)
        runCurrent()

        assertEquals("Native saved", vm.uiState.value.title)
        assertEquals("native saved body", getBlocks(vm).single().text)
        assertEquals(2, getDocument(vm)?.latestVersion)
    }

    @Test
    fun `versioned native save omits timestamp secondary cas`() = runTest(testDispatcher) {
        val documentId = "doc-version-primary-cas"
        val initial = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                spaceId = "sp",
                title = "Initial",
                latestVersion = 7,
                updatedAt = "2026-08-13T00:00:00Z",
            ),
            content = editableTextDocContent("b1", "initial"),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } returns
            SaveContentResponse(document = initial.document.copy(latestVersion = 8))
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "changed", emptyList())
        advanceTimeBy(1_300)
        runCurrent()

        coVerify(exactly = 1) {
            mockDocRepo.saveContent(
                documentId,
                any(),
                any(),
                any(),
                7,
                null,
                any(),
            )
        }
    }

    @Test
    fun `CR-001 onCleared persists draft when saveState is DIRTY`() = runTest(testDispatcher) {
        val vm = createVm("doc-001")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "modified", emptyList())
        advanceTimeBy(100)

        assertEquals(SaveState.DIRTY, vm.uiState.value.saveState)

        callOnCleared(vm)

        verify { mockPrefsEditor.commit() }
        assertTrue(
            "Draft blocks should be persisted",
            prefsStore.containsKey(draftKey("draft_blocks", "doc-001")),
        )
        assertTrue(
            "Draft title should be persisted",
            prefsStore.containsKey(draftKey("draft_title", "doc-001")),
        )
        assertTrue(
            "Draft timestamp should be persisted",
            prefsStore.containsKey(draftKey("draft_ts", "doc-001")),
        )
    }

    @Test
    fun `CR-001 onCleared persists draft when saveState is SAVING`() = runTest(testDispatcher) {
        val vm = createVm("doc-001b")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } coAnswers {
            kotlinx.coroutines.delay(5000)
            throw RuntimeException("should not complete")
        }

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "saving-in-progress", emptyList())
        advanceTimeBy(1300)

        assertEquals(SaveState.SAVING, vm.uiState.value.saveState)

        callOnCleared(vm)

        verify { mockPrefsEditor.commit() }
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", "doc-001b")))
    }

    @Test
    fun `lifecycle flush persists and saves without waiting for autosave debounce`() =
        runTest(testDispatcher) {
            val documentId = "doc-lifecycle-flush"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "Test",
                    latestVersion = 4,
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent("b1", "initial"),
            )
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns initial
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } returns SaveContentResponse(
                document = initial.document.copy(latestVersion = 5),
            )
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "background edit", emptyList())
            vm.flushForLifecycle()
            runCurrent()

            verify { mockPrefsEditor.commit() }
            coVerify(exactly = 1) {
                mockDocRepo.saveContent(documentId, any(), any(), any(), 4, null, any())
            }
            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals(5, getDocument(vm)?.latestVersion)
        }

    @Test
    fun `CR-001 onCleared does not persist draft when saveState is SAVED`() = runTest(testDispatcher) {
        val vm = createVm("doc-002")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        callOnCleared(vm)

        verify(exactly = 0) { mockPrefsEditor.commit() }
        assertFalse(prefsStore.containsKey(draftKey("draft_blocks", "doc-002")))
    }

    @Test
    fun `CR-001 onCleared persists draft when saveState is FAILED`() = runTest(testDispatcher) {
        val vm = createVm("doc-003")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("network error")

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "failed-save", emptyList())
        advanceUntilIdle()

        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)

        prefsStore.clear()
        callOnCleared(vm)

        verify { mockPrefsEditor.commit() }
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", "doc-003")))
    }

    // ── CR-006: 草稿持久化与恢复 ──

    @Test
    fun `CR-006 scheduleSave triggers draft persistence after interval`() = runTest(testDispatcher) {
        val vm = createVm("doc-006a")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        // W A0.3.续4：本 case 测"draft persist 在 DRAFT_PERSIST_INTERVAL_MS=2000ms 后触发"
        // 的 backstop 语义 —— 用户编辑后即使 save 失败/慢，draft 也要本地持久化保护数据。
        // 之前没 stub saveContent 时依赖 mockk relaxed 默认返回 + race（saveJob 1.2s success
        // → clearDraft → draftSaveJob 2s 又写回），race 修复后该路径不成立。改为显式
        // stub saveContent throws → SaveState.FAILED → 不 clearDraft → draftSaveJob 2s 正常
        // 触发 persistDraft → draft 持久化（本 case 真正的 backstop 语义）。
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("network error")

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("original")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "edited", emptyList())
        advanceTimeBy(2100)

        assertTrue(
            "Draft should be persisted after DRAFT_PERSIST_INTERVAL_MS (backstop on save failure)",
            prefsStore.containsKey(draftKey("draft_blocks", "doc-006a")),
        )
    }

    @Test
    fun `CR-006 successful save clears draft`() = runTest(testDispatcher) {
        val vm = createVm("doc-006b")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val mockDoc = Doc(id = "doc-006b", organizationId = "ws", spaceId = "sp", title = "Test")
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } returns
            SaveContentResponse(document = mockDoc, content = DocContent())

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("original")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "saved-content", emptyList())
        // W A0.3.续4：原 case line 280 `assertTrue containsKey draft` 中间态依赖 race 行为
        // （draftSaveJob 2000ms 触发 persistDraft 在 saveJob 1200ms clearDraft 之后写回）；
        // race 修复后 clearDraft 内 cancel draftSaveJob → draftSaveJob 永远不触发 persistDraft
        // → draft 在 save 成功路径下永远不被异步写入。改为推进到所有 idle 后只断言终态：
        //   - saveState == SAVED（save 完成）
        //   - draft cleared（race 修复确保 draftSaveJob 不会重写 draft）
        // "draft persist 调度路径仍工作" 已由 case `CR-006 scheduleSave triggers draft persistence
        // after interval` 单独覆盖（用户停顿 >2s 时 draftSaveJob 触发持久化）。
        advanceTimeBy(2100)
        advanceUntilIdle()

        assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
        assertFalse(
            "Draft should be cleared after successful save (W A0.3.续4: race fixed by clearDraft cancelling draftSaveJob)",
            prefsStore.containsKey(draftKey("draft_blocks", "doc-006b")),
        )
    }

    @Test
    fun `CR-006 draft is restored on loadDocument when draft exists`() = runTest(testDispatcher) {
        val draftBlock = DocBlock(
            id = "draft-b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("unsaved draft content")),
        )
        val draftJson = ProseMirrorParser.serializeBlocks(listOf(draftBlock))
        prefsStore[draftKey("draft_blocks", "doc-006c")] = draftJson.toString()
        prefsStore[draftKey("draft_title", "doc-006c")] = "Draft Title"
        prefsStore[draftKey("draft_ts", "doc-006c")] = System.currentTimeMillis()

        val vm = createVm("doc-006c")
        disablePermissionTimer(vm)
        // W A0.3.续4：用 runCurrent() 让 loadDocument → checkAndRestoreDraft 完成（含 _uiState
        // title=Draft Title + saveState=DIRTY + scheduleSave() 调度 saveJob），但**不推进**
        // saveJob 的 delay(1200ms)；如果 advanceUntilIdle 会让 saveJob 跑完进入 SAVED，
        // 覆盖 checkAndRestoreDraft 设的 DIRTY，导致 line 326 fail（详 W A0.3.续3 反思 §9.4）。
        runCurrent()

        val blocks = getBlocks(vm)
        assertTrue(
            "Blocks should contain draft content",
            blocks.any { it.text == "unsaved draft content" },
        )
        assertEquals("Draft Title", vm.uiState.value.title)
        assertEquals(
            "State should be DIRTY to trigger re-save of restored draft",
            SaveState.DIRTY,
            vm.uiState.value.saveState,
        )
    }

    @Test
    fun `restored draft with stale base enters conflict and does not auto save`() = runTest(testDispatcher) {
        val draftJson = ProseMirrorParser.serializeBlocks(
            listOf(DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("local draft")))),
        )
        prefsStore[draftKey("draft_blocks", "doc-stale")] = draftJson.toString()
        prefsStore[draftKey("draft_title", "doc-stale")] = "Local title"
        prefsStore[draftKey("draft_ts", "doc-stale")] = System.currentTimeMillis()
        prefsStore[draftKey("draft_base_version", "doc-stale")] = 4L
        prefsStore[draftKey("draft_base_updated_at", "doc-stale")] = "2026-08-10T00:00:00Z"
        val vm = createVm("doc-stale")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-stale") } returns DocDetailResponse(
            document = Doc(
                id = "doc-stale",
                organizationId = "ws",
                spaceId = "sp",
                title = "Server title",
                latestVersion = 5,
                updatedAt = "2026-08-11T00:00:00Z",
            ),
            content = DocContent(),
        )
        runCurrent()
        advanceTimeBy(2_000)

        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("local draft", getBlocks(vm).single().text)
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `stale draft is cleared when newer remote is its canonical equivalent`() = runTest(testDispatcher) {
        val draftJson = ProseMirrorParser.serializeBlocks(
            listOf(DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("already synced")))),
        )
        prefsStore[draftKey("draft_blocks", "doc-equivalent")] = draftJson.toString()
        prefsStore[draftKey("draft_title", "doc-equivalent")] = "Synced title"
        prefsStore[draftKey("draft_ts", "doc-equivalent")] = System.currentTimeMillis()
        prefsStore[draftKey("draft_base_version", "doc-equivalent")] = 5L
        prefsStore[draftKey("draft_base_updated_at", "doc-equivalent")] = "2026-08-13T03:05:00Z"
        val vm = createVm("doc-equivalent")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-equivalent") } returns DocDetailResponse(
            document = Doc(
                id = "doc-equivalent",
                organizationId = "ws",
                spaceId = "sp",
                title = "Synced title",
                latestVersion = 6,
                updatedAt = "2026-08-13T03:06:00Z",
            ),
            content = DocContent(
                descriptionJson = buildJsonObject {
                    put("type", "doc")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "paragraph")
                            put("attrs", buildJsonObject {
                                put("blockId", "server-block")
                                put("textAlign", kotlinx.serialization.json.JsonNull)
                            })
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "text")
                                    put("text", "already synced")
                                })
                            })
                        })
                    })
                },
            ),
        )

        runCurrent()

        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        assertEquals("already synced", getBlocks(vm).single().text)
        assertFalse(prefsStore.containsKey(draftKey("draft_blocks", "doc-equivalent")))
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `unsafe document blocks native mutations and never schedules save`() = runTest(testDispatcher) {
        val unsafeContent = kotlinx.serialization.json.buildJsonObject {
            put("type", "doc")
            put("content", kotlinx.serialization.json.buildJsonArray {
                add(kotlinx.serialization.json.buildJsonObject {
                    put("type", "paragraph")
                    put("content", kotlinx.serialization.json.buildJsonArray {
                        add(kotlinx.serialization.json.buildJsonObject {
                            put("type", "mention")
                            put("attrs", kotlinx.serialization.json.buildJsonObject { put("id", "u-1") })
                        })
                    })
                })
            })
        }
        val vm = createVm("doc-unsafe")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-unsafe") } returns DocDetailResponse(
            document = Doc(id = "doc-unsafe", organizationId = "ws", title = "Unsafe"),
            content = DocContent(descriptionJson = unsafeContent),
        )
        runCurrent()

        assertTrue(vm.uiState.value.requiresFullEditor)
        val readOnlyBlocks = listOf(
            DocBlock(id = "first", kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("first"))),
            DocBlock(id = "second", kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("second"))),
        )
        injectBlocks(vm, readOnlyBlocks)
        vm.onTitleChanged("must not change")
        vm.onBlockMoved(0, 1)
        vm.enterSelectionMode()
        vm.selectAll()
        vm.confirmDeleteSelectedBlocks()
        vm.onImagePicked("first", "content://read-only/image")
        vm.restoreVersion("history-1")
        advanceTimeBy(2_000)
        assertEquals("Unsafe", vm.uiState.value.title)
        assertEquals(listOf("first", "second"), getBlocks(vm).map { it.id })
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { mockDocRepo.restoreHistory(any(), any()) }
    }

    @Test
    fun `legacy markdown body is restored when root content is absent`() = runTest(testDispatcher) {
        val vm = createVm("doc-markdown")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-markdown") } returns DocDetailResponse(
            document = Doc(id = "doc-markdown", organizationId = "ws", title = "Legacy"),
            content = DocContent(
                descriptionJson = buildJsonObject { put("type", "doc") },
                descriptionMarkdown = "# 标题\n\n正文",
            ),
        )
        runCurrent()

        assertFalse(vm.uiState.value.requiresFullEditor)
        assertEquals(listOf("标题", "正文"), getBlocks(vm).map(DocBlock::text))
    }

    @Test
    fun `blank missing content is treated as an editable empty document like iOS`() = runTest(testDispatcher) {
        val vm = createVm("doc-missing-content")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-missing-content") } returns DocDetailResponse(
            document = Doc(id = "doc-missing-content", organizationId = "ws", title = "Missing"),
            content = DocContent(descriptionJson = buildJsonObject { put("type", "doc") }),
        )
        runCurrent()

        assertFalse(vm.uiState.value.requiresFullEditor)
        assertEquals(listOf(""), getBlocks(vm).map(DocBlock::text))
    }

    @Test
    fun `plaintext only legacy content remains read only instead of being overwritten`() = runTest(testDispatcher) {
        val vm = createVm("doc-plaintext-only")
        disablePermissionTimer(vm)
        coEvery { mockDocRepo.getDocumentDetail("doc-plaintext-only") } returns DocDetailResponse(
            document = Doc(id = "doc-plaintext-only", organizationId = "ws", title = "Legacy"),
            content = DocContent(
                descriptionJson = buildJsonObject { put("type", "doc") },
                descriptionPlaintext = "必须保留的旧正文",
            ),
        )
        runCurrent()

        assertTrue(vm.uiState.value.requiresFullEditor)
        vm.onTitleChanged("must not overwrite")
        advanceTimeBy(2_000)
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `native image upload scope matches tabdoc document ownership`() {
        val scope = nativeTabDocImageUploadScope("doc-1", "org-1")

        assertEquals("tabdoc", scope.module)
        assertEquals("document", scope.contextType)
        assertEquals("doc-1", scope.contextId)
        assertEquals("org-1", scope.organizationId)
        assertFalse(scope.isPublic)
    }

    @Test
    fun `CR-006 no draft restoration when no draft exists`() = runTest(testDispatcher) {
        val vm = createVm("doc-006d")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        val blocks = getBlocks(vm)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.PARAGRAPH, blocks[0].kind)
        assertNotEquals(SaveState.DIRTY, vm.uiState.value.saveState)
    }

    // ── CR-007: 保存失败自动重试 ──

    @Test
    fun `CR-007 save failure transitions to FAILED and schedules retry`() = runTest(testDispatcher) {
        val vm = createVm("doc-007a")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("network error")

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "retry-test", emptyList())
        advanceTimeBy(1300)

        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)
        assertEquals(1, getRetryCount(vm))
    }

    @Test
    fun `CR-007 retry transitions back to DIRTY then attempts save`() = runTest(testDispatcher) {
        val vm = createVm("doc-007b")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        var callCount = 0
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } answers {
            callCount++
            throw RuntimeException("still failing")
        }

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "retry-multi", emptyList())
        advanceTimeBy(1300)
        assertEquals(1, callCount)

        advanceTimeBy(DocEditorViewModel.INITIAL_RETRY_DELAY_MS + 100)
        assertEquals(2, callCount)
    }

    @Test
    fun `CR-007 retry stops after MAX_RETRY_COUNT`() = runTest(testDispatcher) {
        val vm = createVm("doc-007c")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("persistent failure")

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "max-retry", emptyList())

        advanceTimeBy(120_000)

        val retryCount = getRetryCount(vm)
        assertTrue(
            "Retry count should not exceed MAX_RETRY_COUNT ($retryCount)",
            retryCount <= DocEditorViewModel.MAX_RETRY_COUNT,
        )
    }

    @Test
    fun `CR-007 new edit resets retry count and cancels pending retry`() = runTest(testDispatcher) {
        val vm = createVm("doc-007d")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("network error")

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "first-edit", emptyList())
        advanceTimeBy(1300)
        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)
        assertTrue(getRetryCount(vm) > 0)

        vm.onTextChanged("b1", "new-edit-resets", emptyList())
        advanceTimeBy(50)
        assertEquals(0, getRetryCount(vm))
        assertEquals(SaveState.DIRTY, vm.uiState.value.saveState)
    }

    @Test
    fun `CR-007 successful save after retry resets retryCount`() = runTest(testDispatcher) {
        val vm = createVm("doc-007e")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        var shouldFail = true
        val mockDoc = Doc(id = "doc-007e", organizationId = "ws", spaceId = "sp", title = "Test")
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } answers {
            if (shouldFail) throw RuntimeException("temporary failure")
            else SaveContentResponse(document = mockDoc, content = DocContent())
        }

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))

        vm.onTextChanged("b1", "will-succeed-on-retry", emptyList())
        advanceTimeBy(1300)
        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)

        shouldFail = false
        advanceTimeBy(DocEditorViewModel.INITIAL_RETRY_DELAY_MS + 100)

        assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
        assertEquals(0, getRetryCount(vm))
    }

    @Test
    fun `save response for another document preserves draft and fails closed`() =
        runTest(testDispatcher) {
            val documentId = "doc-response-fence"
            val vm = createVm(documentId)
            disablePermissionTimer(vm)
            advanceUntilIdle()
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } returns SaveContentResponse(
                document = Doc(
                    id = "doc-from-another-response",
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "Wrong response",
                    latestVersion = 99,
                ),
            )

            injectBlocks(
                vm,
                listOf(
                    DocBlock(
                        id = "b1",
                        kind = BlockKind.PARAGRAPH,
                        spans = listOf(InlineSpan("local draft")),
                    ),
                ),
            )
            vm.onTextChanged("b1", "local draft must survive", emptyList())
            advanceTimeBy(1_300)
            advanceUntilIdle()

            assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
            assertEquals(documentId, getDocument(vm)?.id)
            assertEquals("local draft must survive", getBlocks(vm).single().text)
            assertTrue(prefsStore.containsKey(draftKey("draft_blocks", documentId)))
            assertEquals(0, getRetryCount(vm))
        }

    // ── ANDROID-CONFLICT: 409 版本冲突处理 ──

    private fun getDocument(vm: DocEditorViewModel): Doc? {
        val field = DocEditorViewModel::class.java.getDeclaredField("document")
        field.isAccessible = true
        return field.get(vm) as? Doc
    }

    @Test
    fun `ANDROID-CONFLICT 409 transitions to CONFLICT state, not FAILED`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-1")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict

        val latestDoc = Doc(
            id = "doc-conflict-1", organizationId = "ws", spaceId = "sp",
            title = "Server Title", latestVersion = 5,
        )
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-1") } returns
            DocDetailResponse(document = latestDoc, content = DocContent())

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("local edit")),
        )
        injectBlocks(vm, listOf(block))
        vm.onTextChanged("b1", "conflict-trigger", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertEquals(
            "State should be CONFLICT, not FAILED",
            SaveState.CONFLICT,
            vm.uiState.value.saveState,
        )
        assertNotNull(
            "conflictMessage should be set",
            vm.uiState.value.conflictMessage,
        )
    }

    @Test
    fun `ANDROID-CONFLICT 409 does not trigger retry`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-2")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-2") } returns
            DocDetailResponse(
                document = Doc(id = "doc-conflict-2", organizationId = "ws", spaceId = "sp", title = "T"),
                content = DocContent(),
            )

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))
        vm.onTextChanged("b1", "no-retry", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertEquals(0, getRetryCount(vm))
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)

        advanceTimeBy(DocEditorViewModel.INITIAL_RETRY_DELAY_MS * 2)
        coVerify(exactly = 1) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `ANDROID-CONFLICT preserves local blocks after conflict recovery`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-3")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-3") } returns
            DocDetailResponse(
                document = Doc(
                    id = "doc-conflict-3", organizationId = "ws", spaceId = "sp",
                    title = "Server Title v2", latestVersion = 10,
                ),
                content = DocContent(),
            )

        val localBlock = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("my precious edits")),
        )
        injectBlocks(vm, listOf(localBlock))
        vm.onTitleChanged("My Local Title")
        advanceTimeBy(1300)
        advanceUntilIdle()

        val blocks = getBlocks(vm)
        assertTrue(
            "Local blocks should be preserved after conflict",
            blocks.any { it.text == "my precious edits" },
        )
        assertEquals(
            "Local title should be preserved after conflict",
            "My Local Title",
            vm.uiState.value.title,
        )
    }

    @Test
    fun `ANDROID-CONFLICT updates base document version after conflict`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-4")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict

        val latestDoc = Doc(
            id = "doc-conflict-4", organizationId = "ws", spaceId = "sp",
            title = "Server Title", latestVersion = 42,
        )
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-4") } returns
            DocDetailResponse(document = latestDoc, content = DocContent())

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("edit")),
        )
        injectBlocks(vm, listOf(block))
        vm.onTextChanged("b1", "version-update", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        val doc = getDocument(vm)
        assertNotNull("Base document should be updated", doc)
        assertEquals(
            "Base version should be updated to server latest",
            42,
            doc!!.latestVersion,
        )
    }

    @Test
    fun `discarding a conflict draft reloads remote so the next open is latest`() = runTest(testDispatcher) {
        val documentId = "doc-conflict-discard-leave"
        var detail = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                spaceId = "sp",
                title = "Server v1",
                latestVersion = 1,
            ),
            content = editableTextDocContent("b1", "server v1"),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { detail }
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "local draft", emptyList())
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        detail = DocDetailResponse(
            document = detail.document.copy(title = "Server v2", latestVersion = 2),
            content = editableTextDocContent("b2", "server v2"),
        )
        advanceTimeBy(1300)
        advanceUntilIdle()

        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("local draft", getBlocks(vm).single().text)
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", documentId)))

        assertTrue(vm.discardLocalDraft())
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        assertEquals("server v2", getBlocks(vm).single().text)
        assertEquals("Server v2", vm.uiState.value.title)
        assertTrue(prefsStore.keys.none { it.endsWith(requireNotNull(docDraftScope("user-1", "ws", documentId))) })

        val reopened = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } returns detail
        disablePermissionTimer(reopened)
        runCurrent()

        assertEquals("server v2", getBlocks(reopened).single().text)
        assertEquals("Server v2", reopened.uiState.value.title)
        assertNotEquals(SaveState.CONFLICT, reopened.uiState.value.saveState)
    }

    @Test
    fun `confirmed discard after conflict applies remote before opening full editor`() = runTest(testDispatcher) {
        val documentId = "doc-conflict-discard-full"
        var detail = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                spaceId = "sp",
                title = "Server v1",
                latestVersion = 1,
            ),
            content = editableTextDocContent("b1", "server v1"),
        )
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { detail }
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "local draft", emptyList())
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        detail = DocDetailResponse(
            document = detail.document.copy(title = "Server v2", latestVersion = 2),
            content = editableTextDocContent("b2", "server v2"),
        )
        advanceTimeBy(1300)
        advanceUntilIdle()
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)

        val events = mutableListOf<DocEditorViewModel.EditorEvent>()
        val collector = backgroundScope.launch { vm.events.collect(events::add) }
        runCurrent()
        vm.discardDraftAndOpenFullEditor()
        runCurrent()

        assertTrue(events.contains(DocEditorViewModel.EditorEvent.OpenFullEditor))
        assertEquals("server v2", getBlocks(vm).single().text)
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        collector.cancelAndJoin()
    }

    @Test
    fun `ANDROID-CONFLICT editing after real conflict stays read only and never overwrites`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-5")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-5") } returns
            DocDetailResponse(
                document = Doc(id = "doc-conflict-5", organizationId = "ws", spaceId = "sp", title = "T"),
                content = DocContent(),
            )

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("hello")),
        )
        injectBlocks(vm, listOf(block))
        vm.onTextChanged("b1", "first-save", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)

        clearMocks(mockDocRepo, recordedCalls = true, answers = false)
        val successDoc = Doc(id = "doc-conflict-5", organizationId = "ws", spaceId = "sp", title = "T")
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } returns
            SaveContentResponse(document = successDoc, content = DocContent())

        vm.onTextChanged("b1", "after-conflict-edit", emptyList())
        advanceTimeBy(50)
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("first-save", getBlocks(vm).single().text)

        advanceTimeBy(1300)
        advanceUntilIdle()
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        coVerify(exactly = 0) {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `ANDROID-CONFLICT persists draft during conflict recovery`() = runTest(testDispatcher) {
        val vm = createVm("doc-conflict-6")
        disablePermissionTimer(vm)
        advanceUntilIdle()

        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            AppError.VersionConflict
        coEvery { mockDocRepo.getDocumentDetail("doc-conflict-6") } returns
            DocDetailResponse(
                document = Doc(id = "doc-conflict-6", organizationId = "ws", spaceId = "sp", title = "T"),
                content = DocContent(),
            )

        val block = DocBlock(
            id = "b1", kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("important draft")),
        )
        injectBlocks(vm, listOf(block))
        vm.onTextChanged("b1", "conflict-draft", emptyList())
        advanceTimeBy(1300)
        advanceUntilIdle()

        verify { mockPrefsEditor.apply() }
        assertTrue(
            "Draft should be persisted during conflict recovery",
            prefsStore.containsKey(draftKey("draft_blocks", "doc-conflict-6")),
        )
    }

    @Test
    fun `409 recovery persists original draft base and recreation never auto saves`() =
        runTest(testDispatcher) {
            val documentId = "doc-conflict-recreate"
            val original = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "Server v1",
                    latestVersion = 1,
                    updatedAt = "2026-08-13T00:00:00Z",
                ),
                content = editableTextDocContent("b1", "server v1"),
            )
            val latest = DocDetailResponse(
                document = original.document.copy(
                    title = "Server v2",
                    latestVersion = 2,
                    updatedAt = "2026-08-13T00:01:00Z",
                ),
                content = editableTextDocContent("b2", "collaborator edit"),
            )
            var remote = original
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } throws AppError.VersionConflict
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "local draft", emptyList())
            remote = latest
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
            assertEquals(1L, prefsStore[draftKey("draft_base_version", documentId)])
            assertEquals(
                "2026-08-13T00:00:00Z",
                prefsStore[draftKey("draft_base_updated_at", documentId)],
            )

            callOnCleared(vm)
            clearMocks(mockDocRepo, recordedCalls = true, answers = false)
            val recreated = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } returns latest
            disablePermissionTimer(recreated)
            runCurrent()
            advanceTimeBy(2_000)
            runCurrent()

            assertEquals("local draft", getBlocks(recreated).single().text)
            assertEquals(SaveState.CONFLICT, recreated.uiState.value.saveState)
            coVerify(exactly = 0) {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            }
        }

    @Test
    fun `409 rebases and retries when remote still matches last committed snapshot`() =
        runTest(testDispatcher) {
            val documentId = "doc-equivalent-version-advance"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "验收文档",
                    latestVersion = 3,
                    updatedAt = "2026-08-13T03:00:00Z",
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "初始正文"),
            )
            var remote = initial
            var saveRequestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                saveRequestCount += 1
                when (saveRequestCount) {
                    1 -> SaveContentResponse(
                        document = initial.document.copy(
                            latestVersion = 4,
                            updatedAt = "2026-08-13T03:01:00Z",
                        ),
                    )
                    2 -> throw AppError.VersionConflict
                    else -> SaveContentResponse(
                        document = initial.document.copy(
                            latestVersion = 6,
                            updatedAt = "2026-08-13T03:03:00Z",
                        ),
                    )
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "已提交正文", emptyList())
            advanceTimeBy(1_300)
            runCurrent()
            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)

            remote = DocDetailResponse(
                document = initial.document.copy(
                    latestVersion = 5,
                    updatedAt = "2026-08-13T03:02:00Z",
                ),
                // 服务端会补稳定 blockId；身份变化不能把相同正文误判成协作者修改。
                content = editableTextDocContent("server-stable-block", "已提交正文"),
            )
            vm.onTextChanged(getBlocks(vm).single().id, "冲突期间继续编辑", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(3, saveRequestCount)
            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals("冲突期间继续编辑", getBlocks(vm).single().text)
            assertEquals(6, getDocument(vm)?.latestVersion)
            assertFalse(prefsStore.containsKey(draftKey("draft_blocks", documentId)))
        }

    @Test
    fun `equivalent 409 adopts remote block identity before a later edit`() =
        runTest(testDispatcher) {
            val documentId = "doc-409-adopt-identity"
            fun content(text: String, blockId: String? = null): DocContent = DocContent(
                descriptionJson = buildJsonObject {
                    put("type", "tabtinDocV2")
                    put("serverEnvelope", buildJsonObject { put("mode", "tracked") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "paragraph")
                            if (blockId != null) {
                                put("attrs", buildJsonObject { put("blockId", blockId) })
                            }
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
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Identity",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = content("initial"),
            )
            var remote = initial
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                if (requestCount == 1) {
                    throw AppError.VersionConflict
                }
                SaveContentResponse(document = remote.document.copy(latestVersion = 3))
            }
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "first save", emptyList())
            remote = DocDetailResponse(
                document = initial.document.copy(latestVersion = 2),
                content = content("first save", blockId = "server-stable-block"),
            )
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals("server-stable-block", getBlocks(vm).single().blockId)

            vm.onTextChanged(getBlocks(vm).single().id, "second save", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            val secondParagraph = requests[1].getValue("content").jsonArray.single().jsonObject
            assertEquals(
                "server-stable-block",
                secondParagraph.getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
            assertEquals("second save", getBlocks(vm).single().text)
        }

    @Test
    fun `409 rejects replacement of an existing block identity`() = runTest(testDispatcher) {
        val documentId = "doc-409-replaced-identity"
        val initial = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Identity conflict",
                latestVersion = 1,
                currentUserRole = "editor",
            ),
            content = editableTextDocContent("local-stable", "initial"),
        )
        var remote = initial
        var requestCount = 0
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
        coEvery {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        } coAnswers {
            requestCount += 1
            throw AppError.VersionConflict
        }
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "edited", emptyList())
        remote = DocDetailResponse(
            document = initial.document.copy(latestVersion = 2),
            content = editableTextDocContent("remote-replacement", "edited"),
        )
        advanceTimeBy(1_300)
        runCurrent()

        assertEquals(1, requestCount)
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("edited", getBlocks(vm).single().text)
        assertEquals("local-stable", getBlocks(vm).single().blockId)
    }

    @Test
    fun `409 rejects identity changes inside an opaque block`() = runTest(testDispatcher) {
        val documentId = "doc-409-opaque-identity"
        fun content(text: String, opaqueBlockId: String): DocContent = documentContent(
            paragraphNode("stable-a", text),
            buildJsonObject {
                put("type", "futureWidget")
                put("attrs", buildJsonObject {
                    put("blockId", opaqueBlockId)
                    put("futureKey", "preserve")
                })
            },
        )
        val initial = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                title = "Opaque identity",
                latestVersion = 1,
                currentUserRole = "editor",
            ),
            content = content("initial", "opaque-local"),
        )
        var remote = initial
        var requestCount = 0
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
        coEvery {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        } coAnswers {
            requestCount += 1
            throw AppError.VersionConflict
        }
        disablePermissionTimer(vm)
        runCurrent()

        val paragraphId = getBlocks(vm).first { it.kind == BlockKind.PARAGRAPH }.id
        vm.onTextChanged(paragraphId, "edited", emptyList())
        remote = DocDetailResponse(
            document = initial.document.copy(latestVersion = 2),
            content = content("edited", "opaque-remote"),
        )
        advanceTimeBy(1_300)
        runCurrent()

        assertEquals(1, requestCount)
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("edited", getBlocks(vm).first { it.kind == BlockKind.PARAGRAPH }.text)
    }

    @Test
    fun `409 identity normalization is retained by undo and the next save`() =
        runTest(testDispatcher) {
            val documentId = "doc-409-identity-undo"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "Conflict undo identity",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "initial"),
            )
            var remote = initial
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                if (requestCount == 1) throw AppError.VersionConflict
                SaveContentResponse(document = remote.document.copy(latestVersion = 3))
            }
            disablePermissionTimer(vm)
            runCurrent()

            vm.onTextChanged(getBlocks(vm).single().id, "edited", emptyList())
            remote = DocDetailResponse(
                document = initial.document.copy(latestVersion = 2),
                content = editableTextDocContent("server-stable", "edited"),
            )
            advanceTimeBy(1_300)
            runCurrent()
            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals("server-stable", getBlocks(vm).single().blockId)

            vm.undo()
            assertEquals("initial", getBlocks(vm).single().text)
            assertEquals("server-stable", getBlocks(vm).single().blockId)
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(2, requests.size)
            assertEquals(
                "server-stable",
                requests[1].getValue("content").jsonArray.single().jsonObject
                    .getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
        }

    @Test
    fun `equivalent 409 rebases identity onto newer local edits without replacing raw nodes`() =
        runTest(testDispatcher) {
            val documentId = "doc-409-in-flight-rebase"
            val opaqueNode = buildJsonObject {
                put("type", "futureWidget")
                put("attrs", buildJsonObject {
                    put("token", "opaque-token")
                    put("payload", buildJsonObject { put("keep", true) })
                })
            }
            fun content(text: String, blockId: String? = null): DocContent = DocContent(
                descriptionJson = buildJsonObject {
                    put("type", "tabtinDocV2")
                    put("serverEnvelope", buildJsonObject { put("mode", "tracked") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "paragraph")
                            if (blockId != null) {
                                put("attrs", buildJsonObject { put("blockId", blockId) })
                            }
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "text")
                                    put("text", text)
                                })
                            })
                        })
                        add(opaqueNode)
                    })
                },
            )
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    title = "In flight",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = content("initial"),
            )
            var remote = initial
            val firstRequestStarted = CompletableDeferred<Unit>()
            val releaseConflict = CompletableDeferred<Unit>()
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                if (requestCount == 1) {
                    firstRequestStarted.complete(Unit)
                    releaseConflict.await()
                    throw AppError.VersionConflict
                }
                SaveContentResponse(document = remote.document.copy(latestVersion = 3))
            }
            disablePermissionTimer(vm)
            runCurrent()

            val paragraphId = getBlocks(vm).first { it.kind == BlockKind.PARAGRAPH }.id
            vm.onTextChanged(paragraphId, "first save", emptyList())
            advanceTimeBy(1_200)
            runCurrent()
            assertTrue(firstRequestStarted.isCompleted)

            vm.onTextChanged(paragraphId, "newer local edit", emptyList())
            remote = DocDetailResponse(
                document = initial.document.copy(latestVersion = 2),
                content = content("first save", blockId = "server-stable-block"),
            )
            releaseConflict.complete(Unit)
            runCurrent()

            assertEquals(2, requestCount)
            val retry = requests[1]
            val retryNodes = retry.getValue("content").jsonArray
            val retryParagraph = retryNodes[0].jsonObject
            assertEquals(
                "server-stable-block",
                retryParagraph.getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
            assertEquals(
                "newer local edit",
                retryParagraph.getValue("content").jsonArray.single().jsonObject
                    .getValue("text").jsonPrimitive.content,
            )
            assertEquals(opaqueNode, retryNodes[1])
            assertEquals("newer local edit", getBlocks(vm).first { it.kind == BlockKind.PARAGRAPH }.text)
        }

    @Test
    fun `in flight save committed remotely is not cancelled by the next edit`() =
        runTest(testDispatcher) {
            val documentId = "doc-in-flight-commit"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "验收文档",
                    latestVersion = 1,
                    updatedAt = "2026-08-14T01:00:00Z",
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "初始正文"),
            )
            var remote = initial
            val firstRequestReachedServer = CompletableDeferred<Unit>()
            val releaseFirstResponse = CompletableDeferred<Unit>()
            val requestedBaseVersions = mutableListOf<Int?>()
            val requestedDocuments = mutableListOf<JsonObject>()
            var saveRequestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                saveRequestCount += 1
                val baseVersion = arg<Int?>(4)
                requestedBaseVersions += baseVersion
                requestedDocuments += arg<JsonObject>(1)
                when (saveRequestCount) {
                    1 -> {
                        remote = DocDetailResponse(
                            document = initial.document.copy(
                                latestVersion = 2,
                                updatedAt = "2026-08-14T01:00:01Z",
                            ),
                            content = editableTextDocContent("server-block", "第一次编辑"),
                        )
                        firstRequestReachedServer.complete(Unit)
                        releaseFirstResponse.await()
                        SaveContentResponse(document = remote.document, content = remote.content)
                    }
                    else -> {
                        if (baseVersion != remote.document.latestVersion) {
                            throw AppError.VersionConflict
                        }
                        remote = DocDetailResponse(
                            document = remote.document.copy(
                                latestVersion = 3,
                                updatedAt = "2026-08-14T01:00:02Z",
                            ),
                            content = editableTextDocContent("server-block", "第二次编辑"),
                        )
                        SaveContentResponse(document = remote.document, content = remote.content)
                    }
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            val blockId = getBlocks(vm).single().id
            vm.onTextChanged(blockId, "第一次编辑", emptyList())
            advanceTimeBy(1_200)
            runCurrent()
            assertTrue(firstRequestReachedServer.isCompleted)
            assertEquals(SaveState.SAVING, vm.uiState.value.saveState)

            vm.onTextChanged(blockId, "第二次编辑", emptyList())
            releaseFirstResponse.complete(Unit)
            runCurrent()
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals(listOf(1, 2), requestedBaseVersions)
            assertEquals("第二次编辑", getBlocks(vm).single().text)
            assertEquals(
                "server-block",
                requestedDocuments[1].getValue("content").jsonArray.single().jsonObject
                    .getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
            )
            assertEquals(3, getDocument(vm)?.latestVersion)
        }

    @Test
    fun `authoritative snapshot keeps runtime identity for a later 409 normalization`() =
        runTest(testDispatcher) {
            val documentId = "doc-authoritative-runtime-identity"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "Authoritative identity",
                    latestVersion = 1,
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "initial"),
            )
            var remote = initial
            val firstRequestReachedServer = CompletableDeferred<Unit>()
            val releaseFirstResponse = CompletableDeferred<Unit>()
            val requests = mutableListOf<JsonObject>()
            var requestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                requests += arg<JsonObject>(1)
                requestCount += 1
                when (requestCount) {
                    1 -> {
                        firstRequestReachedServer.complete(Unit)
                        releaseFirstResponse.await()
                        SaveContentResponse(
                            document = initial.document.copy(latestVersion = 2),
                            content = editableTextDocContent(null, "first"),
                        )
                    }
                    2 -> {
                        remote = DocDetailResponse(
                            document = initial.document.copy(latestVersion = 3),
                            content = editableTextDocContent("server-b", "first"),
                        )
                        throw AppError.VersionConflict
                    }
                    else -> SaveContentResponse(
                        document = remote.document.copy(latestVersion = 4),
                    )
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            val runtimeId = getBlocks(vm).single().id
            vm.onTextChanged(runtimeId, "first", emptyList())
            advanceTimeBy(1_200)
            runCurrent()
            assertTrue(firstRequestReachedServer.isCompleted)

            vm.onTextChanged(runtimeId, "second", emptyList())
            releaseFirstResponse.complete(Unit)
            runCurrent()

            assertEquals(3, requests.size)
            val retriedParagraph = requests[2].getValue("content").jsonArray.single().jsonObject
            assertEquals(
                "server-b",
                retriedParagraph.getValue("attrs").jsonObject
                    .getValue("blockId").jsonPrimitive.content,
            )
            assertEquals(
                "second",
                retriedParagraph.getValue("content").jsonArray.single().jsonObject
                    .getValue("text").jsonPrimitive.content,
            )
        }

    @Test
    fun `409 recognizes a remotely committed save whose response was lost`() =
        runTest(testDispatcher) {
            val documentId = "doc-lost-save-response"
            val initial = DocDetailResponse(
                document = Doc(
                    id = documentId,
                    organizationId = "ws",
                    spaceId = "sp",
                    title = "验收文档",
                    latestVersion = 1,
                    updatedAt = "2026-08-14T02:00:00Z",
                    currentUserRole = "editor",
                ),
                content = editableTextDocContent(null, "初始正文"),
            )
            var remote = initial
            val requestedBaseVersions = mutableListOf<Int?>()
            var saveRequestCount = 0
            val vm = createVm(documentId)
            coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
            coEvery {
                mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
            } coAnswers {
                saveRequestCount += 1
                val baseVersion = arg<Int?>(4)
                requestedBaseVersions += baseVersion
                when (saveRequestCount) {
                    1 -> {
                        remote = DocDetailResponse(
                            document = initial.document.copy(
                                latestVersion = 2,
                                updatedAt = "2026-08-14T02:00:01Z",
                            ),
                            content = editableTextDocContent("server-block", "第一次编辑"),
                        )
                        throw RuntimeException("response lost after commit")
                    }
                    2 -> throw AppError.VersionConflict
                    else -> {
                        assertEquals(remote.document.latestVersion, baseVersion)
                        remote = DocDetailResponse(
                            document = remote.document.copy(
                                latestVersion = 3,
                                updatedAt = "2026-08-14T02:00:02Z",
                            ),
                            content = editableTextDocContent("server-block", "第二次编辑"),
                        )
                        SaveContentResponse(document = remote.document, content = remote.content)
                    }
                }
            }
            disablePermissionTimer(vm)
            runCurrent()

            val blockId = getBlocks(vm).single().id
            vm.onTextChanged(blockId, "第一次编辑", emptyList())
            advanceTimeBy(1_300)
            runCurrent()
            assertEquals(SaveState.FAILED, vm.uiState.value.saveState)

            vm.onTextChanged(blockId, "第二次编辑", emptyList())
            advanceTimeBy(1_300)
            runCurrent()

            assertEquals(SaveState.SAVED, vm.uiState.value.saveState)
            assertEquals(listOf(1, 1, 2), requestedBaseVersions)
            assertEquals("第二次编辑", getBlocks(vm).single().text)
            assertEquals(3, getDocument(vm)?.latestVersion)
        }

    @Test
    fun `409 never retries when remote content really changed`() = runTest(testDispatcher) {
        val documentId = "doc-real-collaborator-conflict"
        val initial = DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "ws",
                spaceId = "sp",
                title = "验收文档",
                latestVersion = 4,
                updatedAt = "2026-08-13T03:00:00Z",
                currentUserRole = "editor",
            ),
            content = editableTextDocContent("initial-block", "共同基线"),
        )
        val collaboratorEdit = DocDetailResponse(
            document = initial.document.copy(
                latestVersion = 5,
                updatedAt = "2026-08-13T03:02:00Z",
            ),
            content = editableTextDocContent("collaborator-block", "协作者的新正文"),
        )
        var remote = initial
        var saveRequestCount = 0
        val vm = createVm(documentId)
        coEvery { mockDocRepo.getDocumentDetail(documentId) } answers { remote }
        coEvery {
            mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any())
        } coAnswers {
            saveRequestCount += 1
            throw AppError.VersionConflict
        }
        disablePermissionTimer(vm)
        runCurrent()

        vm.onTextChanged(getBlocks(vm).single().id, "本地草稿", emptyList())
        remote = collaboratorEdit
        advanceTimeBy(1_300)
        runCurrent()

        assertEquals(1, saveRequestCount)
        assertEquals(SaveState.CONFLICT, vm.uiState.value.saveState)
        assertEquals("本地草稿", getBlocks(vm).single().text)
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", documentId)))
    }

    @Test
    fun `failed save requests explicit draft discard before opening full editor`() = runTest(testDispatcher) {
        val vm = createVm("doc-full-editor-failed")
        disablePermissionTimer(vm)
        advanceUntilIdle()
        coEvery { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) } throws
            RuntimeException("offline")
        injectBlocks(
            vm,
            listOf(DocBlock(id = "b1", kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("draft")))),
        )
        vm.onTextChanged("b1", "failed draft", emptyList())
        advanceTimeBy(1300)
        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)

        val events = mutableListOf<DocEditorViewModel.EditorEvent>()
        val collector = backgroundScope.launch { vm.events.collect(events::add) }
        runCurrent()
        vm.requestOpenFullEditor()
        runCurrent()

        assertTrue(events.contains(DocEditorViewModel.EditorEvent.ConfirmDiscardDraftForFullEditor))
        assertFalse(events.contains(DocEditorViewModel.EditorEvent.OpenFullEditor))
        assertTrue(prefsStore.containsKey(draftKey("draft_blocks", "doc-full-editor-failed")))
        collector.cancelAndJoin()
    }

    @Test
    fun `initial offline load restores scoped draft as copy only preview`() = runTest(testDispatcher) {
        val documentId = "doc-offline-draft"
        val scope = requireNotNull(docDraftScope("user-1", "ws", documentId))
        prefsStore["draft_blocks_$scope"] = ProseMirrorParser.serializeBlocks(
            listOf(DocBlock(id = "b1", kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("offline body")))),
        ).toString()
        prefsStore["draft_title_$scope"] = "Offline title"
        prefsStore["draft_ts_$scope"] = 1L
        val vm = createVm(documentId)
        // createVm installs the default successful detail stub. Override it after construction,
        // before the StandardTestDispatcher is advanced and the initial load actually runs.
        coEvery { mockDocRepo.getDocumentDetail(documentId) } throws RuntimeException("offline")
        runCurrent()

        assertTrue(vm.uiState.value.isOfflineDraftPreview)
        assertTrue(vm.uiState.value.isReadOnlyByRole)
        assertEquals(SaveState.FAILED, vm.uiState.value.saveState)
        assertEquals("Offline title", vm.uiState.value.title)
        assertEquals("offline body", getBlocks(vm).single().text)

        vm.onTextChanged("b1", "must not edit", emptyList())
        vm.saveDocument()
        advanceUntilIdle()
        assertEquals("offline body", getBlocks(vm).single().text)
        coVerify(exactly = 0) { mockDocRepo.saveContent(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `confirmed discard clears only current document draft and opens full editor`() = runTest(testDispatcher) {
        val currentScope = requireNotNull(docDraftScope("user-1", "ws", "doc-discard-current"))
        val otherScope = requireNotNull(docDraftScope("user-1", "ws", "doc-discard-other"))
        listOf("draft_blocks", "draft_title", "draft_ts", "draft_base_version", "draft_base_updated_at").forEach { prefix ->
            prefsStore["${prefix}_$currentScope"] = if (prefix == "draft_ts" || prefix == "draft_base_version") 1L else "current"
            prefsStore["${prefix}_$otherScope"] = if (prefix == "draft_ts" || prefix == "draft_base_version") 1L else "other"
        }
        val vm = createVm("doc-discard-current")
        disablePermissionTimer(vm)
        runCurrent()

        val events = mutableListOf<DocEditorViewModel.EditorEvent>()
        val collector = backgroundScope.launch { vm.events.collect(events::add) }
        runCurrent()
        vm.discardDraftAndOpenFullEditor()
        runCurrent()

        assertTrue(events.contains(DocEditorViewModel.EditorEvent.OpenFullEditor))
        assertTrue(prefsStore.keys.none { it.endsWith(currentScope) })
        assertTrue(prefsStore.keys.any { it.endsWith(otherScope) })
        collector.cancelAndJoin()
    }

    @Test
    fun `failed synchronous draft deletion keeps editor open`() = runTest(testDispatcher) {
        val vm = createVm("doc-discard-failure")
        disablePermissionTimer(vm)
        advanceUntilIdle()
        every { mockPrefsEditor.commit() } returns false

        val events = mutableListOf<DocEditorViewModel.EditorEvent>()
        val collector = backgroundScope.launch { vm.events.collect(events::add) }
        runCurrent()
        vm.discardDraftAndOpenFullEditor()
        runCurrent()

        assertFalse(events.contains(DocEditorViewModel.EditorEvent.OpenFullEditor))
        assertTrue(
            events.any {
                it == DocEditorViewModel.EditorEvent.ShowToast(R.string.doc_full_editor_discard_failed)
            },
        )
        collector.cancelAndJoin()
    }
}
