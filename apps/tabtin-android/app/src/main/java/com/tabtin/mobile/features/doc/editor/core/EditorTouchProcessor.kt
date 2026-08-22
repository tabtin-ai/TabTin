package com.tabtin.mobile.features.doc.editor.core

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Layout
import android.text.style.ClickableSpan
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs

/**
 * Derived from anytype-kotlin core-ui EditorTouchProcessor.
 * Handles touch gestures: tap, long-press, drag-and-drop, and ClickableSpan detection.
 */
public class EditorTouchProcessor(
    private val touchSlop: Int,
    public val fallback: (event: MotionEvent?) -> Boolean,
    public var onLongClick: () -> Unit = {},
    public var onDragAndDropTrigger: (event: MotionEvent?) -> Unit = {}
) {

    private var moveFirstY: Float = 0f
    private var moveLastY: Float = 0f
    private var moveCount: Int = 0
    private val actionHandler = Handler(Looper.getMainLooper())
    private var actionUpStartInMillis: Long = 0
    private var lastEvent: MotionEvent? = null
    private var isDragging: Boolean = false
    private var dragTriggered: Boolean = false

    private val dragAndDropTimeoutRunnable = Runnable {
        val delta = if (moveCount > 1) abs(moveLastY - moveFirstY) else 0f
        if (!isDragging && delta <= touchSlop) {
            dragTriggered = true
            onDragAndDropTrigger(lastEvent)
        } else if (isDragging) {
            dragTriggered = true
            onDragAndDropTrigger(lastEvent)
        }
        moveCount = 0
    }

    public fun process(v: View, event: MotionEvent?): Boolean {
        event ?: return fallback(null)
        lastEvent?.recycle()
        lastEvent = MotionEvent.obtain(event)

        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                actionUpStartInMillis = SystemClock.elapsedRealtime()
                isDragging = false
                dragTriggered = false
                moveCount = 0
                actionHandler.postDelayed(dragAndDropTimeoutRunnable, DND_TIMEOUT)
            }

            MotionEvent.ACTION_MOVE -> {
                val y = event.getY(0)
                if (moveCount == 0) moveFirstY = y
                moveLastY = y
                moveCount++
                if (moveCount > 1) {
                    val delta = abs(moveLastY - moveFirstY)
                    if (delta > touchSlop) isDragging = true
                }
            }

            MotionEvent.ACTION_CANCEL -> {
                if (!isDragging && event.elapsed() > DND_TIMEOUT) {
                    v.emulateHapticFeedback()
                }
                actionHandler.removeCallbacksAndMessages(null)
                moveCount = 0
                lastEvent?.recycle()
                lastEvent = null
            }

            MotionEvent.ACTION_UP -> {
                actionHandler.removeCallbacksAndMessages(null)
                moveCount = 0

                if (v is DocTextInputWidget) {
                    val x = (event.x - v.totalPaddingLeft + v.scrollX).toInt()
                    val y = (event.y - v.totalPaddingTop + v.scrollY).toInt()
                    val layout: Layout = v.layout ?: return fallback(event)
                    val line = layout.getLineForVertical(y)
                    if (x <= layout.getLineMax(line)) {
                        val offset = layout.getOffsetForHorizontal(line, x.toFloat())
                        val link = v.editableText.getSpans(offset, offset, ClickableSpan::class.java)
                        if (link.isNotEmpty()) {
                            v.clearFocus()
                            link[0].onClick(v)
                            return true
                        }
                    }
                }

                return when {
                    !isDragging && !dragTriggered && actionUpStartInMillis.untilNow() >= LONG_PRESS_TIMEOUT -> {
                        onLongClick()
                        v.performLongClickWithHaptic()
                        true
                    }
                    else -> fallback(event)
                }
            }
        }
        return fallback(event)
    }

    public companion object {
        private const val TAG = "EditorTouchProcessor"
        public val LONG_PRESS_TIMEOUT: Long = android.view.ViewConfiguration.getLongPressTimeout().toLong()
        public val DND_TIMEOUT: Long = 2 * LONG_PRESS_TIMEOUT
    }
}

private fun View.emulateHapticFeedback() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && this !is DocTextInputWidget) {
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }
}

private fun View.performLongClickWithHaptic() {
    if (this !is DocTextInputWidget && !performLongClick()) {
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }
}

private fun Long.untilNow() = SystemClock.elapsedRealtime() - this
private fun MotionEvent.elapsed() = eventTime - downTime
