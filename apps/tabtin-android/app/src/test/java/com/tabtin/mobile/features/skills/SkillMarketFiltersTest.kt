package com.tabtin.mobile.features.skills

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SkillMarketFiltersTest {
    private val user = "user-1"

    private fun skill(
        source: String = "app",
        visibility: String = "",
        appId: String? = null,
        distribution: String? = null,
        category: String? = null,
        ownerUserId: String? = null,
        acquired: Boolean = false,
    ) = SkillMarketFilterInput(
        source = source,
        visibility = visibility,
        appId = appId,
        distribution = distribution,
        category = category,
        ownerUserId = ownerUserId,
        acquired = acquired,
    )

    @Test
    fun resolveSkillMarketCategory() {
        assertEquals(SkillMarketCategoryChip.WRITING, SkillMarketFilters.resolveSkillMarketCategory("writing"))
        assertEquals(SkillMarketCategoryChip.WRITING, SkillMarketFilters.resolveSkillMarketCategory(" Writing "))
        assertNull(SkillMarketFilters.resolveSkillMarketCategory("developer"))
        assertNull(SkillMarketFilters.resolveSkillMarketCategory(null))
        assertNull(SkillMarketFilters.resolveSkillMarketCategory(""))
    }

    @Test
    fun recommendedPackIdsMatchElectron() {
        assertEquals(6, SkillMarketFilters.RECOMMENDED_MARKET_PACK_IDS.size)
        assertTrue("tabtin-writing-tools-pack" in SkillMarketFilters.RECOMMENDED_MARKET_PACK_IDS)
        assertFalse("tabtin-office-skills-pack" in SkillMarketFilters.RECOMMENDED_MARKET_PACK_IDS)
    }

    @Test
    fun isRecommendedMarketCatalogSkill() {
        val zip = skill(
            appId = "tabtin-writing-tools-pack",
            distribution = "marketplace",
            category = "writing",
        )
        assertTrue(SkillMarketFilters.isRecommendedMarketCatalogSkill(zip, user))

        val acquired = skill(
            appId = "tabtin-writing-tools-pack",
            distribution = "marketplace",
            category = "writing",
            acquired = true,
        )
        assertTrue(SkillMarketFilters.isMarketplaceMineSkill(acquired, user))
        assertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(acquired, user))

        val builtinApp = skill(appId = "tabdata", distribution = "builtin")
        assertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(builtinApp, user))

        val otherPack = skill(appId = "tabtin-office-skills-pack", distribution = "marketplace")
        assertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(otherPack, user))
    }

    @Test
    fun organizationAndMine() {
        val orgShared = skill(source = "user", visibility = "organization", ownerUserId = "other")
        assertTrue(SkillMarketFilters.isOrganizationSharedUserSkill(orgShared))
        assertTrue(
            SkillMarketFilters.matchesMarketplaceSourceFilter(
                orgShared, SkillMarketSourceChip.ORGANIZATION, user,
            ),
        )

        val minePrivate = skill(source = "user", visibility = "private", ownerUserId = user)
        assertTrue(SkillMarketFilters.isMarketplaceMineSkill(minePrivate, user))
        assertTrue(
            SkillMarketFilters.matchesMarketplaceSourceFilter(
                minePrivate, SkillMarketSourceChip.MINE, user,
            ),
        )

        val mineOrg = skill(source = "user", visibility = "organization", ownerUserId = user)
        assertTrue(SkillMarketFilters.isMarketplaceMineSkill(mineOrg, user))
        assertTrue(SkillMarketFilters.isOrganizationSharedUserSkill(mineOrg))

        val installedOnly = skill(source = "platform", acquired = false)
        assertFalse(SkillMarketFilters.isMarketplaceMineSkill(installedOnly, user))
    }

    @Test
    fun categoryFilter() {
        val writing = skill(category = "writing")
        assertTrue(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, SkillMarketCategoryChip.ALL))
        assertTrue(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, SkillMarketCategoryChip.WRITING))
        assertFalse(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, SkillMarketCategoryChip.DATA))
    }

    @Test
    fun visibleSearchMatchesOnlyCardText() {
        val visibleFields = listOf("文档润色", "改进中文表达", "平台技能", "1.2.0", "写作")

        assertTrue(SkillMarketFilters.matchesVisibleSearch(" 中文 ", visibleFields))
        assertTrue(SkillMarketFilters.matchesVisibleSearch("平台", visibleFields))
        assertTrue(SkillMarketFilters.matchesVisibleSearch("   ", visibleFields))
        assertFalse(SkillMarketFilters.matchesVisibleSearch("app:tabtin-hidden", visibleFields))
        assertFalse(SkillMarketFilters.matchesVisibleSearch("app", visibleFields))
    }

    @Test
    fun acquiredFromUserGates() {
        val gates = mapOf("app:tabtin-writing-tools-pack/humanizer-zh" to true)
        assertTrue(
            SkillMarketFilters.isAcquired("app:tabtin-writing-tools-pack/humanizer-zh", gates),
        )
        assertFalse(SkillMarketFilters.isAcquired("user:other", gates))
        assertFalse(SkillMarketFilters.isAcquired("", gates))
    }
}
