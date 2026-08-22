package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.SkillsApi
import com.tabtin.mobile.data.model.SkillApiKeyRequest
import com.tabtin.mobile.data.model.SkillConfig
import com.tabtin.mobile.data.model.SkillEnableRequest
import com.tabtin.mobile.data.model.SkillToggleRequest
import com.tabtin.mobile.data.model.SpaceSkill
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.cancellation.CancellationException

@Singleton
public class SkillsRepository @Inject constructor(
    private val skillsApi: SkillsApi,
) {
    private val mutex = Mutex()

    @Volatile
    private var cache: SkillsCacheEntry? = null

    public suspend fun getSkills(spaceId: String, forceRefresh: Boolean = false): Pair<List<SpaceSkill>, Map<String, SkillConfig>> {
        if (!forceRefresh) {
            cache?.takeIf { it.spaceId == spaceId && !it.isExpired }?.let {
                return it.skills to it.configs
            }
        }

        return mutex.withLock {
            if (!forceRefresh) {
                cache?.takeIf { it.spaceId == spaceId && !it.isExpired }?.let {
                    return@withLock it.skills to it.configs
                }
            }

            val skills: List<SpaceSkill>
            var configs: Map<String, SkillConfig> = emptyMap()

            try {
                skills = skillsApi.getSkillsIndex(spaceId).unwrap().skills
                try {
                    configs = skillsApi.getSkillsConfig(spaceId).unwrap().configs
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val fallback = skillsApi.getSpaceSkills(spaceId).unwrap().skills
                cache = SkillsCacheEntry(spaceId, fallback, emptyMap())
                return@withLock fallback to emptyMap()
            }

            cache = SkillsCacheEntry(spaceId, skills, configs)
            skills to configs
        }
    }

    public suspend fun toggleSkill(
        spaceId: String,
        skill: SpaceSkill,
        enabled: Boolean,
        currentConfigs: Map<String, SkillConfig>,
    ): Map<String, SkillConfig> {
        val key = skill.skillKey
        return if (key != null) {
            skillsApi.toggleSkill(key, SkillToggleRequest(spaceId, enabled))
            val updated = currentConfigs.toMutableMap()
            val existing = updated[key] ?: SkillConfig()
            updated[key] = existing.copy(enabled = enabled)
            invalidateCache()
            updated
        } else {
            skillsApi.updateSpaceSkill(spaceId, skill.resolvedId, SkillEnableRequest(enabled))
            invalidateCache()
            currentConfigs
        }
    }

    public suspend fun saveApiKey(spaceId: String, skillKey: String, apiKey: String) {
        skillsApi.updateSkillApiKey(skillKey, SkillApiKeyRequest(spaceId, apiKey))
        invalidateCache()
    }

    private fun invalidateCache() {
        cache = null
    }

    private class SkillsCacheEntry(
        val spaceId: String,
        val skills: List<SpaceSkill>,
        val configs: Map<String, SkillConfig>,
        private val fetchedAt: Long = System.currentTimeMillis(),
    ) {
        val isExpired: Boolean
            get() = System.currentTimeMillis() - fetchedAt > TTL_MS

        companion object {
            private const val TTL_MS = 60_000L
        }
    }
}
