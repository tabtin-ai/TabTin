package com.tabtin.mobile.features.skills

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.CredentialListItem
import com.tabtin.mobile.data.model.MobileConnectorMarketItem
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.model.SkillQuickUsePreset
import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.data.repository.MobileSkillLibraryRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

internal data class MobileSkillLibraryUiState(
    val agents: List<Agent> = emptyList(),
    val skills: List<MobileSkillItem> = emptyList(),
    val credentials: List<CredentialListItem> = emptyList(),
    val connectorShelves: Map<MobileConnectorMarketSource, MobileConnectorShelfState> =
        MobileConnectorMarketSource.entries.associateWith { MobileConnectorShelfState() },
    /** 当前登录用户，供市场「我的」归属判定（对齐 Electron currentUserId）。 */
    val currentUserId: String = "",
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val mutatingSkillKey: String? = null,
    @StringRes val loadErrorRes: Int? = null,
    val errorMessage: String? = null,
)

internal data class MobileConnectorShelfState(
    val items: List<MobileConnectorMarketItem> = emptyList(),
    val hasLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    val errorMessage: String? = null,
    val failedDeviceCount: Int = 0,
    val totalDeviceCount: Int = 0,
)

/** 目录项和所有 AI 分身的携带态的聚合展示模型。 */
internal data class MobileSkillItem(
    val canonicalKey: String,
    val name: String,
    val description: String,
    val emoji: String,
    val source: String,
    val visibility: String,
    val version: String,
    val tags: List<String>,
    val category: String? = null,
    val appId: String? = null,
    val distribution: String? = null,
    val ownerUserId: String? = null,
    val acquired: Boolean = false,
    val requiresCredential: Boolean,
    val quickUse: List<SkillQuickUsePreset>,
    val bindings: List<MobileSkillAgentBinding>,
) {
    val isAttached: Boolean get() = bindings.isNotEmpty()
    val isEnabled: Boolean get() = bindings.any { it.enabled }
    val isLocked: Boolean get() = bindings.isNotEmpty() && bindings.all { it.locked }

    val sourceLabel: String
        get() = when (source) {
            "platform", "app" -> "平台技能"
            "workspace" -> "工作区技能"
            "device" -> "设备技能"
            "user" -> "团队技能"
            else -> "技能"
        }

    fun toMarketFilterInput(): SkillMarketFilterInput = SkillMarketFilterInput(
        source = source,
        visibility = visibility,
        appId = appId,
        distribution = distribution,
        category = category,
        ownerUserId = ownerUserId,
        acquired = acquired,
    )
}

internal data class MobileSkillAgentBinding(
    val agentId: String,
    val agentName: String,
    val enabled: Boolean,
    val locked: Boolean,
    val credentialId: String?,
)

@HiltViewModel
public class MobileSkillLibraryViewModel @Inject constructor(
    private val tokenManager: TokenManager,
    private val spaceRepository: SpaceRepository,
    private val repository: MobileSkillLibraryRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(MobileSkillLibraryUiState())
    internal val uiState: StateFlow<MobileSkillLibraryUiState> = _uiState.asStateFlow()
    private var loadSequence = 0
    private val connectorLoadSequences = MobileConnectorMarketSource.entries.associateWith { 0 }.toMutableMap()
    private var connectorOrganizationId: String? = null
    private var started = false

    /** 同一 back-stack entry 只加载一次；手动刷新仍会重新请求。 */
    public fun start(): Unit {
        if (started) return
        started = true
        load()
    }

    public fun refresh(): Unit = load(isRefresh = true)

    public fun ensureConnectorShelf(source: MobileConnectorMarketSource): Unit {
        prepareConnectorOrganization(tokenManager.organizationId)
        val shelf = _uiState.value.connectorShelves.getValue(source)
        if (!shelf.hasLoaded && !shelf.isLoading) loadConnectorShelf(source)
    }

    public fun refreshConnectorShelf(source: MobileConnectorMarketSource): Unit =
        loadConnectorShelf(source, isRefresh = true)

    internal fun attach(skill: MobileSkillItem, agentId: String) {
        mutate(skill, agentId) { repository.attach(agentId, skill.canonicalKey) }
    }

    internal fun setEnabled(skill: MobileSkillItem, agentId: String, enabled: Boolean) {
        mutate(skill, agentId) { repository.setEnabled(agentId, skill.canonicalKey, enabled) }
    }

    internal fun setCredential(skill: MobileSkillItem, agentId: String, credentialId: String?) {
        val config = JsonObject(mapOf("credential_id" to (credentialId?.let(::JsonPrimitive) ?: JsonNull)))
        mutate(skill, agentId) { repository.setCredential(agentId, skill.canonicalKey, config) }
    }

    internal fun detach(skill: MobileSkillItem, agentId: String) {
        val organizationId = tokenManager.organizationId ?: return
        viewModelScope.safeLaunch(
            onError = { error -> finishMutation(error.message ?: "操作失败，请稍后重试") },
        ) {
            _uiState.update { it.copy(mutatingSkillKey = skill.canonicalKey, errorMessage = null) }
            repository.detach(agentId, skill.canonicalKey)
            _uiState.update { state ->
                state.copy(
                    skills = state.skills.map { item ->
                        if (item.canonicalKey == skill.canonicalKey) item.copy(
                            bindings = item.bindings.filterNot { it.agentId == agentId },
                        ) else item
                    },
                    mutatingSkillKey = null,
                )
            }
            // 保持组织上下文的读取，不让组织刚切换时将过期操作留在 UI 中。
            if (organizationId != tokenManager.organizationId) refresh()
        }
    }

    private fun load(isRefresh: Boolean = false) {
        val sequence = ++loadSequence
        val organizationId = tokenManager.organizationId
        if (organizationId.isNullOrBlank()) {
            _uiState.value = MobileSkillLibraryUiState(
                loadErrorRes = R.string.mobile_skill_library_load_failed,
            )
            return
        }
        viewModelScope.safeLaunch(
            onError = { error ->
                if (sequence != loadSequence) return@safeLaunch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        loadErrorRes = MobileCapabilityMarketErrorPresentation.resourceFor(
                            error,
                            fallback = R.string.mobile_skill_library_load_failed,
                        ),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = !isRefresh && it.skills.isEmpty(),
                    isRefreshing = isRefresh,
                    loadErrorRes = null,
                    errorMessage = null,
                )
            }
            val agents = spaceRepository.getAgents().filter { it.isActive }
            val snapshot = repository.load(organizationId, agents.map { it.id })
            if (sequence != loadSequence) return@safeLaunch
            _uiState.value = _uiState.value.copy(
                agents = agents,
                skills = merge(
                    catalog = snapshot.catalog,
                    userGates = snapshot.userGates,
                    linksByAgent = snapshot.linksByAgent,
                    agents = agents,
                ),
                credentials = snapshot.credentials,
                currentUserId = tokenManager.userId.orEmpty(),
                isLoading = false,
                isRefreshing = false,
                loadErrorRes = null,
            )
        }
    }

    private fun loadConnectorShelf(
        source: MobileConnectorMarketSource,
        isRefresh: Boolean = false,
    ) {
        val organizationId = tokenManager.organizationId
        prepareConnectorOrganization(organizationId)
        if (organizationId.isNullOrBlank()) {
            updateConnectorShelf(source) {
                it.copy(
                    hasLoaded = true,
                    isLoading = false,
                    isRefreshing = false,
                    errorRes = R.string.mobile_connector_load_failed,
                    errorMessage = null,
                )
            }
            return
        }
        val sequence = connectorLoadSequences.getValue(source) + 1
        connectorLoadSequences[source] = sequence
        viewModelScope.safeLaunch(
            onError = { error ->
                if (!isCurrentConnectorRequest(source, sequence, organizationId)) return@safeLaunch
                updateConnectorShelf(source) {
                    it.copy(
                        hasLoaded = true,
                        isLoading = false,
                        isRefreshing = false,
                        errorRes = MobileCapabilityMarketErrorPresentation.resourceFor(
                            error,
                            fallback = R.string.mobile_connector_load_failed,
                        ),
                        errorMessage = null,
                    )
                }
            },
        ) {
            updateConnectorShelf(source) { shelf ->
                shelf.copy(
                    isLoading = !isRefresh && shelf.items.isEmpty(),
                    isRefreshing = isRefresh,
                    errorRes = null,
                    errorMessage = null,
                )
            }
            val snapshot = repository.loadConnectorShelf(organizationId, source)
            if (!isCurrentConnectorRequest(source, sequence, organizationId)) return@safeLaunch
            updateConnectorShelf(source) {
                it.copy(
                    items = snapshot.items,
                    hasLoaded = true,
                    isLoading = false,
                    isRefreshing = false,
                    errorRes = null,
                    errorMessage = null,
                    failedDeviceCount = snapshot.failedDeviceCount,
                    totalDeviceCount = snapshot.totalDeviceCount,
                )
            }
        }
    }

    /** 货架缓存只属于一个组织；切换组织时同时清缓存并让旧请求全部失效。 */
    private fun prepareConnectorOrganization(organizationId: String?) {
        val normalizedId = organizationId?.takeIf { it.isNotBlank() }
        if (connectorOrganizationId == normalizedId) return
        connectorOrganizationId = normalizedId
        MobileConnectorMarketSource.entries.forEach { source ->
            connectorLoadSequences[source] = connectorLoadSequences.getValue(source) + 1
        }
        _uiState.update {
            it.copy(
                connectorShelves = MobileConnectorMarketSource.entries.associateWith {
                    MobileConnectorShelfState()
                },
            )
        }
    }

    private fun isCurrentConnectorRequest(
        source: MobileConnectorMarketSource,
        sequence: Int,
        organizationId: String,
    ): Boolean =
        sequence == connectorLoadSequences[source] &&
            connectorOrganizationId == organizationId &&
            tokenManager.organizationId == organizationId

    private fun updateConnectorShelf(
        source: MobileConnectorMarketSource,
        transform: (MobileConnectorShelfState) -> MobileConnectorShelfState,
    ) {
        _uiState.update { state ->
            val current = state.connectorShelves.getValue(source)
            state.copy(connectorShelves = state.connectorShelves + (source to transform(current)))
        }
    }

    private fun mutate(
        skill: MobileSkillItem,
        agentId: String,
        operation: suspend () -> AgentSkillLink,
    ) {
        viewModelScope.safeLaunch(
            onError = { error -> finishMutation(error.message ?: "操作失败，请稍后重试") },
        ) {
            _uiState.update { it.copy(mutatingSkillKey = skill.canonicalKey, errorMessage = null) }
            val updated = operation()
            val agent = _uiState.value.agents.firstOrNull { it.id == agentId }
            if (agent == null) {
                finishMutation("AI 分身已不可用，请刷新后重试")
                return@safeLaunch
            }
            val binding = updated.toBinding(agent)
            _uiState.update { state ->
                state.copy(
                    skills = state.skills.map { item ->
                        if (item.canonicalKey == skill.canonicalKey) item.copy(
                            bindings = item.bindings.filterNot { it.agentId == agentId } + binding,
                        ) else item
                    },
                    mutatingSkillKey = null,
                )
            }
        }
    }

    private fun finishMutation(message: String) {
        _uiState.update { it.copy(mutatingSkillKey = null, errorMessage = message) }
    }

    private fun merge(
        catalog: List<VisibleSkillEntry>,
        userGates: Map<String, Boolean>,
        linksByAgent: Map<String, List<AgentSkillLink>>,
        agents: List<Agent>,
    ): List<MobileSkillItem> {
        val agentsById = agents.associateBy { it.id }
        val bindingsByKey = linksByAgent.flatMap { (agentId, links) ->
            val agent = agentsById[agentId] ?: return@flatMap emptyList()
            links.map { link -> link.skillCanonicalKey to link.toBinding(agent) }
        }.groupBy({ it.first }, { it.second })
        val uniqueCatalog = catalog
            .filter { it.canonicalKey.isNotBlank() }
            .distinctBy { it.canonicalKey }
        val catalogKeys = uniqueCatalog.map { it.canonicalKey }.toSet()
        val items = uniqueCatalog.map { entry ->
            val key = entry.canonicalKey
            entry.toItem(
                bindings = bindingsByKey[key].orEmpty(),
                acquired = SkillMarketFilters.isAcquired(key, userGates),
            )
        }.toMutableList()
        bindingsByKey.filterKeys { it !in catalogKeys }.forEach { (key, bindings) ->
            val sample = linksByAgent.values.flatten().firstOrNull { it.skillCanonicalKey == key } ?: return@forEach
            items += MobileSkillItem(
                canonicalKey = key,
                name = sample.name.ifBlank { key },
                description = sample.description.orEmpty(),
                emoji = sample.emoji.orEmpty(),
                source = sample.source ?: "user",
                visibility = "",
                version = "",
                tags = emptyList(),
                acquired = SkillMarketFilters.isAcquired(key, userGates),
                requiresCredential = bindings.any { it.credentialId != null },
                quickUse = emptyList(),
                bindings = bindings,
            )
        }
        return items.sortedWith(compareByDescending<MobileSkillItem> { it.isAttached }.thenBy { it.name.lowercase() })
    }
}

internal object MobileCapabilityMarketErrorPresentation {
    @StringRes
    fun resourceFor(error: Exception, @StringRes fallback: Int): Int =
        if (ErrorClassifier.categorize(error) == ErrorClassifier.Category.NETWORK) {
            R.string.error_network
        } else {
            fallback
        }
}

private fun VisibleSkillEntry.toItem(
    bindings: List<MobileSkillAgentBinding>,
    acquired: Boolean,
) = MobileSkillItem(
    canonicalKey = canonicalKey,
    name = resolvedName,
    description = description,
    emoji = emoji.orEmpty(),
    source = source,
    visibility = visibility,
    version = version,
    tags = tags,
    category = category,
    appId = appId,
    distribution = distribution,
    ownerUserId = ownerUserId,
    acquired = acquired,
    requiresCredential = requiresCredential,
    quickUse = quickUse,
    bindings = bindings,
)

private fun AgentSkillLink.toBinding(agent: Agent) = MobileSkillAgentBinding(
    agentId = agent.id,
    agentName = agent.displayName?.takeIf { it.isNotBlank() } ?: agent.name,
    enabled = enabled,
    locked = locked,
    credentialId = configJson?.get("credential_id")?.jsonPrimitive?.contentOrNull,
)
