package com.tabtin.mobile.features.space

/**
 * 添加技能成功后的短暂提示文案形态。
 * 单条：「已添加 xx」；多条：「已添加 xx 等 n 个技能」。
 */
public sealed class AgentSkillAttachFeedback {
    public data class Single(val name: String) : AgentSkillAttachFeedback()
    public data class Batch(val firstName: String, val count: Int) : AgentSkillAttachFeedback()

    public companion object {
        public fun fromNames(names: List<String>): AgentSkillAttachFeedback? {
            val cleaned = names.map { it.trim() }.filter { it.isNotEmpty() }
            if (cleaned.isEmpty()) return null
            val first = cleaned.first()
            return if (cleaned.size == 1) {
                Single(first)
            } else {
                Batch(firstName = first, count = cleaned.size)
            }
        }
    }
}
