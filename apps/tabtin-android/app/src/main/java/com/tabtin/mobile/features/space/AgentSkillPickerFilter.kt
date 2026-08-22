package com.tabtin.mobile.features.space

import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.features.skills.SkillMarketFilters

/** 组织可见技能池减去已携带项，供 Agent 详情「添加技能」使用。 */
public object AgentSkillPickerFilter {
    public fun available(
        catalog: List<VisibleSkillEntry>,
        attachedKeys: Set<String>,
        query: String = "",
    ): List<VisibleSkillEntry> {
        val trimmed = query.trim()
        return catalog.filter { skill ->
            val key = skill.canonicalKey
            if (key.isBlank() || key in attachedKeys) return@filter false
            SkillMarketFilters.matchesVisibleSearch(
                query = trimmed,
                visibleFields = listOf(skill.resolvedName, skill.description),
            )
        }
    }
}
