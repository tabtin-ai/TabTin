package com.tabtin.mobile.features.conversation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.tabtin.mobile.R
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/** 展开程度：0 = 收起，1 = overlay 扩展档。用于 scrim 深浅。 */
private fun layerProgress(topRatio: Float): Float =
    (
        (ConversationLayerGeometry.COLLAPSED_TOP_RATIO - topRatio) /
            (ConversationLayerGeometry.COLLAPSED_TOP_RATIO -
                ConversationLayerGeometry.EXPANDED_TOP_RATIO)
        ).coerceIn(0f, 1f)

private val LayerCornerRadius = 20.dp
private val GrabberWidth = 36.dp
private val GrabberHeight = 4.dp

/**
 * 对话层宿主：把对话渲染成盖在工作台之上、可连续伸缩的一层。
 *
 * 层顶抓手承接展开态的跟手拖拽；收起态的拖拽由胶囊发起（见 Task 11 的接线），
 * 两者最终都落到同一个 [ConversationLayerState]。
 *
 * 只在窄屏使用；宽屏三态仍走 [TaskSurfaceHost]。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ConversationLayerHost(
    state: ConversationLayerState,
    onDetentSettled: (ConversationLayerDetent) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val grabberHint = stringResource(R.string.conversation_layer_a11y_grabber)
    val expandLabel = stringResource(R.string.conversation_layer_a11y_expand)
    val collapseLabel = stringResource(R.string.conversation_layer_a11y_collapse)
    val closeLabel = stringResource(R.string.common_close)
    val scrimInteractionSource = remember { MutableInteractionSource() }
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val imeVisible = WindowInsets.isImeVisible
    var expandedForIme by remember { mutableStateOf(false) }
    fun settleTo(target: ConversationLayerDetent) {
        scope.launch {
            state.animateTo(target)
            onDetentSettled(target)
        }
    }

    LaunchedEffect(imeVisible) {
        val target = ConversationLayerImePolicy.target(
            imeVisible = imeVisible,
            detent = state.detent,
            expandedForIme = expandedForIme,
        )
        if (imeVisible && target == ConversationLayerDetent.EXPANDED) {
            expandedForIme = true
        } else if (!imeVisible) {
            expandedForIme = false
        }
        if (target != null) {
            state.animateTo(target)
            onDetentSettled(target)
        }
    }

    // 抓手的读屏对等物：拖拽对 TalkBack 不可用，overlay 的档位切换必须有显式动作。
    val expandTarget = when (state.detent) {
        ConversationLayerDetent.COLLAPSED -> ConversationLayerDetent.SHEET
        ConversationLayerDetent.SHEET -> ConversationLayerDetent.EXPANDED
        ConversationLayerDetent.EXPANDED -> null
    }
    val collapseTarget = when (state.detent) {
        ConversationLayerDetent.EXPANDED -> ConversationLayerDetent.SHEET
        ConversationLayerDetent.SHEET -> ConversationLayerDetent.COLLAPSED
        ConversationLayerDetent.COLLAPSED -> null
    }
    val grabberActions = buildList {
        expandTarget?.let { target ->
            add(
                CustomAccessibilityAction(expandLabel) {
                    settleTo(target)
                    true
                },
            )
        }
        collapseTarget?.let { target ->
            add(
                CustomAccessibilityAction(collapseLabel) {
                    settleTo(target)
                    true
                },
            )
        }
    }

    BackHandler(enabled = state.detent != ConversationLayerDetent.COLLAPSED) {
        val target = state.collapseTargetOnBack() ?: return@BackHandler
        scope.launch {
            state.animateTo(target)
            onDetentSettled(target)
        }
    }

    val dragState = rememberDraggableState { deltaPx -> state.dragByPx(deltaPx) }

    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { state.viewportHeightPx = it.height },
    ) {
        // 视觉层永远只绘制、不参与命中。这样从胶囊拖起时即使 detent 尚未落档，
        // 背景也会按连续 topRatio 渐暗，而不是松手后突然跳出 scrim。
        Box(
            modifier = Modifier
                .fillMaxSize()
                .zIndex(1f)
                .drawBehind {
                    drawRect(Color.Black, alpha = 0.28f * layerProgress(state.topRatio))
                },
        )

        // 命中层只在展开档位组合。收起态若留下 disabled clickable，它仍会成为
        // 全屏 PointerInput 命中节点，导致下面的工作台看得见却收不到滚动和点击。
        val backdropTarget =
            TaskSurfaceCoordinator.conversationBackdropTargetCompact(state.detent)
        if (backdropTarget != null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(1f)
                    .clickable(
                        interactionSource = scrimInteractionSource,
                        indication = null,
                    ) {
                        settleTo(backdropTarget)
                    },
            )
        }

        // 层只占「可见高度」并底部对齐：对话内容的输入区锚在自身底部，
        // 若按全视口高度布局再整体下移，半屏档下输入区会落到屏幕外。
        // 在 layout 阶段读 topRatio，拖拽每帧只 relayout、不重组。
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .zIndex(2f)
                .layout { measurable, constraints ->
                    // 分母必须和 dragByPx 用的是同一个数，否则拖 1px 层动的不是 1px。
                    // 首帧 onSizeChanged 还没回调时退回约束高度。
                    val full = state.viewportHeightPx.takeIf { it > 0 }
                        ?: constraints.maxHeight.takeIf { constraints.hasBoundedHeight }
                        ?: 0
                    val visible = ((1f - state.topRatio) * full).roundToInt().coerceIn(0, full)
                    val placeable = measurable.measure(
                        constraints.copy(minHeight = visible, maxHeight = visible),
                    )
                    layout(constraints.maxWidth, full) {
                        placeable.place(0, full - visible)
                    }
                }
                .clip(
                    RoundedCornerShape(
                        topStart = LayerCornerRadius,
                        topEnd = LayerCornerRadius,
                    ),
                )
                .background(MaterialTheme.colorScheme.surface),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // 抓手保留足够的透明命中高度，但不再重复放「回到工作台」按钮；
                // 半屏点外侧背景即可退出。抓手区与消息列表分离，避免抢滚动。
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(
                            min = ConversationLayerGeometry.MIN_GRABBER_TOUCH_TARGET_DP.dp,
                        )
                        .draggable(
                            state = dragState,
                            orientation = Orientation.Vertical,
                            onDragStopped = { velocityPxPerSec ->
                                val velocityDpPerMs =
                                    with(density) { (velocityPxPerSec / 1000f).toDp().value }
                                state.settle(velocityDpPerMs)
                                onDetentSettled(state.detent)
                            },
                        )
                        .semantics {
                            contentDescription = grabberHint
                            customActions = grabberActions
                        },
                ) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .size(width = GrabberWidth, height = GrabberHeight)
                            .clip(RoundedCornerShape(GrabberHeight / 2))
                            .background(MaterialTheme.colorScheme.outlineVariant),
                    )

                    IconButton(
                        onClick = {
                            expandedForIme = false
                            focusManager.clearFocus(force = true)
                            keyboardController?.hide()
                            settleTo(ConversationLayerDetent.COLLAPSED)
                        },
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .padding(end = 8.dp)
                            .size(48.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(32.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = Icons.Default.Close,
                                contentDescription = closeLabel,
                                tint = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }

                Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                    content()
                }
            }
        }
    }
}
