package com.tabtin.mobile.data.repository

import android.content.Context
import com.tabtin.mobile.data.model.ConversationAgentMode
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConversationRuntimeConfigurationStoreTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.deleteSharedPreferences(PREFERENCES_NAME)
    }

    @After
    fun tearDown() {
        context.deleteSharedPreferences(PREFERENCES_NAME)
    }

    @Test
    fun `stores a requested configuration per session without leaking it to another session`() {
        val store = ConversationRuntimeConfigurationStore(context)
        val configuration = ConversationRuntimeConfiguration(
            agentMode = ConversationAgentMode.GROUP,
            approvalMode = ConversationApprovalMode.FULL_ACCESS,
        )

        store.save("session-a", configuration)

        assertEquals(configuration, store.load("session-a"))
        assertNull(store.load("session-b"))
    }

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_conversation_runtime_configuration"
    }
}
