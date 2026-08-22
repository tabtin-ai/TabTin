package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.SkillsApi
import com.tabtin.mobile.data.api.apiErrorMessage
import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentLocalMcpAttachment
import com.tabtin.mobile.data.model.AgentMemoryCorrectRequest
import com.tabtin.mobile.data.model.AgentMemoryLifecycleRequest
import com.tabtin.mobile.data.model.AgentMemoryRecord
import com.tabtin.mobile.data.model.AgentProjectTask
import com.tabtin.mobile.data.model.AgentSkillAttachRequest
import com.tabtin.mobile.data.model.AgentSkillEnabledRequest
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.OrgMcpConnection
import com.tabtin.mobile.data.model.VisibleSkillEntry
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.HttpException

/**
 * AI分身详情的按需数据源。
 *
 * 与列表用的 SpaceRepository 分开，避免列表摘要在进入详情后被高体积的记忆/任务数据污染。
 */
@Singleton
public class AgentDetailRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val chatApi: ChatApi,
    private val skillsApi: SkillsApi,
) {
    public suspend fun getAgent(agentId: String): Agent = contextApi.getAgent(agentId).unwrap()

    public suspend fun getSkills(agentId: String): List<AgentSkillLink> =
        contextApi.getAgentSkills(agentId).unwrap().skills

    public suspend fun getOrgMcpConnections(organizationId: String): List<OrgMcpConnection> =
        contextApi.getOrgMcpConnections(organizationId).unwrap().connections

    /**
     * 查询 Agent 在当前用户在线 Electron 上已挂载且启用的 MCP。
     * 电脑离线 / 超时抛 [AgentLocalMcpDeviceOfflineException]。
     */
    public suspend fun getAgentLocalMcpAttachments(agentId: String): List<AgentLocalMcpAttachment> =
        try {
            contextApi.getAgentLocalMcpAttachments(agentId).unwrap().connections
        } catch (error: HttpException) {
            throw mapLocalMcpHttpError(error) ?: error
        } catch (error: AppError.RequestFailed) {
            if (isDeviceRuntimeUnavailableCode(error.errorCode)) {
                throw AgentLocalMcpDeviceOfflineException(error.errorCode, error.serverMessage)
            }
            throw error
        }

    public suspend fun getVisibleSkills(organizationId: String): List<VisibleSkillEntry> =
        skillsApi.getVisibleSkills(organizationId = organizationId).unwrap().skills

    public suspend fun attachSkill(agentId: String, skillKey: String): AgentSkillLink =
        contextApi.attachAgentSkill(
            agentId = agentId,
            body = AgentSkillAttachRequest(skillCanonicalKey = skillKey),
        ).unwrap()

    public suspend fun updateSkill(agentId: String, skillKey: String, enabled: Boolean): AgentSkillLink =
        contextApi.updateAgentSkill(agentId, skillKey, AgentSkillEnabledRequest(enabled)).unwrap()

    public suspend fun removeSkill(agentId: String, skillKey: String): Unit {
        contextApi.removeAgentSkill(agentId, skillKey).unwrap()
    }

    public suspend fun getMemories(organizationId: String, agentId: String): List<AgentMemoryRecord> =
        contextApi.getAgentMemories(organizationId = organizationId, agentId = agentId).unwrap().items

    public suspend fun forgetMemory(organizationId: String, agentId: String, memoryId: String): Unit {
        contextApi.forgetAgentMemory(
            memoryId = memoryId,
            body = AgentMemoryLifecycleRequest(organizationId = organizationId, agentId = agentId),
        ).unwrap()
    }

    public suspend fun correctMemory(
        organizationId: String,
        agentId: String,
        memory: AgentMemoryRecord,
        content: String,
    ): AgentMemoryRecord =
        contextApi.correctAgentMemory(
            memoryId = memory.id,
            body = AgentMemoryCorrectRequest(
                organizationId = organizationId,
                agentId = agentId,
                content = content,
                memoryType = memory.memoryType.ifBlank { null },
            ),
        ).unwrap()

    public suspend fun getSessions(organizationId: String, agentId: String): List<AllChatSession> =
        chatApi.getAllSessions(
            organizationId = organizationId,
            limit = 10,
            status = "active",
            agentId = agentId,
        ).unwrap().sessions

    public suspend fun getProjectTasks(organizationId: String, agentId: String): List<AgentProjectTask> =
        contextApi.getAgentProjectTasks(organizationId, agentId).unwrap().tasks
}

/** 电脑 Electron 离线 / 不可用 / 查询超时，工具携带集应展示离线提示。 */
public class AgentLocalMcpDeviceOfflineException(
    public val errorCode: String?,
    public val serverMessage: String? = null,
) : Exception(serverMessage ?: errorCode ?: "DEVICE_RUNTIME_OFFLINE")

private val DEVICE_RUNTIME_UNAVAILABLE_CODES: Set<String> = setOf(
    "DEVICE_RUNTIME_OFFLINE",
    "DEVICE_RUNTIME_UNAVAILABLE",
    "TASK_TIMEOUT",
)

private fun isDeviceRuntimeUnavailableCode(code: String?): Boolean =
    code?.trim()?.uppercase() in DEVICE_RUNTIME_UNAVAILABLE_CODES

private fun mapLocalMcpHttpError(error: HttpException): AgentLocalMcpDeviceOfflineException? {
    val status = error.code()
    val rawBody = error.response()?.errorBody()?.string()
    val payloadCode = runCatching {
        rawBody
            ?.let(json::parseToJsonElement)
            ?.jsonObject
            ?.let { payload ->
                payload["error_code"]?.jsonPrimitive?.contentOrNull
                    ?: payload["code"]?.jsonPrimitive?.contentOrNull
            }
    }.getOrNull()
    val message = apiErrorMessage(rawBody)
    if (isDeviceRuntimeUnavailableCode(payloadCode)) {
        return AgentLocalMcpDeviceOfflineException(payloadCode, message)
    }
    // 裸 409 / 504：契约未合入或信封缺码时的兜底。
    if (status == 409 || status == 504) {
        return AgentLocalMcpDeviceOfflineException(payloadCode, message)
    }
    return null
}
