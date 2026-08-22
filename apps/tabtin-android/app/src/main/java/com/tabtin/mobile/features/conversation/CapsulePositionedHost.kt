package com.tabtin.mobile.features.conversation

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** 菜单选「语音」后先收菜单再进录音，与 iOS `menuVoiceHandoffDelayMs` 对齐。 */
internal const val CapsuleMenuVoiceHandoffDelayMs: Long = 180L

/**
 * 工作台面**同层**胶囊宿主：在父 Box 坐标系内按 placement 定位（空区不抢点击）。
 *
 * 须作为工作台内容的**同层后置 overlay** 挂载（宽屏 [TaskSurfaceHost] / 窄屏切屏后的
 * 内容 Box），不要用 Compose `Popup`——Modal / sheet 窗口层级会盖住 Popup。
 *
 * 长按出双列菜单；[onTextRequested] 展开迷你文字输入条。
 * [voiceControlSessionActive] 时锁定短按/拖拽/菜单（取消/发送改由 HUD 按钮）。
 * 短按经 [onTap] 展开对话（对话面本身不常驻胶囊，由宿主 `capsuleLayoutAllows` 控制）。
 *
 * 菜单是胶囊的**兄弟节点**（不进 `onSizeChanged`），避免右侧停靠时长按后
 * 盒子被菜单撑宽、胶囊被顶到左边。
 */
@Composable
internal fun CapsulePositionedHost(
    onTap: () -> Unit,
    onTextRequested: () -> Unit = {},
    onVoiceRequested: () -> Unit = {},
    onboardingReplySuggested: Boolean = false,
    onboardingSuppressed: Boolean = false,
    voiceControlSessionActive: Boolean = false,
    /** HITL 气泡是独立兄弟层；禁止并入 capsuleSize 的持久化测量。 */
    interactionBubble: (@Composable (
        side: CapsuleDockSide,
        aboveCapsule: Boolean,
    ) -> Unit)? = null,
    modifier: Modifier = Modifier,
    content: @Composable (side: CapsuleDockSide, onDockSide: (CapsuleDockSide) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val store = remember(context) { CapsulePlacementStore(context) }
    val onboardingStore = remember(context) { CapsuleOnboardingStore(context) }
    var placement by remember { mutableStateOf(store.load()) }
    var onboardingProgress by remember { mutableStateOf(onboardingStore.load()) }
    var onboardingPrompt by remember { mutableStateOf<CapsuleOnboardingAction?>(null) }
    var appearanceRecorded by remember { mutableStateOf(false) }
    var capsuleSize by remember { mutableStateOf(IntSize.Zero) }
    var interactionBubbleSize by remember { mutableStateOf(IntSize.Zero) }
    var menuSize by remember { mutableStateOf(IntSize.Zero) }
    var liveOrigin by remember { mutableStateOf<Offset?>(null) }
    var isDragging by remember { mutableStateOf(false) }
    var menuVisible by remember { mutableStateOf(false) }
    var menuHighlight by remember { mutableStateOf<CapsuleMenuSelection?>(null) }
    /** 长按抓起：菜单已开、手指未抬，视觉上「被拿起来」。 */
    var lifted by remember { mutableStateOf(false) }
    /** 菜单在宿主坐标系中的命中矩形（与胶囊同层）。 */
    var menuBoundsInHost by remember { mutableStateOf(Rect.Zero) }
    var voiceHandoffJob by remember { mutableStateOf<Job?>(null) }
    val tap by rememberUpdatedState(onTap)
    val textRequested by rememberUpdatedState(onTextRequested)
    val voiceRequested by rememberUpdatedState(onVoiceRequested)
    val voiceSession by rememberUpdatedState(voiceControlSessionActive)
    val reduceMotion = rememberReduceMotion()

    fun dismissOnboardingPrompt() {
        onboardingPrompt = null
    }

    fun markOnboardingLearned(action: CapsuleOnboardingAction) {
        onboardingProgress = onboardingProgress.markLearned(action)
        onboardingStore.save(onboardingProgress)
        dismissOnboardingPrompt()
    }

    LaunchedEffect(
        onboardingReplySuggested,
        onboardingSuppressed,
        voiceControlSessionActive,
    ) {
        if (!appearanceRecorded) {
            onboardingProgress = onboardingProgress.recordAppearance()
            onboardingStore.save(onboardingProgress)
            appearanceRecorded = true
        }
        if (onboardingSuppressed || voiceControlSessionActive) {
            dismissOnboardingPrompt()
            return@LaunchedEffect
        }
        delay(1_200)
        if (menuVisible || voiceControlSessionActive || onboardingSuppressed) return@LaunchedEffect
        val prompt = onboardingProgress.nextPrompt(onboardingReplySuggested) ?: return@LaunchedEffect
        onboardingProgress = onboardingProgress.markPromptShown()
        onboardingStore.save(onboardingProgress)
        onboardingPrompt = prompt
    }

    LaunchedEffect(onboardingPrompt) {
        if (onboardingPrompt == null) return@LaunchedEffect
        delay(4_500)
        dismissOnboardingPrompt()
    }

    /** 松手后的停靠动画：从实拖位置弹簧吸附到停靠位，避免瞬移。 */
    val dockAnimatable = remember { Animatable(Offset.Zero, Offset.VectorConverter) }
    var docking by remember { mutableStateOf(false) }
    var dockJob by remember { mutableStateOf<Job?>(null) }

    // 拖拽中的缩放/投影跟随 isDragging 弹性过渡，不再瞬时跳变。
    val dragScale by animateFloatAsState(
        targetValue = when {
            isDragging -> 1.05f
            lifted -> 1.06f
            else -> 1f
        },
        animationSpec = spring(stiffness = Spring.StiffnessHigh),
        label = "capsuleDragScale",
    )
    val dragShadow by animateDpAsState(
        targetValue = when {
            isDragging -> 12.dp
            lifted -> 14.dp
            else -> 6.dp
        },
        animationSpec = spring(stiffness = Spring.StiffnessHigh),
        label = "capsuleDragShadow",
    )

    fun commitDock(from: Offset, to: Offset) {
        // 停靠确认触觉；CONFIRM 需要 API 30，低版本退回 LONG_PRESS。
        val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.LONG_PRESS
        }
        view.performHapticFeedback(haptic)
        if (reduceMotion) return
        // UNDISPATCHED：同步先 snap 到实拖位置，避免下一帧闪跳回停靠位。
        dockJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            docking = true
            dockAnimatable.snapTo(from)
            try {
                dockAnimatable.animateTo(to, spring(dampingRatio = 0.8f))
            } finally {
                docking = false
            }
        }
    }

    fun dismissMenu() {
        menuVisible = false
        menuHighlight = null
        menuBoundsInHost = Rect.Zero
        lifted = false
    }

    fun scheduleVoiceHandoff() {
        voiceHandoffJob?.cancel()
        val delayMs = if (reduceMotion) 0L else CapsuleMenuVoiceHandoffDelayMs
        voiceHandoffJob = scope.launch {
            if (delayMs > 0L) delay(delayMs)
            voiceRequested()
        }
    }

    fun applySelection(selection: CapsuleMenuSelection) {
        dismissMenu()
        when (selection) {
            CapsuleMenuSelection.TEXT -> {
                voiceHandoffJob?.cancel()
                textRequested()
            }
            CapsuleMenuSelection.VOICE -> scheduleVoiceHandoff()
        }
    }

    // zIndex：与 TASK_PANE / 对话同层时压在内容之上；空区无 pointerInput，不抢点击。
    BoxWithConstraints(modifier = modifier.fillMaxSize().zIndex(1f)) {
        val viewportW = constraints.maxWidth.toFloat()
        val viewportH = constraints.maxHeight.toFloat()
        val capsuleW = capsuleSize.width.toFloat().coerceAtLeast(1f)
        val capsuleH = capsuleSize.height.toFloat().coerceAtLeast(1f)
        val (baseX, baseY) = CapsulePlacementGeometry.position(
            placement = placement,
            viewportWidth = viewportW,
            viewportHeight = viewportH,
            capsuleWidth = capsuleW,
            capsuleHeight = capsuleH,
        )
        val originX = if (docking) dockAnimatable.value.x else (liveOrigin?.x ?: baseX)
        val originY = if (docking) dockAnimatable.value.y else (liveOrigin?.y ?: baseY)
        val capsuleOrigin = Offset(originX, originY)

        if (onboardingPrompt == CapsuleOnboardingAction.TAP &&
            !menuVisible &&
            !voiceControlSessionActive &&
            !onboardingSuppressed
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.10f))
                    .zIndex(0.5f),
            )
        }

        if (menuVisible) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            dismissMenu()
                        }
                    },
            )
        }

        interactionBubble
            ?.takeUnless { menuVisible || voiceControlSessionActive }
            ?.let { bubble ->
            val safeMarginPx = with(density) { 12.dp.toPx() }
            val bubbleGapPx = with(density) { 8.dp.toPx() }
            val maxBubbleWidthPx = (viewportW - safeMarginPx * 2f).coerceAtLeast(1f)
            val aboveAvailablePx = (originY - bubbleGapPx - safeMarginPx).coerceAtLeast(0f)
            val belowAvailablePx = (
                viewportH - safeMarginPx - originY - capsuleH - bubbleGapPx
            ).coerceAtLeast(0f)
            val maxBubbleHeightPx = maxOf(aboveAvailablePx, belowAvailablePx).coerceAtLeast(1f)
            val measured = interactionBubbleSize != IntSize.Zero
            val position = CapsuleInteractionBubbleGeometry.place(
                side = placement.side,
                capsuleX = originX,
                capsuleY = originY,
                capsuleWidth = capsuleW,
                capsuleHeight = capsuleH,
                bubbleWidth = interactionBubbleSize.width.toFloat().coerceAtLeast(1f),
                bubbleHeight = interactionBubbleSize.height.toFloat().coerceAtLeast(1f),
                viewportWidth = viewportW,
                viewportHeight = viewportH,
                safeMargin = safeMarginPx,
                gap = bubbleGapPx,
            )
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(position.x.roundToInt(), position.y.roundToInt())
                    }
                    .widthIn(max = with(density) { maxBubbleWidthPx.toDp() })
                    .heightIn(max = with(density) { maxBubbleHeightPx.toDp() })
                    .onSizeChanged { interactionBubbleSize = it }
                    .graphicsLayer { alpha = if (measured) 1f else 0f }
                    .zIndex(3f),
            ) {
                bubble(placement.side, position.aboveCapsule)
            }
        }

        // 仅测量胶囊本体，菜单不进此盒——否则 RIGHT 停靠时长按会被撑宽后顶到左边。
        Box(
            modifier = Modifier
                .offset { IntOffset(originX.roundToInt(), originY.roundToInt()) }
                .onSizeChanged { capsuleSize = it }
                .graphicsLayer {
                    scaleX = dragScale
                    scaleY = dragScale
                    shadowElevation = dragShadow.toPx()
                    shape = RoundedCornerShape(24.dp)
                    clip = false
                }
                .capsulePointerPlacement(
                    density = density,
                    viewportW = viewportW,
                    viewportH = viewportH,
                    capsuleW = capsuleW,
                    capsuleH = capsuleH,
                    placement = placement,
                    menuVisible = { menuVisible },
                    voiceControlSessionActive = voiceSession,
                    capsuleOriginInHost = { capsuleOrigin },
                    menuBoundsInHost = { menuBoundsInHost },
                    onPlacementChange = { next ->
                        placement = next
                        store.save(next)
                    },
                    onLiveOrigin = { next ->
                        // 新手势接管位置：取消进行中的停靠动画。
                        if (next != null) {
                            dockJob?.cancel()
                            docking = false
                        }
                        liveOrigin = next
                    },
                    onDragging = { isDragging = it },
                    onPointerStarted = ::dismissOnboardingPrompt,
                    onMenuOpened = {
                        markOnboardingLearned(CapsuleOnboardingAction.HOLD)
                        menuVisible = true
                        menuHighlight = null
                        lifted = true
                        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    },
                    onMenuHighlight = { menuHighlight = it },
                    onLifted = { lifted = it },
                    onMenuSelect = { applySelection(it) },
                    onDock = { from, to ->
                        markOnboardingLearned(CapsuleOnboardingAction.DRAG)
                        commitDock(from, to)
                    },
                    onTap = {
                        markOnboardingLearned(CapsuleOnboardingAction.TAP)
                        tap()
                    },
                ),
        ) {
            content(placement.side) { side ->
                val next = placement.copy(side = side)
                placement = next
                store.save(next)
            }
        }

        onboardingPrompt
            ?.takeUnless { menuVisible || voiceControlSessionActive || onboardingSuppressed }
            ?.let { prompt ->
                val fallbackHintW = with(density) { 216.dp.toPx() }
                val fallbackHintH = with(density) { 72.dp.toPx() }
                val hintPosition = CapsuleInteractionBubbleGeometry.place(
                    side = placement.side,
                    capsuleX = originX,
                    capsuleY = originY,
                    capsuleWidth = capsuleW,
                    capsuleHeight = capsuleH,
                    bubbleWidth = fallbackHintW,
                    bubbleHeight = fallbackHintH,
                    viewportWidth = viewportW,
                    viewportHeight = viewportH,
                    safeMargin = with(density) { 12.dp.toPx() },
                    gap = with(density) { 8.dp.toPx() },
                )
                CapsuleOnboardingHint(
                    action = prompt,
                    reduceMotion = reduceMotion,
                    onSkip = {
                        onboardingProgress = onboardingProgress.skipAll()
                        onboardingStore.save(onboardingProgress)
                        dismissOnboardingPrompt()
                    },
                    modifier = Modifier
                        .offset {
                            IntOffset(
                                hintPosition.x.roundToInt(),
                                hintPosition.y.roundToInt(),
                            )
                        }
                        .zIndex(2f),
                )
            }

        if (menuVisible) {
            val menuGapPx = with(density) { 12.dp.toPx() }
            val fallbackMenuW = with(density) { 196.dp.toPx() }
            val fallbackMenuH = with(density) { 56.dp.toPx() }
            val menuW = menuSize.width.toFloat().takeIf { it > 0f } ?: fallbackMenuW
            val menuH = menuSize.height.toFloat().takeIf { it > 0f } ?: fallbackMenuH
            val capsuleCenterX = originX + capsuleW / 2f
            val rawMenuX = capsuleCenterX - menuW / 2f
            val menuX = rawMenuX.coerceIn(0f, (viewportW - menuW).coerceAtLeast(0f))
            val menuY = (originY - menuH - menuGapPx).coerceAtLeast(0f)
            val computedMenuBounds = Rect(menuX, menuY, menuX + menuW, menuY + menuH)
            SideEffect {
                if (menuBoundsInHost != computedMenuBounds) {
                    menuBoundsInHost = computedMenuBounds
                }
            }

            CapsuleActionMenu(
                highlighted = menuHighlight,
                onSelect = { applySelection(it) },
                modifier = Modifier
                    .offset { IntOffset(menuX.roundToInt(), menuY.roundToInt()) }
                    .onSizeChanged { menuSize = it }
                    .zIndex(2f),
            )
        }
    }
}

private fun Modifier.capsulePointerPlacement(
    density: androidx.compose.ui.unit.Density,
    viewportW: Float,
    viewportH: Float,
    capsuleW: Float,
    capsuleH: Float,
    placement: CapsulePlacement,
    menuVisible: () -> Boolean,
    voiceControlSessionActive: Boolean,
    capsuleOriginInHost: () -> Offset,
    menuBoundsInHost: () -> Rect,
    onPlacementChange: (CapsulePlacement) -> Unit,
    onLiveOrigin: (Offset?) -> Unit,
    onDragging: (Boolean) -> Unit,
    onPointerStarted: () -> Unit,
    onMenuOpened: () -> Unit,
    onMenuHighlight: (CapsuleMenuSelection?) -> Unit,
    onLifted: (Boolean) -> Unit,
    onMenuSelect: (CapsuleMenuSelection) -> Unit,
    onDock: (from: Offset, to: Offset) -> Unit,
    onTap: () -> Unit,
): Modifier = pointerInput(
    viewportW,
    viewportH,
    capsuleW,
    capsuleH,
    placement,
    voiceControlSessionActive,
) {
    coroutineScope {
        awaitEachGesture {
            if (voiceControlSessionActive) {
                // 录音中锁定 chrome：吞掉指针，不上滑取消、松手也不提交。
                val down = awaitFirstDown(requireUnconsumed = false)
                down.consume()
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Main)
                    val change = event.changes.firstOrNull() ?: break
                    change.consume()
                    if (!change.pressed) break
                }
                return@awaitEachGesture
            }

            if (menuVisible()) {
                // 菜单已开且不是同一次手势：点胶囊不重启手势；外侧 dismiss / 列点选另接。
                awaitFirstDown(requireUnconsumed = false).consume()
                return@awaitEachGesture
            }

            val reducer = CapsulePointerReducer()
            val down = awaitFirstDown(requireUnconsumed = false)
            down.consume()
            onPointerStarted()
            reducer.handle(CapsulePointerEvent.TouchBegan)
            val (freshX, freshY) = CapsulePlacementGeometry.position(
                placement = placement,
                viewportWidth = viewportW,
                viewportHeight = viewportH,
                capsuleWidth = capsuleW,
                capsuleHeight = capsuleH,
            )
            val dragOrigin = Offset(freshX, freshY)
            onLiveOrigin(dragOrigin)
            var totalDx = 0f
            var totalDy = 0f
            var lastHighlight: CapsuleMenuSelection? = null
            // AwaitPointerEventScope 不是 CoroutineScope；用 PointerInputScope.launch。
            val holdJob = launch {
                var elapsed = 0
                while (isActive) {
                    delay(40)
                    elapsed += 40
                    if (reducer.phase != CapsulePointerPhase.PRESSING) return@launch
                    reducer.handle(CapsulePointerEvent.HoldElapsed(elapsed))
                    if (reducer.pendingOutcome == CapsulePointerOutcome.MenuOpened) {
                        onMenuOpened()
                        return@launch
                    }
                }
            }

            fun commitPlacement() {
                val raw = Offset(dragOrigin.x + totalDx, dragOrigin.y + totalDy)
                val (dockedX, dockedY) = CapsulePlacementGeometry.dockedPosition(
                    x = raw.x,
                    y = raw.y,
                    viewportWidth = viewportW,
                    viewportHeight = viewportH,
                    capsuleWidth = capsuleW,
                    capsuleHeight = capsuleH,
                )
                val snapped = CapsulePlacementGeometry.placement(
                    x = dockedX,
                    y = dockedY,
                    viewportWidth = viewportW,
                    viewportHeight = viewportH,
                    capsuleWidth = capsuleW,
                    capsuleHeight = capsuleH,
                )
                onPlacementChange(snapped)
                onLiveOrigin(null)
                onDragging(false)
                // 停靠动画从实拖位置起手，1:1 拖拽段保持原样不动。
                onDock(raw, Offset(dockedX, dockedY))
            }

            try {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Main)
                    val change = event.changes.firstOrNull() ?: break
                    if (!change.pressed) {
                        holdJob.cancel()
                        when (reducer.phase) {
                            CapsulePointerPhase.MENU_OPEN -> {
                                val hostPos = fingerInHost(
                                    localPos = change.position,
                                    capsuleOrigin = capsuleOriginInHost(),
                                )
                                val selection = highlightInHost(hostPos, menuBoundsInHost())
                                    ?: lastHighlight
                                if (selection != null) {
                                    reducer.handle(CapsulePointerEvent.SelectMenu(selection))
                                    onMenuSelect(selection)
                                } else {
                                    onMenuHighlight(null)
                                }
                                onLiveOrigin(null)
                                onDragging(false)
                                onLifted(false)
                            }
                            else -> {
                                reducer.handle(CapsulePointerEvent.TouchEnded)
                                when (reducer.pendingOutcome) {
                                    CapsulePointerOutcome.Tap -> {
                                        onLiveOrigin(null)
                                        onDragging(false)
                                        onTap()
                                    }
                                    CapsulePointerOutcome.DragEnd -> {
                                        commitPlacement()
                                    }
                                    else -> {
                                        onLiveOrigin(null)
                                        onDragging(false)
                                    }
                                }
                            }
                        }
                        change.consume()
                        break
                    }

                    val dx = change.positionChange().x
                    val dy = change.positionChange().y
                    val dxDp = with(density) { dx.toDp().value }
                    val dyDp = with(density) { dy.toDp().value }

                    if (reducer.phase == CapsulePointerPhase.MENU_OPEN) {
                        reducer.handle(CapsulePointerEvent.TouchMoved(dxDp, dyDp))
                        val hostPos = fingerInHost(
                            localPos = change.position,
                            capsuleOrigin = capsuleOriginInHost(),
                        )
                        lastHighlight = highlightInHost(hostPos, menuBoundsInHost())
                        onMenuHighlight(lastHighlight)
                        change.consume()
                        continue
                    }

                    totalDx += dx
                    totalDy += dy
                    reducer.handle(CapsulePointerEvent.TouchMoved(dxDp, dyDp))
                    when (reducer.phase) {
                        CapsulePointerPhase.DRAGGING -> {
                            holdJob.cancel()
                            onDragging(true)
                            onLiveOrigin(Offset(dragOrigin.x + totalDx, dragOrigin.y + totalDy))
                        }
                        else -> Unit
                    }
                    change.consume()
                }
            } catch (cancellation: CancellationException) {
                // 手势被取消（组合退出 / pointerInput 重启）时先把视觉状态收干净，
                // 但异常必须继续往上抛：吞掉会让结构化取消失效，awaitEachGesture
                // 会再转一圈，父协程也判断不出自己已经死了。
                holdJob.cancel()
                reducer.handle(CapsulePointerEvent.TouchCancelled)
                onLiveOrigin(null)
                onDragging(false)
                onLifted(false)
                throw cancellation
            } catch (_: Exception) {
                holdJob.cancel()
                reducer.handle(CapsulePointerEvent.TouchCancelled)
                onLiveOrigin(null)
                onDragging(false)
                onLifted(false)
            }
        }
    }
}

@Composable
private fun CapsuleOnboardingHint(
    action: CapsuleOnboardingAction,
    reduceMotion: Boolean,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var demonstratesGesture by remember(action) { mutableStateOf(false) }
    LaunchedEffect(action, reduceMotion) {
        if (reduceMotion) return@LaunchedEffect
        repeat(2) {
            demonstratesGesture = true
            delay(420)
            demonstratesGesture = false
            delay(120)
        }
    }
    val gestureOffset by animateDpAsState(
        targetValue = if (demonstratesGesture && action == CapsuleOnboardingAction.DRAG) 10.dp else 0.dp,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "capsuleOnboardingGestureOffset",
    )
    val gestureScale by animateFloatAsState(
        targetValue = if (demonstratesGesture && action != CapsuleOnboardingAction.DRAG) 0.86f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "capsuleOnboardingGestureScale",
    )

    Surface(
        modifier = modifier
            .width(216.dp)
            .semantics(mergeDescendants = true) {},
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
        tonalElevation = 2.dp,
        shadowElevation = 8.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = when (action) {
                    CapsuleOnboardingAction.TAP -> "●"
                    CapsuleOnboardingAction.DRAG -> "↔"
                    CapsuleOnboardingAction.HOLD -> "◎"
                },
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier
                    .offset(x = gestureOffset)
                    .graphicsLayer {
                        scaleX = gestureScale
                        scaleY = gestureScale
                    },
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 10.dp),
            ) {
                Text(
                    text = stringResource(action.titleRes),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(action.detailRes),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
            }
            TextButton(onClick = onSkip) {
                Text(stringResource(com.tabtin.mobile.R.string.agent_capsule_onboarding_skip))
            }
        }
    }
}

private val CapsuleOnboardingAction.titleRes: Int
    get() = when (this) {
        CapsuleOnboardingAction.TAP -> com.tabtin.mobile.R.string.agent_capsule_onboarding_tap_title
        CapsuleOnboardingAction.DRAG -> com.tabtin.mobile.R.string.agent_capsule_onboarding_drag_title
        CapsuleOnboardingAction.HOLD -> com.tabtin.mobile.R.string.agent_capsule_onboarding_hold_title
    }

private val CapsuleOnboardingAction.detailRes: Int
    get() = when (this) {
        CapsuleOnboardingAction.TAP -> com.tabtin.mobile.R.string.agent_capsule_onboarding_tap_detail
        CapsuleOnboardingAction.DRAG -> com.tabtin.mobile.R.string.agent_capsule_onboarding_drag_detail
        CapsuleOnboardingAction.HOLD -> com.tabtin.mobile.R.string.agent_capsule_onboarding_hold_detail
    }

private fun fingerInHost(localPos: Offset, capsuleOrigin: Offset): Offset =
    Offset(capsuleOrigin.x + localPos.x, capsuleOrigin.y + localPos.y)

private fun highlightInHost(hostPos: Offset, menuBounds: Rect): CapsuleMenuSelection? {
    if (menuBounds == Rect.Zero || !menuBounds.contains(hostPos)) return null
    return if (hostPos.x < menuBounds.center.x) {
        CapsuleMenuSelection.TEXT
    } else {
        CapsuleMenuSelection.VOICE
    }
}
