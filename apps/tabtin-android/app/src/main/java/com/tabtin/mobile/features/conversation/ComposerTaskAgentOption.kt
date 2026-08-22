package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.DeactivatedAgent

/** Composer 任务设置里的执行 Agent 选项；对齐 iOS `ComposerTaskAgentOption`。 */
public data class ComposerTaskAgentOption(
    val id: String,
    val name: String,
    val avatarUrl: String? = null,
    val avatarKey: String? = null,
    val isDefault: Boolean = false,
    val isAvailable: Boolean = true,
    val unavailableReason: String? = null,
)

public fun buildComposerTaskAgentOptions(
    agents: List<Agent>,
    deactivatedAgents: List<DeactivatedAgent> = emptyList(),
): List<ComposerTaskAgentOption> {
    val options = agents.map { agent ->
        ComposerTaskAgentOption(
            id = agent.id,
            name = agent.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: agent.name,
            avatarUrl = agent.settings?.avatarUrl?.trim()?.takeIf { it.isNotEmpty() },
            avatarKey = agent.settings?.avatarKey?.trim()?.takeIf { it.isNotEmpty() }
                ?: agent.icon?.trim()?.takeIf { it.isNotEmpty() },
            isDefault = agent.isDefault == true,
            isAvailable = agent.isActive,
            unavailableReason = if (!agent.isActive) "Agent 已停用" else null,
        )
    }.toMutableList()
    val activeIds = options.map { it.id }.toSet()
    deactivatedAgents
        .filterNot { it.id in activeIds }
        .forEach { agent ->
            options += ComposerTaskAgentOption(
                id = agent.id,
                name = agent.name,
                isAvailable = false,
                unavailableReason = "Agent 已停用",
            )
        }
    return options.sortedWith(
        compareByDescending<ComposerTaskAgentOption> { it.isAvailable }
            .thenBy { it.name.lowercase() },
    )
}
