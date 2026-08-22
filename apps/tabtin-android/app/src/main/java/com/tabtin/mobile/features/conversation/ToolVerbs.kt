package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes

/**
 * 工具名 → 动作短语。实现已迁到 [ToolRowPresentation]；本对象只保留
 * [resIdFor] 薄封装，给审批卡等既有调用点用。
 *
 * 未知工具返回 [com.tabtin.mobile.R.string.chat_tool_verb_generic]，不再返回 null。
 */
internal object ToolVerbs {

    @StringRes
    internal fun resIdFor(toolName: String): Int = ToolRowPresentation.of(toolName).labelResId
}
