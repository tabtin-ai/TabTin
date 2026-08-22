package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AgentStreamEvent

/**
 * ：父 topic 上带 `subagent_run_id` 的 raw `agent.stream.*` 不得灌进主气泡。
 *
 * 对齐 iOS `SubagentStreamRouting`：纯函数门闩，决定是否从父时间线隔离并改写为子流。
 * `agent.stream.subagent*` 元事件 / 包装事件走既有 decode；persist 类回执也不进 transcript。
 */
public object SubagentStreamRouting {
    /** `agent.stream.subagent_*` 元事件与包装事件走既有 decode，不经本门闩改写。 */
    private val subagentEventPrefix = "${AgentStreamEvent.PREFIX}subagent"

    /** Electron 在隔离 guard 前直接 return 的 persist；Android 对应落库回执也不该进子 transcript。 */
    private val parentOnlyShortNames: Set<String> = setOf(
        AgentStreamEvent.MESSAGE_PERSISTED,
        AgentStreamEvent.MESSAGE_COMMITTED,
        "persist_message",
    )

    public fun subagentRunId(env: WSEnvelope): String? {
        val raw = env.payloadString("subagent_run_id") ?: env.payloadString("subagent_id")
        val trimmed = raw?.trim().orEmpty()
        return trimmed.takeIf { it.isNotEmpty() }
    }

    /** 是否应把该 envelope 从父时间线隔离并改写为子流。 */
    public fun shouldIsolateFromParentTimeline(env: WSEnvelope): Boolean {
        if (!env.type.startsWith(AgentStreamEvent.PREFIX)) return false
        if (subagentRunId(env) == null) return false
        if (env.type.startsWith(subagentEventPrefix)) return false
        val short = env.type.removePrefix(AgentStreamEvent.PREFIX)
        if (short in parentOnlyShortNames) return false
        return true
    }
}
