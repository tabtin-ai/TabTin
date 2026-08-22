package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope

/**
 * 对话层的连续位置。拖拽中用 [dragByPx] 跟手（无动画），松手用 [settle] 按速度吸档。
 * [topRatio] 是层顶在视口中的比例，越小越展开，语义见 [ConversationLayerGeometry]。
 */
internal class ConversationLayerState(initial: ConversationLayerDetent) {
    /**
     * 位置存 snapshot state 而不是 `Animatable`：跟手拖拽要与手指同帧落位，
     * 而 `Animatable.snapTo` 是挂起函数，调用方只能每个拖拽事件起一个协程——
     * 除了每帧分配，同优先级的 `MutatorMutex` 还会让后一次抢占前一次，
     * 前一次尚未写入的位移就丢了。这里改成同步写，动画独占 [animationJob]，
     * 由 [dragByPx] 掐断，保留「拖拽随时打断吸附动画」的原语义。
     */
    private var positionRatio by mutableFloatStateOf(ConversationLayerGeometry.topRatio(initial))
    private var animationJob: Job? = null

    var detent: ConversationLayerDetent by mutableStateOf(initial)
        private set

    /** 视口高度（px），由 [ConversationLayerHost] 布局时写入。两个拖拽源共用同一分母。 */
    var viewportHeightPx: Int by mutableIntStateOf(0)

    val topRatio: Float get() = positionRatio

    /** 按像素拖拽。抓手与胶囊都走这条，避免各自换算导致增益不一致。 */
    fun dragByPx(deltaPx: Float) {
        val height = viewportHeightPx
        if (height <= 0) return
        animationJob?.cancel()
        animationJob = null
        positionRatio = ConversationLayerGeometry.clampTopRatio(positionRatio + deltaPx / height)
    }

    suspend fun settle(velocityDpPerMs: Float) {
        val proposed = ConversationLayerGeometry.settle(positionRatio, velocityDpPerMs)
        val gestureTarget = when (detent) {
            // 胶囊从收起态只负责拉出卡片；进入半屏后，抓手可以继续拉到扩展卡片。
            ConversationLayerDetent.COLLAPSED -> if (
                proposed == ConversationLayerDetent.EXPANDED
            ) {
                ConversationLayerDetent.SHEET
            } else {
                proposed
            }

            ConversationLayerDetent.SHEET -> proposed

            // 从扩展卡片下拖只退一档，不能越过半屏直接收起。
            ConversationLayerDetent.EXPANDED -> if (
                proposed == ConversationLayerDetent.COLLAPSED
            ) {
                ConversationLayerDetent.SHEET
            } else {
                proposed
            }
        }
        animateTo(gestureTarget)
    }

    /**
     * 先落 [detent] 再跑动画：胶囊与层顶抓手的交棒要在动画一开始就发生，
     * 否则两个把手会在动画期间并存。
     */
    suspend fun animateTo(target: ConversationLayerDetent) {
        detent = target
        coroutineScope {
            val job = coroutineContext[Job]
            animationJob?.takeIf { it !== job }?.cancel()
            animationJob = job
            try {
                animate(
                    initialValue = positionRatio,
                    targetValue = ConversationLayerGeometry.topRatio(target),
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioNoBouncy,
                        stiffness = Spring.StiffnessMediumLow,
                    ),
                ) { value, _ -> positionRatio = value }
            } finally {
                if (animationJob === job) animationJob = null
            }
        }
    }

    /** 系统返回键：扩展卡片先退半屏，半屏再收起；已收起则交还给导航层。 */
    fun collapseTargetOnBack(): ConversationLayerDetent? = when (detent) {
        ConversationLayerDetent.EXPANDED -> ConversationLayerDetent.SHEET
        ConversationLayerDetent.SHEET -> ConversationLayerDetent.COLLAPSED
        ConversationLayerDetent.COLLAPSED -> null
    }
}

@Composable
internal fun rememberConversationLayerState(
    initial: ConversationLayerDetent = ConversationLayerDetent.COLLAPSED,
): ConversationLayerState = remember { ConversationLayerState(initial) }
