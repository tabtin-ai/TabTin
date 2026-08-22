package com.tabtin.mobile.features.doc.editor.holders

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.View
import androidx.recyclerview.widget.RecyclerView
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

/**
 * 所有文档块 ViewHolder 的抽象基类。
 * 每个子类负责绑定一种 TabDocBlockView 类型。
 */
public abstract class DocBlockViewHolder(view: View) : RecyclerView.ViewHolder(view) {

    protected fun applySelectionState(selected: Boolean) {
        itemView.foreground = if (selected) ColorDrawable(SELECTION_BG_COLOR) else null
        itemView.isSelected = selected
    }

    public abstract fun bind(item: TabDocBlockView)

    /** 将可交互块切换为纯展示；复杂文档用它避免出现“能改但不会保存”的假交互。 */
    public open fun setReadOnly(readOnly: Boolean) {}

    /**
     * 增量更新 —— 由 DiffUtil payload 驱动，仅更新变化的属性。
     * 默认实现回退到全量 bind。子类应覆写以实现精确更新。
     */
    public open fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        bind(item)
    }

    /**
     * 连接拖拽触发器。子类可覆写以将 EditorTouchProcessor 的
     * onDragAndDropTrigger 回调绑定到 startDrag 回调。
     */
    public open fun setupDrag(startDrag: () -> Unit) {}

    /** ViewHolder 回收时释放资源（延迟任务等）。 */
    public open fun onRecycled() {}

    public companion object {
        private val SELECTION_BG_COLOR = Color.parseColor("#1A2196F3")
    }
}
