package com.tabtin.mobile.features.skills

/**
 * 市场筛选纯函数：对齐 Electron
 * - `apps/tabtin-electron/.../capability-marketplace/skillMarketTaxonomy.ts`
 * - `apps/tabtin-electron/.../skills/skillSourceGroups.ts`
 * - SkillPanel marketplaceMode：`builtin`→推荐 / `organization`→组织精选 / `mine`→我的
 */

internal enum class SkillMarketSourceChip(val title: String) {
    RECOMMENDED("推荐"),
    ORGANIZATION("组织精选"),
    MINE("我的"),
}

internal enum class SkillMarketCategoryChip(val key: String, val title: String) {
    ALL("all", "全部"),
    WRITING("writing", "文档写作"),
    COLLAB("collab", "协作效率"),
    DATA("data", "数据处理"),
    RESEARCH("research", "研究分析"),
    CREATIVE("creative", "创意设计"),
    ENGINEERING("engineering", "工程开发"),
    ;

    internal companion object {
        /** Electron `SKILL_MARKET_CATEGORY_ORDER`（不含 all） */
        val categoryOrder: List<SkillMarketCategoryChip> = listOf(
            WRITING, COLLAB, DATA, RESEARCH, CREATIVE, ENGINEERING,
        )

        private val byKey: Map<String, SkillMarketCategoryChip> =
            categoryOrder.associateBy { it.key }

        fun fromKey(key: String): SkillMarketCategoryChip? = byKey[key]
    }
}

/** 筛选所需字段子集；与列表模型解耦，便于单测。 */
internal data class SkillMarketFilterInput(
    val source: String,
    val visibility: String = "",
    val appId: String? = null,
    val distribution: String? = null,
    val category: String? = null,
    val ownerUserId: String? = null,
    val acquired: Boolean = false,
)

internal object SkillMarketFilters {
    /** Electron `RECOMMENDED_MARKET_PACK_IDS` */
    val RECOMMENDED_MARKET_PACK_IDS: Set<String> = setOf(
        "tabtin-writing-tools-pack",
        "tabtin-collab-efficiency-pack",
        "tabtin-data-toolkit-pack",
        "tabtin-business-analysis-pack",
        "tabtin-creative-toolkit-pack",
        "tabtin-dev-toolkit-pack",
    )

    // Taxonomy (skillMarketTaxonomy.ts)

    fun resolveSkillMarketCategory(category: String?): SkillMarketCategoryChip? {
        val normalized = category?.trim()?.lowercase().orEmpty()
        if (normalized.isEmpty()) return null
        return SkillMarketCategoryChip.fromKey(normalized)
    }

    fun isRecommendedMarketPackSkill(skill: SkillMarketFilterInput): Boolean {
        val appId = skill.appId?.trim().orEmpty()
        if (appId.isEmpty() || appId !in RECOMMENDED_MARKET_PACK_IDS) return false
        return skill.distribution == "marketplace"
    }

    // Source groups (skillSourceGroups.ts)

    fun normalizeSkillSource(source: String): String {
        val s = source.trim().lowercase()
        return when (s) {
            "platform", "app", "device", "user", "workspace" -> s
            else -> "user"
        }
    }

    private fun normalizeUserId(userId: String?): String =
        userId?.trim()?.lowercase().orEmpty()

    fun isSkillOwnedByCurrentUser(skill: SkillMarketFilterInput, currentUserId: String): Boolean {
        val ownerId = normalizeUserId(skill.ownerUserId)
        val viewerId = normalizeUserId(currentUserId)
        return ownerId.isNotEmpty() && viewerId.isNotEmpty() && ownerId == viewerId
    }

    /** Electron `isOrganizationSharedUserSkill` */
    fun isOrganizationSharedUserSkill(skill: SkillMarketFilterInput): Boolean =
        normalizeSkillSource(skill.source) == "user" && skill.visibility == "organization"

    /** Electron `isMarketplaceMineSkill` */
    fun isMarketplaceMineSkill(skill: SkillMarketFilterInput, currentUserId: String): Boolean {
        if (skill.acquired) return true
        return normalizeSkillSource(skill.source) == "user" &&
            isSkillOwnedByCurrentUser(skill, currentUserId)
    }

    /** Electron `isRecommendedMarketCatalogSkill` */
    fun isRecommendedMarketCatalogSkill(
        skill: SkillMarketFilterInput,
        currentUserId: String,
    ): Boolean {
        if (isMarketplaceMineSkill(skill, currentUserId)) return false
        if (normalizeSkillSource(skill.source) != "app") return false
        return isRecommendedMarketPackSkill(skill)
    }

    /** SkillPanel marketplaceMode 顶层来源 chip。 */
    fun matchesMarketplaceSourceFilter(
        skill: SkillMarketFilterInput,
        filter: SkillMarketSourceChip,
        currentUserId: String,
    ): Boolean = when (filter) {
        SkillMarketSourceChip.RECOMMENDED ->
            isRecommendedMarketCatalogSkill(skill, currentUserId)
        SkillMarketSourceChip.ORGANIZATION ->
            isOrganizationSharedUserSkill(skill)
        SkillMarketSourceChip.MINE ->
            isMarketplaceMineSkill(skill, currentUserId)
    }

    fun matchesMarketplaceCategoryFilter(
        skill: SkillMarketFilterInput,
        filter: SkillMarketCategoryChip,
    ): Boolean {
        if (filter == SkillMarketCategoryChip.ALL) return true
        return resolveSkillMarketCategory(skill.category) == filter
    }

    /** 只匹配当前列表卡片真实展示的文字，避免内部 key / source 造成隐式命中。 */
    fun matchesVisibleSearch(query: String, visibleFields: Iterable<String>): Boolean {
        val normalizedQuery = query.trim()
        if (normalizedQuery.isEmpty()) return true
        return visibleFields.joinToString(" ").contains(normalizedQuery, ignoreCase = true)
    }

    /** Electron：`user_gates` 含该 key → acquired。 */
    fun isAcquired(canonicalKey: String, userGates: Map<String, Boolean>): Boolean {
        val key = canonicalKey.trim()
        if (key.isEmpty()) return false
        return userGates.containsKey(key)
    }
}
