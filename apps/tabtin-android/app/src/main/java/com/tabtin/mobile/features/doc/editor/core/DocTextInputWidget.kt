package com.tabtin.mobile.features.doc.editor.core

import android.R.id.copy
import android.R.id.paste
import android.content.Context
import android.os.Build
import android.graphics.Canvas
import android.os.Parcelable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.util.Linkify
import android.util.AttributeSet
import android.view.DragEvent
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.util.Log
import androidx.appcompat.widget.AppCompatEditText
import androidx.core.graphics.withTranslation
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.editor.core.highlight.HighlightAttributeReader
import com.tabtin.mobile.features.doc.editor.core.highlight.HighlightDrawer

/**
 * Derived from anytype-kotlin core-ui TextInputWidget.
 * Core text editing widget with:
 * - Read/Edit mode switching
 * - Pausable TextWatchers (prevents feedback loops)
 * - Selection change callbacks
 * - Clipboard interception
 * - Touch processor for tap/long-press/drag-and-drop
 * - Highlight drawing (code blocks, background colors)
 *
 * Removed: MentionTextWatcher (to be added in P4 if needed).
 */
public class DocTextInputWidget : AppCompatEditText {

    public constructor(context: Context) : super(context)

    public constructor(context: Context, attrs: AttributeSet) : super(context, attrs) {
        setup()
        setupHighlightHelpers(context, attrs)
        setOnLongClickListener { view -> view != null && !view.hasFocus() }
        context.obtainStyledAttributes(attrs, R.styleable.DocTextInputWidget).apply {
            ignoreDragAndDrop = getBoolean(R.styleable.DocTextInputWidget_docIgnoreDragAndDrop, false)
            pasteAsPlainTextOnly = getBoolean(R.styleable.DocTextInputWidget_docOnlyPasteAsPlainText, false)
            recycle()
        }
    }

    public constructor(context: Context, attrs: AttributeSet, defStyle: Int) : super(context, attrs, defStyle) {
        setup()
        setupHighlightHelpers(context, attrs)
        setOnLongClickListener { view -> view != null && !view.hasFocus() }
        context.obtainStyledAttributes(attrs, R.styleable.DocTextInputWidget).apply {
            ignoreDragAndDrop = getBoolean(R.styleable.DocTextInputWidget_docIgnoreDragAndDrop, false)
            recycle()
        }
    }

    private var ignoreDragAndDrop = false
    private var pasteAsPlainTextOnly = false
    private var inReadMode = false

    public val editorTouchProcessor: EditorTouchProcessor by lazy {
        EditorTouchProcessor(
            touchSlop = ViewConfiguration.get(context).scaledTouchSlop,
            fallback = { e -> super.onTouchEvent(e) }
        )
    }

    private val watchers: MutableList<TextInputTextWatcher> = mutableListOf()

    private var highlightDrawer: HighlightDrawer? = null

    public var selectionWatcher: ((IntRange) -> Unit)? = null
    public var clipboardInterceptor: ClipboardInterceptor? = null
    public var backButtonWatcher: (() -> Boolean)? = null
    public var onBackspaceAtStart: (() -> Unit)? = null

    private var isSelectionWatcherBlocked = false
    private var inputAction: InputAction = DEFAULT_INPUT_ACTION

    public fun setInputAction(action: InputAction) {
        if (inputAction != action) {
            inputAction = action
        }
    }

    private fun setup() {
        enableEditMode()
    }

    public fun enableEditMode() {
        setRawInputType(
            InputType.TYPE_CLASS_TEXT
                    or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                    or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        )
        imeOptions = inputAction.toIMECode()
        setTextIsSelectable(true)
        inReadMode = false
        isCursorVisible = hasFocus()
    }

    public fun enableReadMode() {
        pauseTextWatchers {
            inReadMode = true
            setHorizontallyScrolling(false)
            setTextIsSelectable(false)
            isCursorVisible = false
        }
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        return DocInputConnection(base, true)
    }

    private inner class DocInputConnection(
        target: InputConnection,
        mutable: Boolean
    ) : InputConnectionWrapper(target, mutable) {

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            if (beforeLength > 0 && afterLength == 0
                && selectionStart == 0 && selectionEnd == 0
            ) {
                onBackspaceAtStart?.let { handler ->
                    post { handler() }
                    return true
                }
            }
            return super.deleteSurroundingText(beforeLength, afterLength)
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode == KeyEvent.KEYCODE_DEL
                && event.action == KeyEvent.ACTION_DOWN
                && selectionStart == 0 && selectionEnd == 0
            ) {
                onBackspaceAtStart?.let { handler ->
                    post { handler() }
                    return true
                }
            }
            return super.sendKeyEvent(event)
        }
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent?): Boolean {
        return if (event != null
            && event.keyCode == KeyEvent.KEYCODE_BACK
            && event.action == KeyEvent.ACTION_UP
            && backButtonWatcher?.invoke() == true
        ) {
            true
        } else {
            super.onKeyPreIme(keyCode, event)
        }
    }

    private fun setupHighlightHelpers(context: Context, attrs: AttributeSet) {
        try {
            HighlightAttributeReader(context, attrs).let { reader ->
                highlightDrawer = HighlightDrawer(
                    horizontalPadding = reader.horizontalPadding,
                    verticalPadding = reader.verticalPadding,
                    drawable = reader.drawable,
                    drawableLeft = reader.drawableLeft,
                    drawableMid = reader.drawableMid,
                    drawableRight = reader.drawableRight
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not initialize highlight drawer", e)
        }
    }

    override fun addTextChangedListener(watcher: TextWatcher) {
        if (watcher is TextInputTextWatcher) watchers.add(watcher)
        super.addTextChangedListener(watcher)
    }

    override fun removeTextChangedListener(watcher: TextWatcher) {
        if (watcher is TextInputTextWatcher) watchers.remove(watcher)
        super.removeTextChangedListener(watcher)
    }

    public fun pauseTextWatchers(block: () -> Unit): Unit = synchronized(this) {
        lockTextWatchers()
        try { block() } finally { unlockTextWatchers() }
    }

    public fun pauseSelectionWatcher(block: () -> Unit): Unit = synchronized(this) {
        isSelectionWatcherBlocked = true
        block()
        isSelectionWatcherBlocked = false
    }

    private fun lockTextWatchers() { watchers.forEach { it.lock() } }
    private fun unlockTextWatchers() { watchers.forEach { it.unlock() } }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        if (isFocused && !isSelectionWatcherBlocked) {
            selectionWatcher?.invoke(selStart..selEnd)
        }
        super.onSelectionChanged(selStart, selEnd)
    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (clipboardInterceptor == null) return super.onTextContextMenuItem(id)

        var consumed = false
        when (id) {
            paste -> {
                if (pasteAsPlainTextOnly) {
                    super.onTextContextMenuItem(android.R.id.pasteAsPlainText)
                    consumed = true
                } else {
                    clipboardInterceptor?.onClipboardAction(
                        ClipboardInterceptor.Action.Paste(selection = selectionStart..selectionEnd)
                    )
                    consumed = true
                }
            }
            copy -> {
                clipboardInterceptor?.onClipboardAction(
                    ClipboardInterceptor.Action.Copy(selection = selectionStart..selectionEnd)
                )
                consumed = true
            }
        }
        return if (!consumed) super.onTextContextMenuItem(id) else consumed
    }

    override fun onDraw(canvas: Canvas) {
        if (text is Spanned && layout != null) {
            canvas.withTranslation(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat()) {
                highlightDrawer?.draw(canvas, text as Spanned, layout, context.resources)
            }
        }
        super.onDraw(canvas)
    }

    public fun setLinksClickable() {
        Linkify.addLinks(this, Linkify.WEB_URLS)
        movementMethod = LinkMovementMethod.getInstance()
    }

    public fun setDefaultMovementMethod() {
        movementMethod = defaultMovementMethod
    }

    public fun setFocus() {
        showKeyboard()
    }

    public fun enableEnterKeyDetector(onEnterClicked: (IntRange) -> Unit) {
        setOnEditorActionListener(OnEnterActionListener(onEnter = { tv ->
            onEnterClicked.invoke(tv.selectionStart..tv.selectionEnd)
        }))
    }

    override fun onTouchEvent(event: MotionEvent?): Boolean {
        try {
            if (hasFocus() && !inReadMode) return super.onTouchEvent(event)
            return editorTouchProcessor.process(this, event)
        } catch (e: Exception) {
            Log.e(TAG, "Error processing touch event", e)
            return false
        }
    }

    override fun onDragEvent(event: DragEvent?): Boolean {
        return if (ignoreDragAndDrop) true else super.onDragEvent(event)
    }

    override fun onSaveInstanceState(): Parcelable {
        val superState = super.onSaveInstanceState()
        return WidgetState(superState, inReadMode)
    }

    override fun onRestoreInstanceState(state: Parcelable?) {
        val restoredState = state as? WidgetState ?: return super.onRestoreInstanceState(state)
        super.onRestoreInstanceState(restoredState.superSavedState ?: restoredState)
        inReadMode = restoredState.isInReadMode
    }

    public companion object {
        private const val TAG = "DocTextInputWidget"
        public val DEFAULT_INPUT_ACTION: InputAction = InputAction.NewLine
    }
}

private class WidgetState(
    val superSavedState: Parcelable?,
    val isInReadMode: Boolean,
) : Parcelable {
    override fun describeContents(): Int = 0
    override fun writeToParcel(dest: android.os.Parcel, flags: Int) {
        dest.writeParcelable(superSavedState, flags)
        dest.writeByte(if (isInReadMode) 1 else 0)
    }
    companion object CREATOR : android.os.Parcelable.Creator<WidgetState> {
        override fun createFromParcel(source: android.os.Parcel): WidgetState {
            val superState = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                source.readParcelable(WidgetState::class.java.classLoader, Parcelable::class.java)
            } else {
                @Suppress("DEPRECATION")
                source.readParcelable(WidgetState::class.java.classLoader)
            }
            val isInReadMode = source.readByte() != 0.toByte()
            return WidgetState(superState, isInReadMode)
        }
        override fun newArray(size: Int): Array<WidgetState?> = arrayOfNulls(size)
    }
}
