package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.local.SessionListDao
import com.tabtin.mobile.data.local.SessionListEntity
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.AllSessionListResponse
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * drawer "全部对话" 视图的数据源（跨 Space ChatSession 聚合查询）。
 *
 * 与 [ChatRepository] 互不影响——两者用于不同 UI 上下文，把跨 space 查询塞进
 * ChatRepository 会让 per-agent 与跨 agent 两个用例的 cache 互踩。
 */
@Singleton
public class AllSessionsRepository @Inject constructor(
    private val chatApi: ChatApi,
    private val tokenManager: TokenManager,
    private val sessionListDao: SessionListDao,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
) {
    public val currentOrganizationId: String?
        get() = tokenManager.organizationId

    public suspend fun getCachedRecent(organizationId: String): List<AllChatSession> = withContext(Dispatchers.IO) {
        sessionListDao.get(SessionListEntity.recentScope(organizationId))
            ?.toRecentSessions()
            .orEmpty()
            .map(::mergeAuthoritativeRunState)
    }

    public suspend fun listAll(
        status: String? = "active",
        limit: Int = 50,
        offset: Int = 0,
        keyword: String? = null,
        agentId: String? = null,
        workspaceId: String? = null,
        runStatus: String? = null,
    ): AllSessionListResponse {
        val wsId = tokenManager.organizationId ?: throw AppError.NoOrganization
        val isDefaultRecentQuery = status == "active" &&
            keyword.isNullOrBlank() &&
            agentId.isNullOrBlank() &&
            workspaceId.isNullOrBlank() &&
            runStatus.isNullOrBlank()
        return try {
            val response = chatApi.getAllSessions(
                organizationId = wsId,
                limit = limit,
                offset = offset,
                status = status,
                keyword = keyword,
                agentId = agentId,
                workspaceId = workspaceId,
                runStatus = runStatus,
            ).unwrap()
            val sessions = response.sessions.map(::mergeAuthoritativeRunState)
            if (offset == 0 && isDefaultRecentQuery) cacheRecent(wsId, sessions)
            response.copy(sessions = sessions)
        } catch (e: AppError.RequestFailed) {
            if (offset == 0 && isDefaultRecentQuery) {
                val cached = getCachedRecent(wsId)
                if (cached.isNotEmpty()) {
                    return AllSessionListResponse(
                        sessions = cached,
                        total = cached.size,
                        hasMore = false,
                    )
                }
            }
            throw AppError.ActionFailed(ActionLabel.LOAD_SESSIONS, e.serverMessage)
        }
    }

    /**
     * 活跃会话被归档后同步剔除「最近」的离线快照，避免下次进页面先秒显旧会话。
     * 空列表不保留一条空快照，直接删 scope，读取端同样会得到空列表。
     */
    public suspend fun removeCachedRecentSession(sessionId: String): Unit = withContext(Dispatchers.IO) {
        val organizationId = tokenManager.organizationId ?: return@withContext
        val scope = SessionListEntity.recentScope(organizationId)
        val cached = sessionListDao.get(scope)?.toRecentSessions().orEmpty()
        if (cached.isEmpty()) return@withContext

        val remaining = cached.filterNot { it.id == sessionId }
        if (remaining.isEmpty()) {
            sessionListDao.delete(scope)
        } else {
            val entity = SessionListEntity.fromRecent(organizationId, remaining) ?: return@withContext
            sessionListDao.upsert(entity)
        }
    }

    private suspend fun cacheRecent(organizationId: String, sessions: List<AllChatSession>) = withContext(Dispatchers.IO) {
        val entity = SessionListEntity.fromRecent(organizationId, sessions) ?: return@withContext
        sessionListDao.upsert(entity)
        sessionListDao.evictOldScopes()
    }

    private fun mergeAuthoritativeRunState(session: AllChatSession): AllChatSession {
        session.runState?.let { sessionRunStateStore.accept(session.id, it) }
        session.readState?.let { sessionReadStateStore.accept(session.id, it) }
        val latestRunState = sessionRunStateStore.latest(session.id)
        val latestReadState = sessionReadStateStore.latest(session.id)
        return session.copy(
            runState = latestRunState ?: session.runState,
            hasActiveTask = latestRunState?.isActive ?: session.hasActiveTask,
            lastRunFailed = latestRunState?.let { it.status == SessionRunStatus.FAILED } ?: session.lastRunFailed,
            readState = latestReadState ?: session.readState,
            hasUnreadReply = latestReadState?.hasUnreadReply ?: session.hasUnreadReply,
        )
    }
}
