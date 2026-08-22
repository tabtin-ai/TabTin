package com.tabtin.mobile.data.model

import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.R
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppErrorAgentExecutionTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `maps device_offline code without raw snake case`() {
        val error = AppError.AgentExecution(
            serverMessage = "",
            errorCategory = "device_offline",
            errorCode = "device_offline",
        )
        assertEquals(
            context.getString(R.string.chat_error_device_offline),
            error.toUserMessage(context),
        )
    }

    @Test
    fun `maps raw device_offline server message`() {
        val error = AppError.AgentExecution(serverMessage = "device_offline")
        assertEquals(
            context.getString(R.string.chat_error_device_offline),
            error.toUserMessage(context),
        )
    }
}
