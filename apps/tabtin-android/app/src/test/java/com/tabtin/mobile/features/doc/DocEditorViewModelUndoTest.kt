package com.tabtin.mobile.features.doc

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.TokenManager
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DocEditorViewModelUndoTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var vm: DocEditorViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        val savedState = SavedStateHandle(
            mapOf(
                "documentId" to TEST_DOCUMENT_ID,
                "organizationId" to TEST_ORGANIZATION_ID,
            ),
        )
        val mockStreamManager = mockk<StreamManager>(relaxed = true)
        val mockTokenManager = mockk<TokenManager>(relaxed = true)
        every { mockStreamManager.currentPhase } returns MutableStateFlow(AgentPhase.IDLE)
        every { mockTokenManager.userId } returns "undo-user"
        every { mockTokenManager.organizationId } returns TEST_ORGANIZATION_ID
        every { mockTokenManager.isLoggedIn } returns true
        vm = DocEditorViewModel(
            docRepository = mockk<DocRepository>(relaxed = true),
            ossUploadService = mockk<OSSUploadService>(relaxed = true),
            tokenManager = mockTokenManager,
            streamManager = mockStreamManager,
            appContext = mockk<Context>(relaxed = true),
            savedStateHandle = savedState,
            // W A0.3.续7：注入 testDispatcher，避免 W A0.3.续6 引入的
            // withContext(Dispatchers.Default) 在 saveIfNeeded 路径上让 advanceTimeBy 失控。
            coroutineDispatcher = testDispatcher,
            // W D：ioDispatcher 同款注入。Undo 路径目前不走 IO，但 createVm helper 统一注入
            // 防御未来 onImagePicked 走入 Undo case 时 advanceUntilIdle 失控（见 ViewModel
            // line ~1089 onImagePicked withContext(ioDispatcher)）。
            ioDispatcher = testDispatcher,
        )
        val loadJobField = DocEditorViewModel::class.java.getDeclaredField("loadJob")
        loadJobField.isAccessible = true
        (loadJobField.get(vm) as? Job)?.cancel()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /**
     * 通过反射注入文档和 blocks 以模拟已完成鉴权的 editor 会话。
     *
     * 编辑器现在会拒绝缺少用户、组织或资源身份的写入；Undo 测试只绕过网络加载，
     * 不能再靠空 documentId 绕过生产门禁，否则测试验证的是“未鉴权编辑”而非撤销栈。
     */
    private fun injectBlocks(blocks: List<com.tabtin.mobile.features.doc.model.DocBlock>) {
        val documentField = DocEditorViewModel::class.java.getDeclaredField("document")
        documentField.isAccessible = true
        documentField.set(
            vm,
            Doc(
                id = TEST_DOCUMENT_ID,
                organizationId = TEST_ORGANIZATION_ID,
                title = "Undo test",
                currentUserRole = "editor",
            ),
        )
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        field.set(vm, blocks.toMutableList())
    }

    private fun getBlocks(): List<com.tabtin.mobile.features.doc.model.DocBlock> {
        val field = DocEditorViewModel::class.java.getDeclaredField("blocks")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(vm) as List<com.tabtin.mobile.features.doc.model.DocBlock>
    }

    private fun getTitle(): String {
        val field = DocEditorViewModel::class.java.getDeclaredField("documentTitle")
        field.isAccessible = true
        return field.get(vm) as String
    }

    private fun setTitle(title: String) {
        val field = DocEditorViewModel::class.java.getDeclaredField("documentTitle")
        field.isAccessible = true
        field.set(vm, title)
    }

    @Test
    fun `blank background tap clears focused block and format toolbar`() = runTest(testDispatcher) {
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "b1",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
                    spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("hello")),
                ),
            ),
        )

        vm.onFocusChanged("b1")
        assertTrue(vm.uiState.value.showFormatToolbar)
        assertTrue(vm.uiState.value.blockViews.any { block ->
            (block as? com.tabtin.mobile.features.doc.editor.core.TabDocBlockView.Focusable)
                ?.isFocused == true
        })

        vm.onEditorBackgroundTapped()

        assertFalse(vm.uiState.value.showFormatToolbar)
        assertTrue(vm.uiState.value.blockViews.none { block ->
            (block as? com.tabtin.mobile.features.doc.editor.core.TabDocBlockView.Focusable)
                ?.isFocused == true
        })
    }

    // ── onTextChanged undo tests ──

    @Test
    fun `onTextChanged enables undo after debounce`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("hello")),
        )
        injectBlocks(listOf(block))

        assertFalse(vm.uiState.value.canUndo)

        vm.onTextChanged("b1", "hello world", emptyList())
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertTrue("canUndo should be true after text change + debounce", vm.uiState.value.canUndo)
    }

    @Test
    fun `rapid onTextChanged calls produce single undo entry`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("")),
        )
        injectBlocks(listOf(block))

        vm.onTextChanged("b1", "a", emptyList())
        advanceTimeBy(100)
        vm.onTextChanged("b1", "ab", emptyList())
        advanceTimeBy(100)
        vm.onTextChanged("b1", "abc", emptyList())
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertTrue(vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)

        val restoredText = getBlocks().first().text
        assertEquals("Undo should restore to empty (pre-typing state)", "", restoredText)

        assertFalse("No more undo entries after single undo", vm.uiState.value.canUndo)
    }

    @Test
    fun `undo after text change restores original text`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("original")),
        )
        injectBlocks(listOf(block))

        vm.onTextChanged("b1", "modified", emptyList())
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        vm.undo()
        advanceTimeBy(50)

        assertEquals("original", getBlocks().first().text)
    }

    // ── onCodeTextChanged undo tests ──

    @Test
    fun `onCodeTextChanged enables undo after debounce`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "code1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.CODE_BLOCK,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("let x = 1")),
        )
        injectBlocks(listOf(block))

        vm.onCodeTextChanged("code1", "let x = 2")
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertTrue(vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)

        assertEquals("let x = 1", getBlocks().first().text)
    }

    // ── onTitleChanged undo tests ──

    @Test
    fun `onTitleChanged enables undo after debounce`() = runTest(testDispatcher) {
        injectBlocks(listOf(com.tabtin.mobile.features.doc.model.DocBlock.empty(
            com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH
        )))
        setTitle("Old Title")

        vm.onTitleChanged("New Title")
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertTrue(vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)

        assertEquals("Old Title", getTitle())
    }

    // ── onCellTextChanged undo tests ──

    @Test
    fun `onCellTextChanged enables undo after debounce`() = runTest(testDispatcher) {
        val table = com.tabtin.mobile.features.doc.model.TableData(
            rows = listOf(
                com.tabtin.mobile.features.doc.model.TableRow(
                    cells = listOf(com.tabtin.mobile.features.doc.model.TableCell(text = "A"))
                )
            )
        )
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "t1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
            tableData = table,
        )
        injectBlocks(listOf(block))

        vm.onCellTextChanged("t1", 0, 0, "B")
        assertEquals("B", getBlocks().first().tableData!!.rows[0].cells[0].spans.single().text)
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertTrue(vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)

        val cell = getBlocks().first().tableData!!.rows[0].cells[0]
        assertEquals("A", cell.text)
    }

    @Test
    fun `onCellTextChanged ignores projected complex cell`() = runTest(testDispatcher) {
        val cell = com.tabtin.mobile.features.doc.model.TableCell(
            text = "复杂内容",
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("复杂内容")),
            isReadOnlyProjection = true,
        )
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "t1",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
                    tableData = com.tabtin.mobile.features.doc.model.TableData(
                        rows = listOf(com.tabtin.mobile.features.doc.model.TableRow(listOf(cell))),
                    ),
                ),
            ),
        )

        vm.onCellTextChanged("t1", 0, 0, "不得覆盖")
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertEquals("复杂内容", getBlocks().first().tableData!!.rows[0].cells[0].text)
        assertFalse(vm.uiState.value.canUndo)
    }

    @Test
    fun `onCellTextChanged preserves existing bold marks`() = runTest(testDispatcher) {
        val original = "加粗备注"
        val edited = "加粗备注x"
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "t1",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
                    tableData = com.tabtin.mobile.features.doc.model.TableData(
                        rows = listOf(
                            com.tabtin.mobile.features.doc.model.TableRow(
                                listOf(
                                    com.tabtin.mobile.features.doc.model.TableCell(
                                        text = original,
                                        spans = listOf(
                                            com.tabtin.mobile.features.doc.model.InlineSpan(
                                                original,
                                                listOf(com.tabtin.mobile.features.doc.model.InlineMark.Bold),
                                            ),
                                        ),
                                        isReadOnlyProjection = false,
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )

        vm.onCellTextChanged(
            "t1",
            0,
            0,
            edited,
            listOf(com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Bold(0, original.length)),
        )

        val cell = getBlocks().first().tableData!!.rows[0].cells[0]
        assertEquals(edited, cell.text)
        assertTrue(
            "改一字后加粗必须仍在 spans 上",
            cell.spans.any { span ->
                span.marks.any { it is com.tabtin.mobile.features.doc.model.InlineMark.Bold }
            },
        )

        val serialized = com.tabtin.mobile.features.doc.model.ProseMirrorParser
            .serializeBlocks(getBlocks())
            .toString()
        assertTrue(
            "序列化后 JSON 仍须带 bold mark",
            serialized.contains("\"marks\":[{\"type\":\"bold\"}]"),
        )
    }

    @Test
    fun `table can append standard row and column beside projected cells`() = runTest(testDispatcher) {
        val projected = com.tabtin.mobile.features.doc.model.TableCell(
            text = "复杂内容",
            isReadOnlyProjection = true,
        )
        val editable = com.tabtin.mobile.features.doc.model.TableCell(text = "普通内容")
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "t1",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
                    tableData = com.tabtin.mobile.features.doc.model.TableData(
                        rows = listOf(
                            com.tabtin.mobile.features.doc.model.TableRow(
                                listOf(projected, editable),
                            ),
                        ),
                    ),
                ),
            ),
        )

        vm.onAddTableRow("t1", afterRow = 0)
        vm.onAddTableColumn("t1", afterColumn = 0)

        val table = getBlocks().first().tableData!!
        assertEquals(2, table.rowCount)
        assertEquals(3, table.columnCount)
        assertTrue(table.rows[0].cells[0].isReadOnlyProjection)
        assertFalse(table.rows[0].cells[1].isReadOnlyProjection)
        assertEquals("普通内容", table.rows[0].cells[2].text)
        assertTrue(table.rows[1].cells.all { !it.isReadOnlyProjection })
    }

    @Test
    fun `table structure edits ignore merged cells without changing content`() = runTest(testDispatcher) {
        val merged = com.tabtin.mobile.features.doc.model.TableCell(
            text = "合并内容",
            colspan = 2,
        )
        val trailing = com.tabtin.mobile.features.doc.model.TableCell(text = "尾格")
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "t1",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
                    tableData = com.tabtin.mobile.features.doc.model.TableData(
                        rows = listOf(
                            com.tabtin.mobile.features.doc.model.TableRow(
                                listOf(merged, trailing),
                            ),
                        ),
                    ),
                ),
            ),
        )

        val before = checkNotNull(getBlocks().first().tableData)
        assertFalse(before.canAddRow)
        assertFalse(before.canAddColumn)

        vm.onAddTableRow("t1", afterRow = 0)
        vm.onAddTableColumn("t1", afterColumn = 0)

        assertEquals(before, getBlocks().first().tableData)
        assertFalse(vm.uiState.value.canUndo)
    }

    @Test
    fun `stale table callbacks cannot mutate a block that became read only`() = runTest(testDispatcher) {
        val originalTable = com.tabtin.mobile.features.doc.model.TableData(
            rows = listOf(
                com.tabtin.mobile.features.doc.model.TableRow(
                    cells = listOf(com.tabtin.mobile.features.doc.model.TableCell(text = "保留内容")),
                ),
            ),
        )
        injectBlocks(
            listOf(
                com.tabtin.mobile.features.doc.model.DocBlock(
                    id = "readonly-table",
                    kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
                    tableData = originalTable,
                    editable = false,
                ),
            ),
        )

        vm.onCellTextChanged("readonly-table", 0, 0, "陈旧输入")
        vm.onAddTableRow("readonly-table", afterRow = 0)
        vm.onAddTableColumn("readonly-table", afterColumn = 0)
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertEquals(originalTable, getBlocks().single().tableData)
        assertFalse(vm.uiState.value.canUndo)
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
    }

    @Test
    fun `unsupported duplicate does not create undo or dirty save`() = runTest(testDispatcher) {
        val table = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "table",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.TABLE,
            tableData = com.tabtin.mobile.features.doc.model.TableData.defaultEmpty(1, 1),
        )
        injectBlocks(listOf(table))
        vm.onBlockLongPress(table.id)

        vm.onDuplicateBlock()

        assertEquals(listOf(table), getBlocks())
        assertFalse(vm.uiState.value.canUndo)
        assertEquals(SaveState.IDLE, vm.uiState.value.saveState)
    }

    // ── redo stack cleared on new text input ──

    @Test
    fun `redo stack is cleared after new text input`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("v1")),
        )
        injectBlocks(listOf(block))

        vm.onTextChanged("b1", "v2", emptyList())
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        vm.undo()
        advanceTimeBy(50)
        assertTrue("canRedo should be true after undo", vm.uiState.value.canRedo)

        vm.onTextChanged("b1", "v3", emptyList())
        advanceTimeBy(DocEditorViewModel.TEXT_UNDO_DEBOUNCE_MS + 50)

        assertFalse("canRedo should be false after new edit", vm.uiState.value.canRedo)
    }

    // ── undo before debounce timer fires ──

    @Test
    fun `undo immediately after text change works without waiting for debounce`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("before")),
        )
        injectBlocks(listOf(block))

        vm.onTextChanged("b1", "after", emptyList())
        advanceTimeBy(100)

        vm.undo()
        advanceTimeBy(50)

        assertEquals("before", getBlocks().first().text)
    }

    // ── block operation flushes pending text undo ──

    @Test
    fun `block operation after text change creates two undo entries`() = runTest(testDispatcher) {
        val block = com.tabtin.mobile.features.doc.model.DocBlock(
            id = "b1",
            kind = com.tabtin.mobile.features.doc.model.BlockKind.PARAGRAPH,
            spans = listOf(com.tabtin.mobile.features.doc.model.InlineSpan("hello")),
        )
        injectBlocks(listOf(block))

        vm.onTextChanged("b1", "hello world", emptyList())
        advanceTimeBy(100)

        vm.onEnterPressed("b1", 5..5)
        advanceTimeBy(50)

        assertTrue(vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)
        assertTrue("Should still have undo (text change entry)", vm.uiState.value.canUndo)

        vm.undo()
        advanceTimeBy(50)

        assertEquals("hello", getBlocks().first().text)
    }

    private companion object {
        const val TEST_DOCUMENT_ID = "doc-undo"
        const val TEST_ORGANIZATION_ID = "org-undo"
    }
}
