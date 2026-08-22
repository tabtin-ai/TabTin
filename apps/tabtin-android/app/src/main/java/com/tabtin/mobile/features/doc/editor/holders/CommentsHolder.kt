package com.tabtin.mobile.features.doc.editor.holders

import android.util.SparseIntArray
import android.view.View
import android.view.ViewGroup
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.recyclerview.widget.RecyclerView
import com.tabtin.mobile.features.doc.comment.DocCommentDockPolicy
import com.tabtin.mobile.features.doc.comment.DocCommentSection
import com.tabtin.mobile.features.doc.comment.DocCommentsFooterUi
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.ui.theme.TabTinTheme
import com.tabtin.mobile.ui.theme.ThemeManager
import com.tabtin.mobile.ui.theme.ThemeManagerEntryPoint
import dagger.hilt.android.EntryPointAccessors

public class CommentsHolder(
    private val composeView: ComposeView,
    private val commentsProvider: () -> DocCommentsFooterUi,
    private val onDraftChange: (String) -> Unit,
    private val onSubmit: () -> Unit,
) : DocBlockViewHolder(composeView) {

    private var extraTopPx by mutableIntStateOf(0)
    private val precedingHeights = SparseIntArray()
    private var lastItemCount: Int = -1
    private var dockAttached: Boolean = false

    private val dockLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        composeView.post { applyDock() }
    }

    private val attachListener = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) {
            val rv = v.parent as? RecyclerView ?: return
            if (!dockAttached) {
                rv.addOnLayoutChangeListener(dockLayoutListener)
                dockAttached = true
            }
            v.post { applyDock() }
        }

        override fun onViewDetachedFromWindow(v: View) {
            val rv = v.parent as? RecyclerView
            if (dockAttached) {
                rv?.removeOnLayoutChangeListener(dockLayoutListener)
                dockAttached = false
            }
        }
    }

    init {
        composeView.layoutParams = RecyclerView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        composeView.setViewCompositionStrategy(
            ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed,
        )
        composeView.addOnAttachStateChangeListener(attachListener)
    }

    override fun bind(item: TabDocBlockView) {
        render()
        composeView.post { applyDock() }
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        render()
        composeView.post { applyDock() }
    }

    override fun setupDrag(startDrag: () -> Unit) {}

    override fun onRecycled() {
        extraTopPx = 0
        precedingHeights.clear()
        lastItemCount = -1
    }

    private fun render() {
        val ui = commentsProvider()
        composeView.setContent {
            val extra = extraTopPx
            val extraDp = with(LocalDensity.current) { extra.toDp() }
            val themeManager = rememberThemeManager()
            val themeMode by themeManager.themeMode.collectAsState(themeManager.initialThemeMode)
            val colorSchemeId by themeManager.colorSchemeId.collectAsState(themeManager.initialColorSchemeId)
            TabTinTheme(themeMode = themeMode, colorSchemeId = colorSchemeId) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    if (extra > 0) {
                        Spacer(Modifier.height(extraDp))
                    }
                    DocCommentSection(
                        presentations = ui.presentations,
                        draft = ui.draft,
                        canCreate = ui.canCreate,
                        isPosting = ui.isPosting,
                        onDraftChange = onDraftChange,
                        onSubmit = onSubmit,
                    )
                }
            }
        }
    }

    private fun applyDock() {
        val rv = composeView.parent as? RecyclerView ?: return
        val layoutManager = rv.layoutManager ?: return
        val itemCount = rv.adapter?.itemCount ?: return
        if (itemCount <= 0) return
        if (itemCount != lastItemCount) {
            precedingHeights.clear()
            lastItemCount = itemCount
        }
        val last = itemCount - 1
        val heights = buildList(last) {
            for (index in 0 until last) {
                val child = layoutManager.findViewByPosition(index)
                if (child != null) {
                    precedingHeights.put(index, child.height)
                    add(child.height)
                } else {
                    val cached = precedingHeights.get(index, -1)
                    add(if (cached >= 0) cached else null)
                }
            }
        }
        val preceding = DocCommentDockPolicy.sumKnownHeightsOrNull(heights) ?: return
        val footerContent = (composeView.height - extraTopPx).coerceAtLeast(0)
        if (footerContent == 0 && composeView.height == 0) return
        val viewport = (rv.height - rv.paddingTop - rv.paddingBottom).coerceAtLeast(0)
        val next = DocCommentDockPolicy.extraTopPx(viewport, preceding, footerContent)
        if (next != extraTopPx) {
            extraTopPx = next
        }
    }
}

@Composable
private fun rememberThemeManager(): ThemeManager {
    val context = LocalContext.current
    return remember(context) {
        EntryPointAccessors.fromApplication(
            context.applicationContext,
            ThemeManagerEntryPoint::class.java,
        ).themeManager()
    }
}
