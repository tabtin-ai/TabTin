package com.tabtin.mobile.features.tabdata

import android.util.Log
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationMemberProfile
import com.tabtin.mobile.data.repository.OrganizationRepository
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * 按 organizationId 缓存人员目录。打开多维表时 warm-up，避免每行各发一次请求。
 */
@Singleton
public class TabDataMemberDirectoryStore @Inject constructor(
    private val organizationRepository: OrganizationRepository,
) {
    private val cache = ConcurrentHashMap<String, TabDataMemberDirectory>()
    private val fetchedExtraIds = ConcurrentHashMap<String, MutableSet<String>>()

    public fun snapshot(organizationId: String): TabDataMemberDirectory =
        cache[organizationId] ?: TabDataMemberDirectory.Empty

    public fun remember(
        organizationId: String,
        members: Collection<TabDataDirectoryMember>,
    ): TabDataMemberDirectory {
        val orgId = organizationId.trim()
        if (orgId.isEmpty() || members.isEmpty()) return snapshot(orgId)
        val current = cache[orgId] ?: TabDataMemberDirectory.Empty
        val merged = current.copy(
            members = (current.members + members).distinctBy(TabDataDirectoryMember::userId),
        )
        cache[orgId] = merged
        return merged
    }

    public suspend fun searchMembers(
        organizationId: String,
        query: String,
        offset: Int = 0,
        limit: Int = TabDataUserFieldPolicy.SEARCH_PAGE_LIMIT,
    ): TabDataMemberSearchPage {
        val orgId = organizationId.trim()
        if (orgId.isEmpty()) return TabDataMemberSearchPage()
        val request = TabDataUserFieldPolicy.searchQuery(query, offset, limit)
        val response = organizationRepository.searchMembers(
            orgId,
            search = request.search,
            searchMode = request.searchMode,
            offset = request.offset,
            limit = request.limit,
        )
        val members = response.members.mapNotNull(::toDirectoryMember)
        remember(orgId, members)
        val total = if (response.total > 0) response.total else request.offset + members.size
        return TabDataMemberSearchPage(members = members, total = total)
    }

    public suspend fun warmUp(
        organizationId: String,
        extraUserIds: Collection<String> = emptyList(),
    ): TabDataMemberDirectory {
        val orgId = organizationId.trim()
        if (orgId.isEmpty()) return TabDataMemberDirectory.Empty

        var current = cache[orgId]
        if (current == null) {
            current = loadBaseDirectory(orgId)
            cache[orgId] = current
        }

        val missing = TabDataMemberDirectory.chunkUserIds(extraUserIds)
            .flatten()
            .filter { userId -> !current.knows(userId) && fetchedExtraIds[orgId]?.contains(userId) != true }
        if (missing.isEmpty()) return current

        val profiles = runCatching {
            organizationRepository.batchMemberProfiles(orgId, missing)
        }.onFailure { error ->
            Log.w(TAG, "batchMemberProfiles failed: ${error.message}")
        }.getOrDefault(emptyList())

        fetchedExtraIds.getOrPut(orgId) { ConcurrentHashMap.newKeySet() }.addAll(missing)
        val added = profiles.mapNotNull(::toDirectoryMember)
        if (added.isEmpty()) return current

        val merged = current.copy(members = (current.members + added).distinctBy(TabDataDirectoryMember::userId))
        cache[orgId] = merged
        return merged
    }

    public fun clear(organizationId: String? = null) {
        if (organizationId.isNullOrBlank()) {
            cache.clear()
            fetchedExtraIds.clear()
        } else {
            cache.remove(organizationId)
            fetchedExtraIds.remove(organizationId)
        }
    }

    private suspend fun loadBaseDirectory(organizationId: String): TabDataMemberDirectory = coroutineScope {
        val membersDeferred = async {
            runCatching { organizationRepository.loadMembers(organizationId) }
                .onFailure { error -> Log.w(TAG, "loadMembers failed: ${error.message}") }
                .getOrDefault(emptyList())
        }
        val snapshotsDeferred = async {
            runCatching { organizationRepository.loadMemberIdentitySnapshots(organizationId) }
                .onFailure { error -> Log.w(TAG, "identitySnapshots failed: ${error.message}") }
                .getOrDefault(null)
        }
        val members = membersDeferred.await().mapNotNull(::toDirectoryMember)
        val snapshots = snapshotsDeferred.await()?.identities.orEmpty().map { snapshot ->
            TabDataIdentitySnapshot(
                userId = snapshot.userId,
                displayName = snapshot.displayName,
                leftAt = snapshot.leftAt,
            )
        }
        TabDataMemberDirectory(members = members, identitySnapshots = snapshots)
    }

    private fun toDirectoryMember(member: OrganizationMember): TabDataDirectoryMember? {
        val userId = member.userId.trim()
        if (userId.isEmpty()) return null
        val displayName = sequenceOf(member.user?.nickname, member.user?.username)
            .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
            .firstOrNull()
            ?: ""
        return TabDataDirectoryMember(
            userId = userId,
            displayName = displayName,
            avatarUrl = member.user?.avatar?.trim()?.takeIf(String::isNotEmpty),
        )
    }

    private fun toDirectoryMember(profile: OrganizationMemberProfile): TabDataDirectoryMember? {
        val userId = profile.id.trim()
        if (userId.isEmpty()) return null
        val displayName = sequenceOf(profile.nickname, profile.username)
            .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
            .firstOrNull()
            ?: ""
        return TabDataDirectoryMember(
            userId = userId,
            displayName = displayName,
            avatarUrl = profile.avatar.trim().takeIf(String::isNotEmpty),
        )
    }

    private companion object {
        private const val TAG = "TabDataMemberDirectory"
    }
}
