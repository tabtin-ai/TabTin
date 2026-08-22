package com.tabtin.mobile.data.repository

import android.content.Context
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.SkillsApi
import com.tabtin.mobile.data.model.AgentSkillAttachRequest
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AgentSkillUpdateRequest
import com.tabtin.mobile.data.model.CredentialListItem
import com.tabtin.mobile.data.model.MobileConnectorDeviceLoader
import com.tabtin.mobile.data.model.MobileConnectorMarketItem
import com.tabtin.mobile.data.model.MobileConnectorMarketProjector
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.data.model.VisibleSkillListResponse
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject

/**
 * 手机技能库的数据边界。
 *
 * 目录是组织范围的，不要求用户先选定一个 AI 分身；各 AI 分身的携带态在此聚合。
 * 刻意不复用旧 Space Skills 的本机安装与 API Key 配置链路。Credential Vault 只读取
 * 脱敏元数据，写入时只传已有 credential_id。
 */
public class MobileSkillLibraryRepository @Inject constructor(
    private val skillsApi: SkillsApi,
    private val contextApi: ContextApi,
    @ApplicationContext private val appContext: Context,
) {
    public suspend fun load(
        organizationId: String,
        agentIds: List<String>,
    ): MobileSkillLibrarySnapshot = coroutineScope {
        val visible = async {
            skillsApi.getVisibleSkills(organizationId = organizationId).unwrap()
        }
        val links = agentIds.map { agentId ->
            async { agentId to contextApi.getAgentSkills(agentId).unwrap().skills }
        }
        val credentials = async {
            try {
                skillsApi.getCredentials()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                // 凭据列表不可用不应阻塞技能目录；详情页仍可添加/启停该技能。
                emptyList()
            }
        }
        val response: VisibleSkillListResponse = visible.await()
        MobileSkillLibrarySnapshot(
            catalog = response.skills,
            userGates = response.userGates,
            linksByAgent = links.awaitAll().toMap(),
            credentials = credentials.await(),
        )
    }

    public suspend fun attach(agentId: String, canonicalKey: String): AgentSkillLink =
        contextApi.attachAgentSkill(
            agentId = agentId,
            body = AgentSkillAttachRequest(skillCanonicalKey = canonicalKey),
        ).unwrap()

    public suspend fun setEnabled(
        agentId: String,
        canonicalKey: String,
        enabled: Boolean,
    ): AgentSkillLink = contextApi.updateAgentSkillConfig(
        agentId = agentId,
        skillKey = canonicalKey,
        body = AgentSkillUpdateRequest(enabled = enabled),
    ).unwrap()

    public suspend fun setCredential(
        agentId: String,
        canonicalKey: String,
        configJson: JsonObject,
    ): AgentSkillLink = contextApi.updateAgentSkillConfig(
        agentId = agentId,
        skillKey = canonicalKey,
        body = AgentSkillUpdateRequest(configJson = configJson),
    ).unwrap()

    public suspend fun detach(agentId: String, canonicalKey: String): Unit {
        contextApi.removeAgentSkill(agentId = agentId, skillKey = canonicalKey).unwrap()
    }

    /**
     * 连接器市场的只读数据边界。
     *
     * 三个货架按需独立读取；所有 API 响应都会先投影到不含 config、args、命令和
     * 凭据的 [MobileConnectorMarketItem]，页面层不会接触运行时配置。
     */
    public suspend fun loadConnectorShelf(
        organizationId: String,
        source: MobileConnectorMarketSource,
    ): MobileConnectorShelfSnapshot = when (source) {
        MobileConnectorMarketSource.RECOMMENDED -> {
            val manifest = withContext(Dispatchers.IO) {
                appContext.assets.open(CONNECTOR_BRAND_MANIFEST).bufferedReader().use { it.readText() }
            }
            MobileConnectorShelfSnapshot(
                items = MobileConnectorMarketProjector.recommendedFromManifest(manifest),
            )
        }

        MobileConnectorMarketSource.ORGANIZATION -> {
            val connections = contextApi.getOrgMcpConnections(organizationId).unwrap().connections
            MobileConnectorShelfSnapshot(
                items = MobileConnectorMarketProjector.organizationFromConnections(connections),
            )
        }

        MobileConnectorMarketSource.MINE -> {
            val devices = contextApi.getDevices(organizationId).unwrap().devices
            val result = MobileConnectorDeviceLoader.load(devices) { deviceId ->
                contextApi.getDeviceMcpConnections(deviceId).unwrap().connections
            }
            MobileConnectorShelfSnapshot(
                items = MobileConnectorMarketProjector.mineFromDeviceBatches(result.batches),
                failedDeviceCount = result.failedDeviceCount,
                totalDeviceCount = result.totalDeviceCount,
            )
        }
    }

    private companion object {
        const val CONNECTOR_BRAND_MANIFEST = "connector_brand_manifest.json"
    }
}

public data class MobileSkillLibrarySnapshot(
    val catalog: List<VisibleSkillEntry>,
    /** Electron `user_gates`：key 存在即 acquired（进「我的」）。 */
    val userGates: Map<String, Boolean> = emptyMap(),
    val linksByAgent: Map<String, List<AgentSkillLink>>,
    val credentials: List<CredentialListItem>,
)

public data class MobileConnectorShelfSnapshot(
    val items: List<MobileConnectorMarketItem>,
    val failedDeviceCount: Int = 0,
    val totalDeviceCount: Int = 0,
)
