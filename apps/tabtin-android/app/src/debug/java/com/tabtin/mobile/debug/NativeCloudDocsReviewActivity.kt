package com.tabtin.mobile.debug

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.features.doc.DocEditorReviewSurface
import com.tabtin.mobile.features.doc.DocEditorViewModel
import com.tabtin.mobile.features.doc.SaveState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow
import com.tabtin.mobile.features.tabdata.NativeTabDataRecordReviewSurface
import com.tabtin.mobile.features.tabdata.NativeTabDataUiState
import com.tabtin.mobile.features.tabdata.TabDataDraftPolicy
import com.tabtin.mobile.features.tabdata.TabDataCardListReviewSurface
import com.tabtin.mobile.ui.theme.TabTinTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * TabDoc / TabData 的 debug-only 设备验收入口。生产页面、卡片和记录表单均直接复用，
 * 只由固定 fixture 替代登录和网络，避免视觉验收被测试账号状态阻断。
 */
public class NativeCloudDocsReviewActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { TabTinTheme { NativeCloudDocsReviewRoot() } }
    }
}

private enum class ReviewTab { DOCUMENT, TABLE, COMPLEX }

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NativeCloudDocsReviewRoot() {
    var tab by remember { mutableStateOf(ReviewTab.DOCUMENT) }
    val imeVisible = WindowInsets.isImeVisible
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            if (!imeVisible) NavigationBar {
                NavigationBarItem(
                    selected = tab == ReviewTab.DOCUMENT,
                    onClick = { tab = ReviewTab.DOCUMENT },
                    icon = { Icon(Icons.Default.Description, contentDescription = null) },
                    label = { Text("文档") },
                )
                NavigationBarItem(
                    selected = tab == ReviewTab.TABLE,
                    onClick = { tab = ReviewTab.TABLE },
                    icon = { Icon(Icons.Default.GridView, contentDescription = null) },
                    label = { Text("多维表") },
                )
                NavigationBarItem(
                    selected = tab == ReviewTab.COMPLEX,
                    onClick = { tab = ReviewTab.COMPLEX },
                    icon = { Icon(Icons.Default.Lock, contentDescription = null) },
                    label = { Text("复杂表格") },
                )
            }
        },
    ) { padding ->
        when (tab) {
            ReviewTab.DOCUMENT -> DocEditorReviewSurface(
                initialState = NativeCloudReviewFixtures.documentState(complex = false),
                modifier = Modifier.padding(padding),
            )
            ReviewTab.TABLE -> TabDataReviewRoot(modifier = Modifier.padding(padding))
            ReviewTab.COMPLEX -> DocEditorReviewSurface(
                initialState = NativeCloudReviewFixtures.documentState(complex = true),
                modifier = Modifier.padding(padding),
                onOpenFullEditor = {},
            )
        }
    }
}

@Composable
private fun TabDataReviewRoot(modifier: Modifier = Modifier) {
    var state by remember { mutableStateOf(NativeCloudReviewFixtures.tableState()) }
    var detailVisible by remember { mutableStateOf(false) }
    Scaffold(modifier = modifier.fillMaxSize()) { padding ->
        TabDataCardListReviewSurface(
            state = state,
            onOpenRecord = { record ->
                val draft = TabDataDraftPolicy.initialDraft(record, state.fields)
                state = state.copy(
                    selectedRecord = record,
                    detailDraft = draft,
                    detailOriginal = draft,
                )
                detailVisible = true
            },
            modifier = Modifier.padding(padding),
        )
    }
    if (detailVisible) {
        NativeTabDataRecordReviewSurface(
            initialState = state,
            onDismiss = { detailVisible = false },
        )
    }
}

private object NativeCloudReviewFixtures {
    fun documentState(complex: Boolean): DocEditorViewModel.UiState {
        val normalBlocks = listOf(
            TabDocBlockView.Text.HeaderOne("heading", "原生体验验收"),
            TabDocBlockView.Text.Paragraph("intro", "移动端不复刻桌面画布，而是把内容整理成适合单手阅读和编辑的纵向信息流。"),
            TabDocBlockView.Text.Bulleted("bullet-1", "标题与正文直接编辑"),
            TabDocBlockView.Text.Bulleted("bullet-2", "离开页面前自动保存"),
            TabDocBlockView.Text.Checkbox("task-1", "双端原生入口", isChecked = true),
            TabDocBlockView.Text.Checkbox("task-2", "设备视觉验收", isChecked = false),
            TabDocBlockView.Text.Quote("quote", "样式可以不同，但用户任务必须完整。"),
            TabDocBlockView.Code("code", "入口 → 原生页面 → 自动保存"),
            TabDocBlockView.Table("table", TableData.defaultEmpty(rowCount = 3, colCount = 2)),
        )
        val complexBlocks = listOf(
            TabDocBlockView.Text.HeaderOne("complex-heading", "复杂表格逐格编辑"),
            TabDocBlockView.Text.Paragraph(
                "complex-intro",
                "普通文本格可以继续编辑；列表、公式和嵌套块等复杂格会带锁只读并原样保存。",
            ),
            TabDocBlockView.Table("mixed-complex-table", complexTableData()),
            TabDocBlockView.Text.Paragraph(
                "complex-tail",
                "横向滑动查看其它列，点击任意格可查看完整内容和表格操作。",
            ),
        )
        return DocEditorViewModel.UiState(
            documentId = if (complex) "review-complex" else "review-document",
            title = if (complex) "复杂表格 · 安全编辑" else "移动端原生云文档方案",
            blockViews = if (complex) complexBlocks else normalBlocks,
            isLoading = false,
            saveState = SaveState.SAVED,
            requiresFullEditor = false,
        )
    }

    private fun complexTableData(): TableData {
        val headers = listOf("事项", "负责人", "状态", "说明", "验收结果")
        val rows = mutableListOf(
            TableRow(headers.map { value -> reviewTableCell(value, isHeader = true) }),
        )
        repeat(19) { index ->
            val rowNumber = index + 1
            rows += TableRow(
                listOf(
                    if (rowNumber == 1) {
                        projectedReviewTableCell("• 需求确认\n• 原生验收\n• 发布回归")
                    } else {
                        reviewTableCell("移动端任务 $rowNumber")
                    },
                    reviewTableCell(if (rowNumber == 1) "" else listOf("林晓", "陈默", "小锡")[index % 3]),
                    reviewTableCell(listOf("待处理", "处理中", "已完成")[index % 3]),
                    if (rowNumber % 3 == 0) {
                        projectedReviewTableCell("公式：完成率 = 已完成 / 总数\n备注：保留原始数学节点")
                    } else {
                        reviewTableCell("第 $rowNumber 行普通文本，可在移动端继续修改")
                    },
                    if (rowNumber % 4 == 0) {
                        projectedReviewTableCell("☑ iOS\n☐ Android\n嵌套清单保持只读")
                    } else {
                        reviewTableCell("待验收")
                    },
                ),
            )
        }
        return TableData(rows)
    }

    private fun reviewTableCell(value: String, isHeader: Boolean = false): TableCell = TableCell(
        text = value,
        spans = if (value.isEmpty()) emptyList() else listOf(InlineSpan(value)),
        isHeader = isHeader,
    )

    private fun projectedReviewTableCell(value: String): TableCell = TableCell(
        text = value,
        spans = listOf(InlineSpan(value)),
        rawNode = mapOf(
            "type" to "tableCell",
            "content" to listOf(
                mapOf("type" to "paragraph"),
                mapOf("type" to "bulletList"),
            ),
        ),
        isReadOnlyProjection = true,
    )

    fun tableState(): NativeTabDataUiState {
        val tableId = "review-table"
        val fields = listOf(
            TabDataField("title", tableId, "事项", "text", isPrimary = true, order = 0),
            TabDataField("owner", tableId, "负责人", "text", order = 1),
            TabDataField(
                "status", tableId, "状态", "select", order = 2,
                options = JsonObject(mapOf("choices" to kotlinx.serialization.json.JsonArray(listOf(
                    JsonObject(mapOf("value" to JsonPrimitive("todo"), "label" to JsonPrimitive("待处理"))),
                    JsonObject(mapOf("value" to JsonPrimitive("doing"), "label" to JsonPrimitive("进行中"))),
                    JsonObject(mapOf("value" to JsonPrimitive("done"), "label" to JsonPrimitive("已完成"))),
                )))),
            ),
            TabDataField("priority", tableId, "优先级", "text", order = 3),
            TabDataField("due", tableId, "截止日期", "date", order = 4),
            TabDataField("note", tableId, "备注", "long_text", order = 5),
        )
        val view = TabDataView(
            id = "view-all", tableId = tableId, name = "全部记录", viewType = "grid",
            visibleFields = fields.map(TabDataField::id), fieldOrder = fields.map(TabDataField::id),
            config = JsonObject(mapOf("card_title_field" to JsonPrimitive("title"))),
        )
        fun record(id: String, title: String, owner: String, status: String, priority: String, note: String) =
            TabDataRecord(
                id = id,
                tableId = tableId,
                fields = JsonObject(mapOf(
                    "title" to JsonPrimitive(title), "owner" to JsonPrimitive(owner),
                    "status" to JsonPrimitive(status), "priority" to JsonPrimitive(priority),
                    "due" to JsonPrimitive("2026-08-15"), "note" to JsonPrimitive(note),
                )),
                version = 3,
            )
        val records = listOf(
            record("r1", "iOS 键盘与安全区验收", "林晓", "doing", "P0", "覆盖标题、长文本和保存反馈"),
            record("r2", "Android 卡片与记录表单", "陈默", "todo", "P1", "不复刻桌面二维网格"),
            record("r3", "复杂结构降级回程", "小锡", "done", "P1", "原生只读，Web 完整编辑"),
        )
        return NativeTabDataUiState(
            tableId = tableId,
            table = TabDataTable(
                id = tableId, name = "移动端验收清单", organizationId = "review-organization",
                defaultViewId = view.id, currentUserRole = "editor",
            ),
            views = listOf(view), fields = fields, selectedViewId = view.id,
            records = records, total = records.size, isLoading = false,
        )
    }
}
