package com.tabtin.mobile.data.repository

import android.content.Context
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps a Composer's requested runtime configuration per durable session.
 *
 * The store deliberately keeps requested values rather than organization-clamped
 * values. Delivery applies the current organization policy immediately before a
 * message leaves the device, so a temporary policy change cannot erase a user's
 * preference or grant a stale queued row more authority.
 */
@Singleton
public class ConversationRuntimeConfigurationStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    public fun load(sessionId: String): ConversationRuntimeConfiguration? {
        val agentMode = preferences.getString(agentModeKey(sessionId), null)
        val approvalMode = preferences.getString(approvalModeKey(sessionId), null)
        if (agentMode == null && approvalMode == null) return null
        return ConversationRuntimeConfiguration.normalizedForStorage(agentMode, approvalMode)
    }

    public fun save(sessionId: String, configuration: ConversationRuntimeConfiguration) {
        preferences.edit().apply {
            if (configuration.agentMode.wireValue == DEFAULT_AGENT_MODE) {
                remove(agentModeKey(sessionId))
            } else {
                putString(agentModeKey(sessionId), configuration.agentMode.wireValue)
            }
            if (configuration.approvalMode.wireValue == DEFAULT_APPROVAL_MODE) {
                remove(approvalModeKey(sessionId))
            } else {
                putString(approvalModeKey(sessionId), configuration.approvalMode.wireValue)
            }
        }.apply()
    }

    private fun agentModeKey(sessionId: String): String = "agent_mode.$sessionId"

    private fun approvalModeKey(sessionId: String): String = "approval_mode.$sessionId"

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_conversation_runtime_configuration"
        private const val DEFAULT_AGENT_MODE = "agent"
        private const val DEFAULT_APPROVAL_MODE = "always_ask"
    }
}
