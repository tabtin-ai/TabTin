package com.tabtin.mobile.features.doc.editor.holders

import android.app.Application
import android.content.Context
import android.view.LayoutInflater
import android.view.ContextThemeWrapper
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockImageBinding
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ImageHolderReadOnlyTest {

    @Test
    fun `adapter composes document and image readonly state`() {
        val editable = TabDocBlockView.Image(id = "new", url = "", isReadOnly = false)
        val readonly = TabDocBlockView.Image(id = "existing", url = "", isReadOnly = true)

        assertFalse(isBlockEffectivelyReadOnly(editable, documentReadOnly = false))
        assertTrue(isBlockEffectivelyReadOnly(readonly, documentReadOnly = false))
        assertTrue(isBlockEffectivelyReadOnly(editable, documentReadOnly = true))
    }

    @Test
    fun `readonly empty image placeholder is disabled and cannot invoke picker`() {
        val context = ContextThemeWrapper(
            ApplicationProvider.getApplicationContext<Context>(),
            R.style.Theme_TabTin,
        )
        val binding = DocBlockImageBinding.inflate(
            LayoutInflater.from(context),
            FrameLayout(context),
            false,
        )
        var clicks = 0
        val holder = ImageHolder(
            binding = binding,
            onImagePlaceholderClick = { clicks++ },
        )

        holder.bind(TabDocBlockView.Image(id = "existing", url = "", isReadOnly = true))
        holder.setReadOnly(true)

        assertFalse(binding.placeholder.isEnabled)
        assertFalse(binding.placeholder.isClickable)
        assertFalse(binding.placeholder.isFocusable)
        // Android 的 performClick 会直接调用已注册 listener，即使 View 已 disabled；
        // Holder 内部只读门禁仍必须阻止业务回调。
        binding.placeholder.performClick()
        assertTrue(clicks == 0)
    }
}
