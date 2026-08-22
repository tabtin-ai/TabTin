package com.tabtin.mobile.features.doc

import android.app.Application
import android.content.ContentResolver
import android.content.Context
import android.content.SharedPreferences
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.data.api.OSSFileAccess
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadResult
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocContent
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.util.TokenManager
import io.mockk.*
import java.io.InputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class DocEditorViewModelImageSafetyTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var context: Context
    private lateinit var contentResolver: ContentResolver
    private lateinit var docRepository: DocRepository
    private lateinit var ossUploadService: OSSUploadService
    private lateinit var tokenManager: TokenManager

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        mockkStatic(Log::class)
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.e(any(), any(), any()) } returns 0

        val editor = mockk<SharedPreferences.Editor>(relaxed = true)
        val preferences = mockk<SharedPreferences>(relaxed = true)
        every { preferences.edit() } returns editor
        every { preferences.getString(any(), any()) } answers { secondArg() }
        every { preferences.getLong(any(), any()) } answers { secondArg() }

        contentResolver = mockk(relaxed = true)
        context = mockk(relaxed = true)
        every { context.contentResolver } returns contentResolver
        every { context.getSharedPreferences(any(), any()) } returns preferences
        every { context.getString(any()) } returns "message"

        docRepository = mockk(relaxed = true)
        ossUploadService = mockk(relaxed = true)
        tokenManager = mockk(relaxed = true)
        every { tokenManager.userId } returns "user-1"
        every { tokenManager.organizationId } returns "org-1"
        every { tokenManager.isLoggedIn } returns true
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    @Test
    fun `readonly empty image never opens picker or starts upload`() = runTest(dispatcher) {
        val vm = createViewModel("doc-readonly-image", emptyDocument())
        disablePermissionTimer(vm)
        runCurrent()
        val readonlyImage = parseImageBlock(src = "", fileId = "file-existing")
        assertTrue(readonlyImage.canDeleteWholeBlock)
        injectBlocks(vm, listOf(readonlyImage))
        val events = mutableListOf<DocEditorViewModel.EditorEvent>()
        val collector = backgroundScope.launch { vm.events.collect(events::add) }
        runCurrent()

        vm.onImagePlaceholderClick(readonlyImage.id)
        vm.onImagePicked(readonlyImage.id, "content://tabtin/readonly")
        runCurrent()

        assertFalse(events.any { it is DocEditorViewModel.EditorEvent.PickImage })
        coVerify(exactly = 0) {
            ossUploadService.directUpload(any(), any(), any(), any(), any())
        }
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        assertEquals(readonlyImage.rawNode, blocks(vm).single().rawNode)
        collector.cancel()
    }

    @Test
    fun `canonical image delete preserves sibling and undo restores exact source without deleting asset`() =
        runTest(dispatcher) {
            val original = documentOf(canonicalImageParagraph(), siblingParagraph())
            val vm = createViewModel("doc-delete-image", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val parsed = ProseMirrorParser.parseBlocks(original)
            val image = parsed.first()
            injectBlocks(vm, parsed)

            vm.onBlockLongPress(image.id)

            assertTrue(vm.uiState.value.showBlockActionMenu)
            assertFalse(vm.uiState.value.actionBlockEditable)
            assertTrue(vm.uiState.value.actionBlockCanDeleteWholeBlock)

            vm.onDuplicateBlock()

            assertEquals(original, ProseMirrorParser.serializeBlocks(blocks(vm)))
            assertFalse(vm.uiState.value.canUndo)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)

            vm.onDeleteBlock()

            assertEquals(
                documentOf(siblingParagraph()),
                ProseMirrorParser.serializeBlocks(blocks(vm)),
            )
            assertTrue(vm.uiState.value.canUndo)
            assertEquals(SaveState.DIRTY, vm.uiState.value.saveState)
            verify(exactly = 0) {
                ossUploadService.deactivateUsageDetached(any(), any(), any(), any())
            }
            coVerify(exactly = 0) {
                ossUploadService.directUpload(any(), any(), any(), any(), any())
            }

            vm.undo()

            assertEquals(original, ProseMirrorParser.serializeBlocks(blocks(vm)))
        }

    @Test
    fun `stale image delete callback rechecks current whole block capability`() =
        runTest(dispatcher) {
            val original = documentOf(canonicalImageParagraph(), siblingParagraph())
            val vm = createViewModel("doc-stale-image-delete", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val parsed = ProseMirrorParser.parseBlocks(original)
            val image = parsed.first()
            injectBlocks(vm, parsed)
            vm.onBlockLongPress(image.id)

            injectBlocks(
                vm,
                parsed.map { block ->
                    if (block.id == image.id) block.copy(canDeleteWholeBlock = false) else block
                },
            )
            vm.onDeleteBlock()

            assertEquals(original, ProseMirrorParser.serializeBlocks(blocks(vm)))
            assertFalse(vm.uiState.value.canUndo)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        }

    @Test
    fun `image delete callback is ignored after editor permission is revoked`() =
        runTest(dispatcher) {
            val original = documentOf(canonicalImageParagraph(), siblingParagraph())
            val vm = createViewModel("doc-revoked-image-delete", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val parsed = ProseMirrorParser.parseBlocks(original)
            val image = parsed.first()
            injectBlocks(vm, parsed)
            vm.onBlockLongPress(image.id)
            setDocumentRole(vm, "viewer")

            vm.onDeleteBlock()

            assertEquals(original, ProseMirrorParser.serializeBlocks(blocks(vm)))
            assertFalse(vm.uiState.value.canUndo)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        }

    @Test
    fun `canonical image participates in block selection and bulk delete`() =
        runTest(dispatcher) {
            val vm = createViewModel("doc-select-image", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val parsed = ProseMirrorParser.parseBlocks(
                documentOf(canonicalImageParagraph(), siblingParagraph()),
            )
            val image = parsed.first()
            val sibling = parsed.last()
            injectBlocks(vm, parsed)

            vm.enterSelectionMode()
            vm.toggleBlockSelection(image.id)
            vm.toggleBlockSelection(sibling.id)

            assertEquals(setOf(image.id, sibling.id), vm.uiState.value.selectedBlockIds)

            vm.confirmDeleteSelectedBlocks()

            val remaining = blocks(vm).single()
            assertEquals(BlockKind.PARAGRAPH, remaining.kind)
            assertEquals("", remaining.text)
            assertTrue(vm.uiState.value.canUndo)
            assertEquals(SaveState.DIRTY, vm.uiState.value.saveState)
        }

    @Test
    fun `opaque block cannot enter selection through a stale menu callback`() =
        runTest(dispatcher) {
            val vm = createViewModel("doc-select-opaque", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val opaque = DocBlock(
                id = "opaque",
                kind = BlockKind.UNSUPPORTED,
                editable = false,
                canDeleteWholeBlock = false,
                rawNode = mapOf("type" to "futureBlock"),
            )
            injectBlocks(vm, listOf(opaque))

            vm.enterSelectionMode(opaque.id)

            assertFalse(vm.uiState.value.isSelectionMode)
            assertTrue(vm.uiState.value.selectedBlockIds.isEmpty())
            assertFalse(vm.uiState.value.canUndo)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
        }

    @Test
    fun `select all includes canonical image but protects opaque blocks`() =
        runTest(dispatcher) {
            val vm = createViewModel("doc-select-all-image", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val parsed = ProseMirrorParser.parseBlocks(
                documentOf(canonicalImageParagraph(), siblingParagraph()),
            )
            val image = parsed.first()
            val sibling = parsed.last()
            val opaque = DocBlock(
                id = "opaque-select-all",
                kind = BlockKind.UNSUPPORTED,
                editable = false,
                canDeleteWholeBlock = false,
                rawNode = mapOf(
                    "type" to "futureBlock",
                    "attrs" to mapOf("keep" to true),
                ),
            )
            injectBlocks(vm, listOf(image, sibling, opaque))

            vm.enterSelectionMode()
            vm.selectAll()

            assertEquals(setOf(image.id, sibling.id), vm.uiState.value.selectedBlockIds)

            vm.confirmDeleteSelectedBlocks()

            assertEquals(listOf(opaque), blocks(vm))
            assertTrue(vm.uiState.value.canUndo)
            assertEquals(SaveState.DIRTY, vm.uiState.value.saveState)
        }

    @Test
    fun `upload result cannot replace image that became readonly while request was in flight`() =
        runTest(dispatcher) {
            val vm = createViewModel("doc-stale-image", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val editableImage = DocBlock(id = "image-1", kind = BlockKind.IMAGE, editable = true)
            injectBlocks(vm, listOf(editableImage))
            stubReadableImage()

            val uploadStarted = CompletableDeferred<Unit>()
            val uploadResult = CompletableDeferred<UploadResult>()
            coEvery {
                ossUploadService.directUpload(any(), any(), any(), any(), any())
            } coAnswers {
                uploadStarted.complete(Unit)
                uploadResult.await()
            }

            vm.onImagePicked(editableImage.id, "content://tabtin/picked")
            runCurrent()
            assertTrue(uploadStarted.isCompleted)

            val readonlyRaw = mapOf<String, Any?>("type" to "paragraph")
            injectBlocks(vm, listOf(editableImage.copy(editable = false, rawNode = readonlyRaw)))
            uploadResult.complete(
                UploadResult(
                    fileId = "uploaded-file",
                    accessUrl = "https://cdn.example/image.png",
                    fileName = "image.png",
                ),
            )
            runCurrent()

            val current = blocks(vm).single()
            assertFalse(current.editable)
            assertEquals("", current.imageURL)
            assertEquals("", current.imageFileId)
            assertEquals(readonlyRaw, current.rawNode)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
            verify(exactly = 1) {
                ossUploadService.deactivateUsageDetached(
                    "uploaded-file",
                    "tabdoc",
                    "document",
                    "doc-stale-image",
                )
            }
            coVerify(exactly = 0) {
                docRepository.saveContent(any(), any(), any(), any(), any(), any(), any())
            }
        }

    @Test
    fun `image becoming readonly during local read is rejected before network upload`() =
        runTest(dispatcher) {
            val vm = createViewModel("doc-read-race", emptyDocument())
            disablePermissionTimer(vm)
            runCurrent()
            val editableImage = DocBlock(id = "image-read-race", kind = BlockKind.IMAGE)
            injectBlocks(vm, listOf(editableImage))
            stubReadableImage {
                injectBlocks(vm, listOf(editableImage.copy(editable = false)))
            }

            vm.onImagePicked(editableImage.id, "content://tabtin/read-race")
            runCurrent()

            assertFalse(blocks(vm).single().editable)
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
            coVerify(exactly = 0) {
                ossUploadService.directUpload(any(), any(), any(), any(), any())
            }
        }

    @Test
    fun `fileId only image resolves display url without changing persisted ProseMirror`() =
        runTest(dispatcher) {
            val original = imageDocument(src = "", fileId = "file-history")
            coEvery { ossUploadService.resolveFile("file-history") } returns OSSFileAccess(
                fileId = "file-history",
                accessUrl = "https://signed.example/history.png",
            )
            val vm = createViewModel("doc-file-id-image", original)
            disablePermissionTimer(vm)
            runCurrent()

            val image = vm.uiState.value.blockViews.single() as TabDocBlockView.Image
            assertEquals("https://signed.example/history.png", image.url)
            assertTrue(image.isReadOnly)
            assertFalse("只有正典独立图片的文档仍须留在原生界面以便整块删除", vm.uiState.value.requiresFullEditor)
            assertEquals(original, ProseMirrorParser.serializeBlocks(blocks(vm)))
            assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
            coVerify(exactly = 0) {
                docRepository.saveContent(any(), any(), any(), any(), any(), any(), any())
            }
        }

    private fun createViewModel(documentId: String, content: JsonObject): DocEditorViewModel {
        coEvery { docRepository.getDocumentDetail(documentId) } returns DocDetailResponse(
            document = Doc(
                id = documentId,
                organizationId = "org-1",
                title = "Images",
            ),
            content = DocContent(descriptionJson = content),
        )
        val streamManager = mockk<StreamManager>(relaxed = true)
        every { streamManager.currentPhase } returns MutableStateFlow(AgentPhase.IDLE)
        return DocEditorViewModel(
            docRepository = docRepository,
            ossUploadService = ossUploadService,
            tokenManager = tokenManager,
            streamManager = streamManager,
            appContext = context,
            savedStateHandle = SavedStateHandle(
                mapOf("documentId" to documentId, "organizationId" to "org-1"),
            ),
            coroutineDispatcher = dispatcher,
            ioDispatcher = dispatcher,
        )
    }

    private fun stubReadableImage(onFirstRead: () -> Unit = {}) {
        val descriptor = mockk<ParcelFileDescriptor>(relaxed = true)
        every { descriptor.statSize } returns 3L
        every { contentResolver.openFileDescriptor(any(), "r") } returns descriptor
        every { contentResolver.openInputStream(any()) } answers {
            object : InputStream() {
                private var firstRead = true
                private var remaining = 3

                override fun read(): Int {
                    if (firstRead) {
                        firstRead = false
                        onFirstRead()
                    }
                    if (remaining == 0) return -1
                    remaining--
                    return 1
                }
            }
        }
        every { contentResolver.getType(any()) } returns "image/png"
    }

    private fun disablePermissionTimer(vm: DocEditorViewModel) {
        DocEditorViewModel::class.java.getDeclaredField("permissionCheckJob")
            .apply { isAccessible = true }
            .set(vm, mockk<Job>(relaxed = true))
    }

    private fun injectBlocks(vm: DocEditorViewModel, value: List<DocBlock>) {
        DocEditorViewModel::class.java.getDeclaredField("blocks")
            .apply { isAccessible = true }
            .set(vm, value.toMutableList())
    }

    private fun setDocumentRole(vm: DocEditorViewModel, role: String) {
        val field = DocEditorViewModel::class.java.getDeclaredField("document")
            .apply { isAccessible = true }
        val current = field.get(vm) as Doc
        field.set(vm, current.copy(currentUserRole = role))
    }

    @Suppress("UNCHECKED_CAST")
    private fun blocks(vm: DocEditorViewModel): List<DocBlock> =
        DocEditorViewModel::class.java.getDeclaredField("blocks")
            .apply { isAccessible = true }
            .get(vm) as List<DocBlock>

    private fun parseImageBlock(src: String, fileId: String): DocBlock =
        ProseMirrorParser.parseBlocks(imageDocument(src, fileId)).single()

    private fun emptyDocument(): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {})
    }

    private fun documentOf(vararg nodes: JsonObject): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray { nodes.forEach { add(it) } })
    }

    private fun canonicalImageParagraph(): JsonObject = buildJsonObject {
        put("type", "paragraph")
        put("attrs", buildJsonObject {
            put("blockId", "image-block")
            put("textAlign", JsonNull)
        })
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "image")
                put("attrs", buildJsonObject {
                    put("src", "https://cdn.example/image.png")
                    put("fileId", "file-existing")
                    put("alt", "existing image")
                    put("title", "Product flow")
                    put("width", 1280)
                    put("height", 720)
                })
            })
        })
    }

    private fun siblingParagraph(): JsonObject = buildJsonObject {
        put("type", "paragraph")
        put("attrs", buildJsonObject { put("blockId", "sibling-block") })
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "text")
                put("text", "sibling stays exact")
            })
        })
    }

    private fun imageDocument(src: String, fileId: String): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject { put("blockId", "image-block") })
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "image")
                        put("attrs", buildJsonObject {
                            put("src", src)
                            put("fileId", fileId)
                            put("alt", "history image")
                        })
                    })
                })
            })
        })
    }

}
