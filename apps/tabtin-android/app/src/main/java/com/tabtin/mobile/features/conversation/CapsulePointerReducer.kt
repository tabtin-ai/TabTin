package com.tabtin.mobile.features.conversation

import kotlin.math.hypot

internal object CapsulePointerMetrics {
    const val DRAG_THRESHOLD: Float = 12f
    const val MENU_HOLD_MS: Int = 420
}

internal enum class CapsulePointerPhase {
    IDLE,
    PRESSING,
    DRAGGING,
    MENU_OPEN,
}

internal enum class CapsuleMenuSelection {
    TEXT,
    VOICE,
}

internal sealed class CapsulePointerEvent {
    data object TouchBegan : CapsulePointerEvent()
    data class TouchMoved(val dx: Float, val dy: Float) : CapsulePointerEvent()
    data object TouchEnded : CapsulePointerEvent()
    data object TouchCancelled : CapsulePointerEvent()
    data class HoldElapsed(val ms: Int) : CapsulePointerEvent()
    data class SelectMenu(val selection: CapsuleMenuSelection) : CapsulePointerEvent()
    data object DismissMenu : CapsulePointerEvent()
}

internal sealed class CapsulePointerOutcome {
    data object Tap : CapsulePointerOutcome()
    data object DragEnd : CapsulePointerOutcome()
    data object MenuOpened : CapsulePointerOutcome()
    data class MenuSelection(val selection: CapsuleMenuSelection) : CapsulePointerOutcome()
    data object MenuDismissed : CapsulePointerOutcome()
}

/**
 * 工作台胶囊指针语义：短按展开对话、超阈值直接拖拽胶囊、静止长按出输入菜单；
 * 三路互斥，长按打开菜单后不再切换成迁位手势。
 * 与 iOS `CapsulePointerReducer` 同阈值、同相位转移。
 */
internal class CapsulePointerReducer {
    var phase: CapsulePointerPhase = CapsulePointerPhase.IDLE
        private set
    var pendingOutcome: CapsulePointerOutcome? = null
        private set

    private var accumulatedDx: Float = 0f
    private var accumulatedDy: Float = 0f

    fun handle(event: CapsulePointerEvent) {
        pendingOutcome = null

        when (event) {
            CapsulePointerEvent.TouchBegan -> {
                if (phase != CapsulePointerPhase.IDLE) return
                phase = CapsulePointerPhase.PRESSING
                accumulatedDx = 0f
                accumulatedDy = 0f
            }

            is CapsulePointerEvent.TouchMoved -> {
                when (phase) {
                    CapsulePointerPhase.PRESSING -> {
                        accumulatedDx += event.dx
                        accumulatedDy += event.dy
                        if (dragDistance > CapsulePointerMetrics.DRAG_THRESHOLD) {
                            phase = CapsulePointerPhase.DRAGGING
                        }
                    }
                    CapsulePointerPhase.DRAGGING -> {
                        accumulatedDx += event.dx
                        accumulatedDy += event.dy
                    }
                    CapsulePointerPhase.MENU_OPEN -> Unit
                    CapsulePointerPhase.IDLE -> Unit
                }
            }

            is CapsulePointerEvent.HoldElapsed -> {
                if (phase != CapsulePointerPhase.PRESSING ||
                    event.ms < CapsulePointerMetrics.MENU_HOLD_MS
                ) {
                    return
                }
                phase = CapsulePointerPhase.MENU_OPEN
                pendingOutcome = CapsulePointerOutcome.MenuOpened
            }

            CapsulePointerEvent.TouchEnded -> {
                when (phase) {
                    CapsulePointerPhase.PRESSING -> {
                        phase = CapsulePointerPhase.IDLE
                        pendingOutcome = CapsulePointerOutcome.Tap
                    }
                    CapsulePointerPhase.DRAGGING -> {
                        phase = CapsulePointerPhase.IDLE
                        pendingOutcome = CapsulePointerOutcome.DragEnd
                    }
                    CapsulePointerPhase.IDLE,
                    CapsulePointerPhase.MENU_OPEN,
                    -> Unit
                }
            }

            CapsulePointerEvent.TouchCancelled -> {
                phase = CapsulePointerPhase.IDLE
                accumulatedDx = 0f
                accumulatedDy = 0f
            }

            is CapsulePointerEvent.SelectMenu -> {
                if (phase != CapsulePointerPhase.MENU_OPEN) return
                phase = CapsulePointerPhase.IDLE
                pendingOutcome = CapsulePointerOutcome.MenuSelection(event.selection)
            }

            CapsulePointerEvent.DismissMenu -> {
                if (phase != CapsulePointerPhase.MENU_OPEN) return
                phase = CapsulePointerPhase.IDLE
                pendingOutcome = CapsulePointerOutcome.MenuDismissed
            }
        }
    }

    private val dragDistance: Float
        get() = hypot(accumulatedDx.toDouble(), accumulatedDy.toDouble()).toFloat()
}
