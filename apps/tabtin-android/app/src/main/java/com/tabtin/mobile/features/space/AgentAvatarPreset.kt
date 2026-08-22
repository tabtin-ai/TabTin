package com.tabtin.mobile.features.space

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.tabtin.mobile.R

/**
 * 与 iOS `AgentAvatarPreset`、Electron `agentAvatarPresets.ts` 共用 `avatar_key` 契约。
 * 服务端只保存 key，各端在本地解析为品牌预设图。
 */
internal enum class AgentAvatarPreset(
    val key: String,
    @DrawableRes val drawableRes: Int,
    @StringRes val labelRes: Int,
) {
    GENERAL_ASSISTANT("general-assistant", R.drawable.agent_avatar_general_assistant, R.string.my_agents_avatar_general_assistant),
    CODE_ENGINEER("code-engineer", R.drawable.agent_avatar_code_engineer, R.string.my_agents_avatar_code_engineer),
    DOC_WRITER("doc-writer", R.drawable.agent_avatar_doc_writer, R.string.my_agents_avatar_doc_writer),
    DATA_ANALYST("data-analyst", R.drawable.agent_avatar_data_analyst, R.string.my_agents_avatar_data_analyst),
    WEB_RESEARCHER("web-researcher", R.drawable.agent_avatar_web_researcher, R.string.my_agents_avatar_web_researcher),
    SLIDE_DESIGNER("slide-designer", R.drawable.agent_avatar_slide_designer, R.string.my_agents_avatar_slide_designer),
    OFFICE_SECRETARY("office-secretary", R.drawable.agent_avatar_office_secretary, R.string.my_agents_avatar_office_secretary),
    FUNCTION_GENERAL_ASSISTANT(
        "function-general-assistant",
        R.drawable.agent_avatar_function_general_assistant,
        R.string.my_agents_avatar_function_general_assistant,
    ),
    FUNCTION_CODE_ENGINEER(
        "function-code-engineer",
        R.drawable.agent_avatar_function_code_engineer,
        R.string.my_agents_avatar_function_code_engineer,
    ),
    FUNCTION_DOC_WRITER(
        "function-doc-writer",
        R.drawable.agent_avatar_function_doc_writer,
        R.string.my_agents_avatar_function_doc_writer,
    ),
    FUNCTION_DATA_ANALYST(
        "function-data-analyst",
        R.drawable.agent_avatar_function_data_analyst,
        R.string.my_agents_avatar_function_data_analyst,
    ),
    FUNCTION_WEB_RESEARCHER(
        "function-web-researcher",
        R.drawable.agent_avatar_function_web_researcher,
        R.string.my_agents_avatar_function_web_researcher,
    ),
    FUNCTION_SLIDE_DESIGNER(
        "function-slide-designer",
        R.drawable.agent_avatar_function_slide_designer,
        R.string.my_agents_avatar_function_slide_designer,
    ),
    FUNCTION_OFFICE_SECRETARY(
        "function-office-secretary",
        R.drawable.agent_avatar_function_office_secretary,
        R.string.my_agents_avatar_function_office_secretary,
    ),
    ;

    companion object {
        private val byKey = entries.associateBy(AgentAvatarPreset::key)

        fun from(raw: String?): AgentAvatarPreset? =
            raw?.trim()?.takeIf { it.isNotEmpty() }?.let(byKey::get)
    }
}
