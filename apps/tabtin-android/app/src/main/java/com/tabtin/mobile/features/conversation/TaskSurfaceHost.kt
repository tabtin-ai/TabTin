package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.features.workbench.TaskWorkbenchApp
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.features.workbench.WorkbenchSurface
import com.tabtin.mobile.features.workbench.WorkbenchViewModel
import com.tabtin.mobile.ui.theme.rememberReduceMotion

/**
 * 任务工作面宿主：≥[TaskSurfaceCoordinator.REGULAR_WIDTH_DP] 三态；对话与工作台各组合一次（keep-alive），
 * 只改 width / alpha；split ⇄ app-focus 播放几何 ghost（无真实对话子树）。
 * 右缘固定、左缘伸缩。
 *
 * Morph 几何：胶囊与对话 rail 均经 [onGloballyPositioned] 实测（宿主坐标系），
 * 仅在尚未测到时回退布局估算，避免右下角近似飞偏。
 *
 * Reduce Motion（`ANIMATOR_DURATION_SCALE == 0`）：跳过 ghost，立即切几何；
 * 焦点随 [TaskSurfaceMode]（验收：双向/中途反向无残层见单测）。
 */
@Composable
public fun TaskSurfaceHost(
    organizationId: String,
    spaceId: String?,
    workbenchOpen: Boolean,
    preferAppFocus: Boolean = false,
    workbenchFraction: Float = 0.4f,
    initialOpenRequest: WorkbenchResourceOpenRequest? = null,
    onInitialOpenRequestConsumed: (WorkbenchResourceOpenRequest) -> Unit = {},
    onFocusChanged: (WorkbenchFocusTarget) -> Unit,
    onDismissWorkbench: () -> Unit,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onResourceOpen: (SpaceResource) -> Unit,
    onSendReference: ((ResourceReference) -> Unit)?,
    onRequestApp: ((TaskWorkbenchApp) -> Unit)? = null,
    conversationMessages: List<ChatMessage> = emptyList(),
    workbenchViewModel: WorkbenchViewModel,
    conversationContent: @Composable () -> Unit,
    capsuleOverlay: @Composable (onChromePositioned: (LayoutCoordinates) -> Unit) -> Unit,
    onModeChanged: (TaskSurfaceMode) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val reduceMotion = rememberReduceMotion()

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val widthDp = maxWidth.value
        val heightDp = maxHeight.value
        var everOpened by remember { mutableStateOf(false) }
        if (workbenchOpen) everOpened = true

        val mode = TaskSurfaceCoordinator.resolveMode(
            TaskSurfaceLayout(
                widthDp = widthDp.toInt(),
                workbenchOpen = workbenchOpen,
                preferAppFocus = preferAppFocus,
            ),
        )
        val modeCallback by rememberUpdatedState(onModeChanged)
        LaunchedEffect(mode) { modeCallback(mode) }

        val keepWorkbench = TaskSurfaceCoordinator.shouldComposeWorkbench(
            mode = mode,
            everOpened = everOpened,
            workbenchOpen = workbenchOpen,
            widthDp = widthDp.toInt(),
        )
        val geometry = TaskSurfaceStableLayout.geometry(
            mode = mode,
            availableWidthDp = widthDp,
            workbenchFraction = workbenchFraction,
        )
        val showCapsule = TaskSurfaceCoordinator.capsuleLayoutAllows(
            mode = mode,
            widthDp = widthDp.toInt(),
            workbenchOpen = workbenchOpen,
        )

        val morph = remember { TaskSurfaceMorphCoordinator() }
        var previousMode by remember { mutableStateOf<TaskSurfaceMode?>(null) }
        var ghostRect by remember { mutableStateOf<MorphRect?>(null) }
        var ghostCorner by remember { mutableStateOf(TaskSurfaceMorphTiming.RAIL_CORNER_RADIUS_DP) }
        var ghostAlpha by remember { mutableStateOf(0f) }
        var hideCapsule by remember { mutableStateOf(false) }
        var hideRail by remember { mutableStateOf(false) }
        // R2-动效：宿主坐标系下实测胶囊 / 对话 rail（非右下角估算）
        var measuredCapsule by remember { mutableStateOf<MorphRect?>(null) }
        var measuredRail by remember { mutableStateOf<MorphRect?>(null) }
        var hostCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }

        fun morphRectFromChild(child: LayoutCoordinates): MorphRect? {
            val host = hostCoordinates
            if (host == null || !host.isAttached || !child.isAttached) return null
            val bounds = host.localBoundingBoxOf(child)
            val w = with(density) { bounds.width.toDp().value }
            val h = with(density) { bounds.height.toDp().value }
            if (w < 1f || h < 1f) return null
            return MorphRect(
                left = with(density) { bounds.left.toDp().value },
                top = with(density) { bounds.top.toDp().value },
                width = w,
                height = h,
            )
        }

        LaunchedEffect(mode, reduceMotion, widthDp, heightDp, workbenchFraction, measuredCapsule, measuredRail) {
            val prev = previousMode
            if (prev == null) {
                previousMode = mode
                return@LaunchedEffect
            }
            if (prev == mode) return@LaunchedEffect
            previousMode = mode

            val splitRailFallback = TaskSurfaceStableLayout.splitConversationTarget(
                containerLeft = 0f,
                containerTop = 0f,
                containerWidth = widthDp,
                containerHeight = heightDp,
                workbenchFraction = workbenchFraction,
            )
            // SPLIT→APP：用上次实测 rail；APP→SPLIT：用上次实测胶囊；缺测才回退估算
            val rail = measuredRail?.takeIf { it.width >= 1f && it.height >= 1f }
                ?: splitRailFallback
            val capsule = measuredCapsule?.takeIf { it.width >= 1f && it.height >= 1f }
                ?: MorphRect(
                    left = (widthDp - 64f).coerceAtLeast(0f),
                    top = (heightDp - 64f).coerceAtLeast(0f),
                    width = 48f,
                    height = 48f,
                )
            val now = System.currentTimeMillis()
            val direction = morph.beginTransition(
                previous = prev,
                next = mode,
                railRect = rail,
                capsuleRect = capsule,
                reduceMotion = reduceMotion,
                nowMs = now,
            )
            val gen = morph.currentGeneration
            if (direction == null) {
                ghostAlpha = 0f
                ghostRect = null
                hideCapsule = false
                hideRail = false
                return@LaunchedEffect
            }

            try {
                if (!morph.isCurrentGeneration(gen)) return@LaunchedEffect

                // 单实体：hide 只跟 coordinator 一代；旧 generation 不得再写
                hideCapsule = morph.shouldHideCapsule(now)
                hideRail = morph.shouldHideRail(now)
                val target = when (direction) {
                    TaskSurfaceMorphDirection.TO_CAPSULE -> capsule
                    TaskSurfaceMorphDirection.TO_RAIL -> rail
                }
                if (!morph.consume(direction, target, now)) {
                    hideCapsule = false
                    hideRail = false
                    return@LaunchedEffect
                }
                val snapshot = morph.activeSnapshot() ?: return@LaunchedEffect
                val (from, to) = snapshot
                ghostAlpha = 1f
                ghostRect = from
                ghostCorner = if (direction == TaskSurfaceMorphDirection.TO_CAPSULE) {
                    TaskSurfaceMorphTiming.RAIL_CORNER_RADIUS_DP
                } else {
                    from.height / 2f
                }

                val progress = Animatable(0f)
                progress.animateTo(
                    targetValue = 1f,
                    animationSpec = tween(
                        durationMillis = TaskSurfaceMorphTiming.DURATION_MS,
                        easing = TaskSurfaceMorphTiming.Easing,
                    ),
                ) {
                    if (!morph.isCurrentGeneration(gen)) return@animateTo
                    ghostRect = TaskSurfaceMorphCoordinator.lerp(from, to, value)
                    ghostCorner = if (direction == TaskSurfaceMorphDirection.TO_CAPSULE) {
                        TaskSurfaceMorphTiming.RAIL_CORNER_RADIUS_DP +
                            (to.height / 2f - TaskSurfaceMorphTiming.RAIL_CORNER_RADIUS_DP) * value
                    } else {
                        from.height / 2f +
                            (TaskSurfaceMorphTiming.RAIL_CORNER_RADIUS_DP - from.height / 2f) * value
                    }
                }
                if (!morph.isCurrentGeneration(gen)) return@LaunchedEffect
                val fade = Animatable(1f)
                fade.animateTo(
                    targetValue = 0f,
                    animationSpec = tween(durationMillis = TaskSurfaceMorphTiming.GHOST_FADE_MS),
                ) {
                    if (morph.isCurrentGeneration(gen)) {
                        ghostAlpha = value
                    }
                }
                morph.completeGhost(System.currentTimeMillis(), generation = gen)
            } finally {
                // R2-动效：旧 generation 协程取消时不得清新动画的 ghost/hide（单实体）
                if (morph.isCurrentGeneration(gen)) {
                    ghostRect = null
                    ghostAlpha = 0f
                    hideCapsule = false
                    hideRail = false
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .onGloballyPositioned { hostCoordinates = it },
        ) {
            // 对话：始终组合一次（keep-alive）；可见时实测 rail 供 morph
            Box(
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .fillMaxHeight()
                    .width(geometry.conversationWidthDp.dp)
                    .alpha(
                        when {
                            hideRail && mode == TaskSurfaceMode.SPLIT -> 0f
                            else -> geometry.conversationAlpha
                        },
                    )
                    .onGloballyPositioned { coords ->
                        // APP_FOCUS 宽为 0 时勿冲掉上次 SPLIT 实测
                        if (geometry.conversationWidthDp < 1f || geometry.conversationAlpha <= 0f) {
                            return@onGloballyPositioned
                        }
                        morphRectFromChild(coords)?.let { measuredRail = it }
                    },
            ) {
                conversationContent()
            }

            if (geometry.showsDivider) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .offset(
                            x = (-geometry.workbenchWidthDp - TaskSurfaceStableLayout.DIVIDER_HIT_DP / 2f).dp,
                        )
                        .width(TaskSurfaceStableLayout.DIVIDER_HIT_DP.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f)),
                )
            }

            if (keepWorkbench) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .fillMaxHeight()
                        .width(geometry.workbenchWidthDp.dp)
                        .alpha(geometry.workbenchAlpha),
                ) {
                    WorkbenchSurface(
                        organizationId = organizationId,
                        spaceId = spaceId,
                        backHandlingEnabled = TaskSurfaceCoordinator.workbenchBackHandlingEnabled(
                            mode = mode,
                            workbenchOpen = workbenchOpen,
                        ),
                        initialOpenRequest = initialOpenRequest,
                        onInitialOpenRequestConsumed = onInitialOpenRequestConsumed,
                        onFocusChanged = onFocusChanged,
                        onDismiss = onDismissWorkbench,
                        onDelegateToAgent = onDelegateToAgent,
                        onResourceOpen = onResourceOpen,
                        onSendReference = onSendReference,
                        onRequestApp = onRequestApp,
                        conversationMessages = conversationMessages,
                        // ≥760 宿主：政策函数锁 EMBEDDED（非 MODAL）
                        presentation = TaskSurfaceCoordinator.sessionWorkbenchPresentation(
                            widthDp.toInt(),
                        ),
                        viewModel = workbenchViewModel,
                    )
                }
            }

            // ghost：单实体 overlay；hideCapsule 时真实胶囊 alpha=0，只见 ghost
            val g = ghostRect
            if (g != null && ghostAlpha > 0f) {
                val baseW = g.width.coerceAtLeast(1f)
                val baseH = g.height.coerceAtLeast(1f)
                Box(
                    modifier = Modifier
                        .graphicsLayer {
                            translationX = with(density) { g.left.dp.toPx() }
                            translationY = with(density) { g.top.dp.toPx() }
                            alpha = ghostAlpha
                        }
                        .size(width = baseW.dp, height = baseH.dp)
                        .background(
                            color = MaterialTheme.colorScheme.surface,
                            shape = RoundedCornerShape(ghostCorner.dp),
                        ),
                )
            }

            if (showCapsule) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .alpha(
                            if (hideCapsule && mode == TaskSurfaceMode.APP_FOCUS) 0f else 1f,
                        ),
                ) {
                    capsuleOverlay { capsuleCoords ->
                        morphRectFromChild(capsuleCoords)?.let { measuredCapsule = it }
                    }
                }
            }
        }
    }
}
