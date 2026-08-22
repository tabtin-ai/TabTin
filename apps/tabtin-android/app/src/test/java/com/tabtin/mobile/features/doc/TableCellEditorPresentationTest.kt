package com.tabtin.mobile.features.doc

import android.app.Application
import android.view.ContextThemeWrapper
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.editor.core.DocTextInputWidget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class TableCellEditorPresentationTest {

    private val context = ContextThemeWrapper(
        RuntimeEnvironment.getApplication(),
        R.style.Theme_TabTin,
    )

    @Test
    fun `programmatic cell editor uses solid body color instead of sheet hint color`() {
        val widget = DocTextInputWidget(context)
        TableCellEditorPresentation.applyReadableBodyColor(widget)

        val primary = ContextCompat.getColor(context, R.color.doc_editor_text_primary)
        val tertiary = ContextCompat.getColor(context, R.color.doc_editor_text_tertiary)
        assertEquals(primary, widget.currentTextColor)
        assertNotEquals(tertiary, widget.currentTextColor)
    }
}
