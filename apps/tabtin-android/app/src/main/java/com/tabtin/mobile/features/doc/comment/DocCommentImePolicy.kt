package com.tabtin.mobile.features.doc.comment

import android.graphics.Rect
import android.view.View
import android.view.ViewParent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.RecyclerView

/**
 * 文末评论输入在 RecyclerView footer 里。全页不能加 imePadding（格式栏要贴键盘顶），
 * 所以键盘弹起时加大列表底内边距，输入框聚焦后再把最后一项滚到可见区。
 */
public object DocCommentImePolicy {
    public fun recyclerViewBottomPaddingPx(
        imeVisible: Boolean,
        imeBottomPx: Int,
        showFormatToolbar: Boolean,
        restingPx: Int,
        formatRoomPx: Int,
    ): Int {
        if (!imeVisible) return restingPx
        val keyboardRoom = imeBottomPx + restingPx
        val toolbarRoom = if (showFormatToolbar) formatRoomPx else restingPx
        return maxOf(keyboardRoom, toolbarRoom)
    }

    public fun liftBottomPx(inputFocused: Boolean, imeBottomPx: Int): Int =
        if (inputFocused && imeBottomPx > 0) imeBottomPx else 0

    public fun readRootImeBottomPx(view: View): Int =
        ViewCompat.getRootWindowInsets(view)
            ?.getInsets(WindowInsetsCompat.Type.ime())
            ?.bottom
            ?: 0

    public fun findAncestorRecyclerView(view: View): RecyclerView? {
        var current: ViewParent? = view.parent
        while (current != null) {
            if (current is RecyclerView) return current
            current = current.parent
        }
        return null
    }

    public fun revealComposerAboveIme(host: View) {
        val rv = findAncestorRecyclerView(host)
        if (rv == null) {
            host.requestRectangleOnScreen(Rect(0, 0, host.width, host.height), true)
            return
        }
        val last = (rv.adapter?.itemCount ?: 0) - 1
        if (last < 0) return
        rv.post {
            rv.smoothScrollToPosition(last)
            rv.post {
                val item = rv.findViewHolderForAdapterPosition(last)?.itemView ?: return@post
                val extra = item.bottom - rv.height + rv.paddingBottom
                if (extra > 0) rv.scrollBy(0, extra)
            }
        }
    }
}
