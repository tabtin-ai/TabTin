package com.tabtin.mobile.features.conversation

import androidx.annotation.DrawableRes
import com.tabtin.mobile.R

/**
 * Agent 预置头像。与 iOS `AgentAvatarPreset` / Electron `agentAvatarPresets.ts`
 * 共用同一套 `avatar_key` 契约——后端把 key 原样下发，各端解析成自己的内置图，
 * 不由后端拼死链接。
 */
internal enum class AgentAvatarPreset(
    val key: String,
    @DrawableRes val drawableRes: Int,
) {
    GENERAL_ASSISTANT("general-assistant", R.drawable.agent_avatar_general_assistant),
    CODE_ENGINEER("code-engineer", R.drawable.agent_avatar_code_engineer),
    DOC_WRITER("doc-writer", R.drawable.agent_avatar_doc_writer),
    DATA_ANALYST("data-analyst", R.drawable.agent_avatar_data_analyst),
    WEB_RESEARCHER("web-researcher", R.drawable.agent_avatar_web_researcher),
    SLIDE_DESIGNER("slide-designer", R.drawable.agent_avatar_slide_designer),
    OFFICE_SECRETARY("office-secretary", R.drawable.agent_avatar_office_secretary),
    FUNCTION_GENERAL_ASSISTANT("function-general-assistant", R.drawable.agent_avatar_function_general_assistant),
    FUNCTION_CODE_ENGINEER("function-code-engineer", R.drawable.agent_avatar_function_code_engineer),
    FUNCTION_DOC_WRITER("function-doc-writer", R.drawable.agent_avatar_function_doc_writer),
    FUNCTION_DATA_ANALYST("function-data-analyst", R.drawable.agent_avatar_function_data_analyst),
    FUNCTION_WEB_RESEARCHER("function-web-researcher", R.drawable.agent_avatar_function_web_researcher),
    FUNCTION_SLIDE_DESIGNER("function-slide-designer", R.drawable.agent_avatar_function_slide_designer),
    FUNCTION_OFFICE_SECRETARY("function-office-secretary", R.drawable.agent_avatar_function_office_secretary),
    ;

    companion object {
        private val BY_KEY = entries.associateBy(AgentAvatarPreset::key)

        fun from(raw: String?): AgentAvatarPreset? =
            raw?.trim()?.takeIf { it.isNotEmpty() }?.let(BY_KEY::get)
    }
}
