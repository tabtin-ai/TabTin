package com.tabtin.mobile.features.conversation

import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.R
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ErrorContentLocalizerTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `maps raw device_offline snake case`() {
        assertEquals(
            context.getString(R.string.chat_error_device_offline),
            ErrorContentLocalizer.localize("device_offline", context),
        )
    }

    @Test
    fun `maps bracketed device_offline code`() {
        assertEquals(
            context.getString(R.string.chat_error_device_offline),
            ErrorContentLocalizer.localize("[device_offline] device_offline", context),
        )
    }
}
