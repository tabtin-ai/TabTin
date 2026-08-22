package com.tabtin.mobile.features.doc.editor.holders

import android.os.SystemClock
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.compose.ui.platform.ComposeView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import com.tabtin.mobile.databinding.*
import com.tabtin.mobile.features.doc.DocBlockGapDecoration
import com.tabtin.mobile.features.doc.comment.DocCommentsFooterUi
import com.tabtin.mobile.features.doc.editor.core.DocInlineImageLoader
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.model.TableData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Derived from anytype-kotlin core-ui BlockAdapter.
 * RecyclerView adapter for document editor blocks.
 * Routes each TabDocBlockView type to its corresponding ViewHolder.
 */
public class DocBlockAdapter(
    private val onTextChanged: (id: String, text: String, marks: List<TabDocMarkup.Mark>) -> Unit,
    private val onEnterPressed: (id: String, range: IntRange) -> Unit,
    private val onEmptyBackspace: (id: String) -> Unit,
    private val onFocusChanged: (id: String) -> Unit,
    private val onSlashEvent: (id: String, SlashTextWatcherState) -> Unit,
    private val onSelectionChanged: (id: String, IntRange) -> Unit,
    private val onCheckChanged: (id: String, isChecked: Boolean) -> Unit,
    private val onCodeTextChanged: (id: String, text: String) -> Unit,
    private val onTitleChanged: (title: String) -> Unit,
    private val onBlockLongPress: (id: String) -> Unit = {},
    private val onLanguageMenuClick: (id: String) -> Unit = {},
    private val onBlockClick: (id: String) -> Unit = {},
    private val onImagePlaceholderClick: (id: String) -> Unit = {},
    private val onTableCellClick: (
        blockId: String,
        row: Int,
        col: Int,
        tableData: TableData,
        isEditable: Boolean,
        canModifyStructure: Boolean,
    ) -> Unit = { _, _, _, _, _, _ -> },
    private val onCopyTable: (text: String) -> Unit = {},
    private val onAddTableRow: (blockId: String, afterRow: Int?) -> Unit = { _, _ -> },
    private val onAddTableColumn: (blockId: String, afterColumn: Int?) -> Unit = { _, _ -> },
    private val onCommentDraftChange: (String) -> Unit = {},
    private val onCommentSubmit: () -> Unit = {},
    /** 行内图片加载器；为 null 时行内图片保持诚实 alt 占位。 */
    private val inlineImageLoader: DocInlineImageLoader? = null,
    private val formulaLoader: com.tabtin.mobile.features.doc.editor.core.DocFormulaLoader = com.tabtin.mobile.features.doc.editor.core.DocFormulaLoader(),
) : RecyclerView.Adapter<DocBlockViewHolder>() {

    init {
        setHasStableIds(true)
    }

    public var itemTouchHelper: ItemTouchHelper? = null
    public var isSelectionMode: Boolean = false
    public var isReadOnly: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            notifyDataSetChanged()
        }

    private val items = mutableListOf<TabDocBlockView>()
    public var commentsUi: DocCommentsFooterUi = DocCommentsFooterUi()
        set(value) {
            if (field == value) return
            field = value
            val footer = items.indexOfFirst { it is TabDocBlockView.CommentsFooter }
            if (footer >= 0) notifyItemChanged(footer)
        }
    private var isDragActive = false
    private var dragActiveSince: Long = 0
    private val adapterScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var pendingUpdateJob: Job? = null
    private var gapDecoration: DocBlockGapDecoration? = null

    /** 拖拽期间跳过更新防冲突，超过 10 秒自动重置防卡死。diff 计算在后台线程执行。 */
    public fun update(newItems: List<TabDocBlockView>) {
        if (isDragActive) {
            if (SystemClock.elapsedRealtime() - dragActiveSince > DRAG_TIMEOUT_MS) {
                isDragActive = false
            } else {
                return
            }
        }
        pendingUpdateJob?.cancel()
        val oldSnapshot = items.toList()
        pendingUpdateJob = adapterScope.launch {
            val diff = withContext(Dispatchers.Default) {
                DiffUtil.calculateDiff(DocBlockDiffUtil(oldSnapshot, newItems))
            }
            if (!isActive) return@launch
            items.clear()
            items.addAll(newItems)
            diff.dispatchUpdatesTo(this@DocBlockAdapter)
        }
    }

    public fun destroy() {
        adapterScope.cancel()
    }

    public fun setDragActive(active: Boolean) {
        isDragActive = active
        if (active) dragActiveSince = SystemClock.elapsedRealtime()
    }

    override fun onAttachedToRecyclerView(recyclerView: RecyclerView) {
        super.onAttachedToRecyclerView(recyclerView)
        if (gapDecoration == null) {
            val decoration = DocBlockGapDecoration { position -> items.getOrNull(position) }
            gapDecoration = decoration
            recyclerView.addItemDecoration(decoration)
        }
    }

    override fun onDetachedFromRecyclerView(recyclerView: RecyclerView) {
        gapDecoration?.let(recyclerView::removeItemDecoration)
        gapDecoration = null
        super.onDetachedFromRecyclerView(recyclerView)
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = items[position].getViewType()

    override fun getItemId(position: Int): Long {
        val id = items[position].id
        if (id.length == 36 && id[8] == '-' && id[13] == '-') {
            return try {
                val uuid = java.util.UUID.fromString(id)
                uuid.mostSignificantBits xor uuid.leastSignificantBits
            } catch (_: IllegalArgumentException) {
                id.hashCode().toLong()
            }
        }
        return id.hashCode().toLong()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DocBlockViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TabDocBlockView.Types.PARAGRAPH -> ParagraphHolder(
                binding = DocBlockParagraphBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_ONE -> HeaderOneHolder(
                binding = DocBlockHeaderOneBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_TWO -> HeaderTwoHolder(
                binding = DocBlockHeaderTwoBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_THREE -> HeaderThreeHolder(
                binding = DocBlockHeaderThreeBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_FOUR -> HeaderFourHolder(
                binding = DocBlockHeaderFourBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_FIVE -> HeaderFiveHolder(
                binding = DocBlockHeaderFiveBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.HEADER_SIX -> HeaderSixHolder(
                binding = DocBlockHeaderSixBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.BULLETED -> BulletedHolder(
                binding = DocBlockBulletedBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.NUMBERED -> NumberedHolder(
                binding = DocBlockNumberedBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.CHECKBOX -> CheckboxHolder(
                binding = DocBlockCheckboxBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onCheckChanged = onCheckChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.QUOTE -> QuoteHolder(
                binding = DocBlockQuoteBinding.inflate(inflater, parent, false),
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.CODE -> CodeHolder(
                binding = DocBlockCodeBinding.inflate(inflater, parent, false),
                onTextChanged = { id, text -> onCodeTextChanged(id, text) },
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onBlockLongPress = onBlockLongPress,
                onLanguageMenuClick = onLanguageMenuClick,
            )
            TabDocBlockView.Types.DIVIDER_LINE -> DividerHolder(
                binding = DocBlockDividerBinding.inflate(inflater, parent, false),
                onBlockLongPress = onBlockLongPress,
            )
            TabDocBlockView.Types.IMAGE -> ImageHolder(
                binding = DocBlockImageBinding.inflate(inflater, parent, false),
                onBlockLongPress = onBlockLongPress,
                onImagePlaceholderClick = onImagePlaceholderClick,
                isSelectionModeProvider = { isSelectionMode },
            )
            TabDocBlockView.Types.TABLE -> TableHolder(
                binding = DocBlockTableBinding.inflate(inflater, parent, false),
                onBlockLongPress = onBlockLongPress,
                onCellClick = onTableCellClick,
                onCopyTable = onCopyTable,
                onAddTableRow = onAddTableRow,
                onAddTableColumn = onAddTableColumn,
                isSelectionModeProvider = { isSelectionMode },
            )
            TabDocBlockView.Types.TITLE -> TitleHolder(
                binding = DocBlockTitleBinding.inflate(inflater, parent, false),
                onTitleChanged = onTitleChanged,
                onFocusChanged = onFocusChanged,
            )
            TabDocBlockView.Types.COMMENTS -> CommentsHolder(
                composeView = ComposeView(parent.context),
                commentsProvider = { commentsUi },
                onDraftChange = onCommentDraftChange,
                onSubmit = onCommentSubmit,
            )
            TabDocBlockView.Types.FORMULA -> FormulaHolder(
                binding = DocBlockFormulaBinding.inflate(inflater, parent, false),
                onBlockLongPress = onBlockLongPress,
            )
            else -> UnsupportedHolder(
                binding = DocBlockUnsupportedBinding.inflate(inflater, parent, false),
                onBlockLongPress = onBlockLongPress,
            )
        }.also { holder ->
            (holder as? TextHolder)?.inlineImageLoader = inlineImageLoader
            (holder as? TextHolder)?.formulaLoader = formulaLoader
            holder.setupDrag { itemTouchHelper?.startDrag(holder) }
            holder.itemView.setOnClickListener {
                val pos = holder.bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION && isSelectionMode &&
                    items[pos] !is TabDocBlockView.Title &&
                    items[pos] !is TabDocBlockView.CommentsFooter
                ) {
                    onBlockClick(items[pos].id)
                }
            }
        }
    }

    override fun onViewRecycled(holder: DocBlockViewHolder) {
        super.onViewRecycled(holder)
        holder.onRecycled()
    }

    override fun onBindViewHolder(holder: DocBlockViewHolder, position: Int) {
        holder.bind(items[position])
        holder.setReadOnly(effectiveReadOnly(items[position]))
    }

    @Suppress("UNCHECKED_CAST")
    override fun onBindViewHolder(holder: DocBlockViewHolder, position: Int, payloads: MutableList<Any>) {
        if (payloads.isEmpty()) {
            holder.bind(items[position])
        } else {
            val changes = mutableSetOf<Int>()
            for (payload in payloads) {
                (payload as? Set<*>)?.filterIsInstance<Int>()?.let { changes.addAll(it) }
            }
            if (changes.isNotEmpty()) {
                holder.processPayload(items[position], changes)
            } else {
                holder.bind(items[position])
            }
        }
        holder.setReadOnly(effectiveReadOnly(items[position]))
    }

    /** 文档级只读（权限等）或块级只读（复杂表格、既有图片等局部保留块）。 */
    private fun effectiveReadOnly(item: TabDocBlockView): Boolean =
        isBlockEffectivelyReadOnly(item, isReadOnly)

    public fun getItem(position: Int): TabDocBlockView? = items.getOrNull(position)

    public fun indexOf(blockId: String): Int = items.indexOfFirst { it.id == blockId }

    public fun moveItem(from: Int, to: Int) {
        if (from < 0 || to < 0 || from >= items.size || to >= items.size || from == to) return
        val item = items.removeAt(from)
        items.add(to, item)
        notifyItemMoved(from, to)
    }

    public companion object {
        private const val DRAG_TIMEOUT_MS = 10_000L
    }
}

internal fun isBlockEffectivelyReadOnly(
    item: TabDocBlockView,
    documentReadOnly: Boolean,
): Boolean = documentReadOnly || when (item) {
    is TabDocBlockView.Image -> item.isReadOnly
    is TabDocBlockView.Table -> item.isReadonly
    is TabDocBlockView.Formula -> true
    else -> false
}
