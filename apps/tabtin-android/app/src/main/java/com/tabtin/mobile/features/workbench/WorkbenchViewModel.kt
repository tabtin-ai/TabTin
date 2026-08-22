package com.tabtin.mobile.features.workbench

import android.content.Context
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.resolveEffectiveWebBaseUrl
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourceType
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.repository.CloudDriveRepository
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SharedResourcesRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException
import javax.inject.Inject

internal data class WorkbenchUiState(
    val resources: List<SpaceResource> = emptyList(),
    val sharedAppHomeResources: Map<String, List<SpaceResource>> = emptyMap(),
    val loadingSharedAppHomeTypes: Set<String> = emptySet(),
    val appHomeCollaborations: Map<String, TaskResourceCollaborationState> = emptyMap(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val selectedTab: WorkbenchTab = WorkbenchTab.RECENT,
    @StringRes val pinErrorRes: Int? = null,
    val agent: Agent? = null,
    val isCreatingDoc: Boolean = false,
    val isCreatingBlank: Boolean = false,
    @StringRes val createDocumentErrorRes: Int? = null,
    val createDocumentQuotaExceeded: AppError.DocumentQuotaExceeded? = null,
    val apps: List<TaskWorkbenchApp> = emptyList(),
    val isAppCatalogLoading: Boolean = false,
    val appCatalogError: String? = null,
) {
    val hasAgentContext: Boolean
        get() {
            val a = agent ?: return false
            return a.goal.isNotBlank() || a.customRules.isNotBlank()
        }
    val pinnedResources: List<SpaceResource>
        get() = resources.filter { it.isPinned == true }

    val recentResources: List<SpaceResource>
        get() = resources.take(MAX_RECENT_RESOURCES)

    val filteredResources: List<SpaceResource>
        get() = when (selectedTab) {
            WorkbenchTab.RECENT -> recentResources
            else -> resources.filter { it.normalizedType == selectedTab.name.lowercase() }
        }

    val availableTabs: List<WorkbenchTab>
        get() {
            val types = resources.map { it.normalizedType }.toSet()
            return buildList {
                add(WorkbenchTab.RECENT)
                if ("tabdata" in types) add(WorkbenchTab.TABDATA)
                if ("tabdoc" in types) add(WorkbenchTab.TABDOC)
                if ("tabslide" in types) add(WorkbenchTab.TABSLIDE)
                if ("tabsite" in types) add(WorkbenchTab.TABSITE)
                if ("tabtracker" in types) add(WorkbenchTab.TABTRACKER)
            }
        }

    val resourceSummaryCounts: List<Pair<String, Int>>
        get() {
            val counts = mutableMapOf<String, Int>()
            for (r in resources) {
                counts[r.normalizedType] = (counts[r.normalizedType] ?: 0) + 1
            }
            return counts.entries.sortedByDescending { it.value }.take(3)
                .map { it.key to it.value }
        }

    public companion object {
        public const val MAX_RECENT_RESOURCES: Int = 20
        public const val MAX_DELEGATION_REFERENCES: Int = 5
    }
}

internal enum class WorkbenchTab(@StringRes public val labelRes: Int, public val icon: String) {
    RECENT(R.string.workbench_tab_recent, "schedule"),
    TABDATA(R.string.workbench_tab_tabdata, "table_chart"),
    TABDOC(R.string.workbench_tab_tabdoc, "article"),
    TABSLIDE(R.string.workbench_tab_tabslide, "slideshow"),
    TABSITE(R.string.workbench_tab_tabsite, "language"),
    TABTRACKER(R.string.workbench_tab_tabtracker, "calendar_today"),
}

public data class WorkbenchResourceOpenRequest(
    val resourceType: String,
    val resourceId: String,
    val title: String? = null,
    val locationHint: String? = null,
) {
    val normalizedType: String get() = SpaceResource.normalizedType(resourceType)

    val unsupportedOpenNotice: String
        get() {
            val hint = locationHint?.takeIf { it.isNotBlank() }
            return buildString {
                append("这个资源类型暂不支持在 Android 内打开，已为你定位到工作台。")
                if (hint != null) {
                    append('\n')
                    append("定位线索：")
                    append(hint)
                }
            }
        }
}

internal data class WorkbenchWebTarget(
    val resourceType: String,
    val resourceId: String,
    val title: String,
) {
    val pathName: String
        get() = when (resourceType) {
            "tabdoc" -> "docs"
            "tabdata" -> "tables"
            "tabslide" -> "slides"
            else -> ""
        }

    val isSupported: Boolean get() = pathName.isNotEmpty()

    companion object {
        fun from(resource: SpaceResource): WorkbenchWebTarget? {
            val normalized = resource.normalizedType
            if (normalized !in SUPPORTED_WEB_TYPES) return null
            return WorkbenchWebTarget(
                resourceType = normalized,
                resourceId = resource.resourceId,
                title = resource.displayTitle,
            )
        }

        fun from(request: WorkbenchResourceOpenRequest, resources: List<SpaceResource>): WorkbenchWebTarget? {
            val normalized = request.normalizedType
            if (normalized !in SUPPORTED_WEB_TYPES) return null
            val matched = resources.firstOrNull { resource ->
                resource.resourceId == request.resourceId ||
                    resource.id == request.resourceId ||
                    (resource.normalizedType == normalized && resource.resourceId == request.resourceId)
            }
            return matched?.let(::from) ?: WorkbenchWebTarget(
                resourceType = normalized,
                resourceId = request.resourceId,
                title = request.title?.takeIf { it.isNotBlank() } ?: defaultTitle(normalized),
            )
        }

        private fun defaultTitle(resourceType: String): String = when (resourceType) {
            "tabdoc" -> "TabDoc"
            "tabdata" -> "TabData"
            "tabslide" -> "TabSlide"
            else -> "Resource"
        }

        private val SUPPORTED_WEB_TYPES = setOf("tabdoc", "tabdata", "tabslide")
    }
}

internal data class WorkbenchWebAuthSnapshot(
    val accessToken: String?,
    val expiresAtSeconds: Long?,
    val userJson: String?,
) {
    fun injectionScript(expectedOrigin: String): String {
        val origin = JSONObject.quote(expectedOrigin)
        return """
            (() => {
              if (window.location.origin !== $origin) return;
              ${storageMutationScript()}
            })();
        """.trimIndent()
    }

    fun bootstrapInjectionScript(): String {
        return """
            (() => {
              ${storageMutationScript()}
              localStorage.removeItem('tabtin-auth-storage');
            })();
        """.trimIndent()
    }

    private fun storageMutationScript(): String {
        val access = accessToken?.let(JSONObject::quote) ?: "null"
        val expires = expiresAtSeconds?.toString() ?: "null"
        val user = userJson ?: "null"
        return """
              const auth = {
                accessToken: $access,
                expiresAt: $expires,
                user: $user
              };
              if (auth.accessToken) localStorage.setItem('tabtin_access_token', auth.accessToken);
              else localStorage.removeItem('tabtin_access_token');
              localStorage.removeItem('tabtin_refresh_token');
              if (auth.expiresAt != null) localStorage.setItem('tabtin_expires_at', String(auth.expiresAt));
              else localStorage.removeItem('tabtin_expires_at');
              if (auth.user) localStorage.setItem('tabtin_user', JSON.stringify(auth.user));
              else localStorage.removeItem('tabtin_user');
              window.__TABTIN_NATIVE_AUTH__ = {
                platform: 'android',
                refresh: async () => {
                  const result = JSON.parse(window.TabTinNativeAuth.refresh());
                  if (result && result.status === 'succeeded') {
                    const accessToken = localStorage.getItem('tabtin_access_token');
                    if (!accessToken) {
                      return {
                        status: 'temporarily_unavailable',
                        message: '登录凭据暂时无法同步'
                      };
                    }
                    const expiresAtRaw = localStorage.getItem('tabtin_expires_at');
                    return {
                      status: 'succeeded',
                      accessToken,
                      expiresAt: expiresAtRaw == null ? null : Number(expiresAtRaw)
                    };
                  } else if (result && result.status === 'unauthenticated') {
                    localStorage.removeItem('tabtin_access_token');
                    localStorage.removeItem('tabtin_expires_at');
                    localStorage.removeItem('tabtin_user');
                  }
                  localStorage.removeItem('tabtin_refresh_token');
                  return result;
                }
              };
        """.trimIndent()
    }
}

@HiltViewModel
public class WorkbenchViewModel @Inject constructor(
    private val repository: SpaceResourceRepository,
    private val spaceRepository: SpaceRepository,
    private val docRepository: DocRepository,
    private val cloudDriveRepository: CloudDriveRepository,
    private val cloudDocsShareService: CloudDocsShareService,
    private val sharedResourcesRepository: SharedResourcesRepository,
    private val contextApi: ContextApi,
    private val organizationRepository: OrganizationRepository,
    internal val embeddedWebAuthCoordinator: EmbeddedWebAuthCoordinator,
    public val streamManager: StreamManager,
    private val tokenManager: TokenManager,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private val _uiState = MutableStateFlow(WorkbenchUiState())
    internal val uiState: StateFlow<WorkbenchUiState> = _uiState.asStateFlow()

    /** 启动时已缓存的 Organization 列表，供 App Home 展示组织名。 */
    internal val organizations: StateFlow<List<Organization>> = organizationRepository.organizations

    private var currentSpaceId: String? = null
    private var currentOrganizationId: String? = null
    private var catalogApps: List<TaskWorkbenchCatalogApp> = emptyList()
    private var workspaceApps: List<TaskWorkbenchWorkspaceApp>? = null
    private val loadedSharedAppHomeKeys: MutableSet<String> = mutableSetOf()

    internal fun loadAppHomeCollaboration(kind: WorkbenchAppHomeKind, resourceId: String) {
        val id = resourceId.trim()
        val type = CloudShareResourceType.fromNormalizedType(kind.appId) ?: return
        if (id.isEmpty()) return
        val key = taskResourceCollaborationKey(kind, id)
        when (_uiState.value.appHomeCollaborations[key]) {
            TaskResourceCollaborationState.Loading,
            is TaskResourceCollaborationState.Loaded,
            -> return
            TaskResourceCollaborationState.Idle,
            TaskResourceCollaborationState.Unavailable,
            null,
            -> Unit
        }
        _uiState.value = _uiState.value.copy(
            appHomeCollaborations = _uiState.value.appHomeCollaborations +
                (key to TaskResourceCollaborationState.Loading),
        )
        viewModelScope.launch {
            try {
                val response = cloudDocsShareService.collaborators(type, id)
                _uiState.value = _uiState.value.copy(
                    appHomeCollaborations = _uiState.value.appHomeCollaborations +
                        (key to TaskResourceCollaborationState.Loaded(
                            TaskResourceCollaborationProjector.project(response),
                        )),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w("WorkbenchViewModel", "加载 App 首页协作者失败: $key", error)
                _uiState.value = _uiState.value.copy(
                    appHomeCollaborations = _uiState.value.appHomeCollaborations +
                        (key to TaskResourceCollaborationState.Unavailable),
                )
            }
        }
    }

    public fun loadResources(spaceId: String, force: Boolean = false) {
        if (!force && currentSpaceId == spaceId && _uiState.value.resources.isNotEmpty()) return
        currentSpaceId = spaceId

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                val resources = repository.getResources(spaceId)
                if (currentSpaceId == spaceId) {
                    _uiState.value = _uiState.value.copy(
                        resources = resources,
                        isLoading = false,
                        apps = projectApps(resources),
                    )
                }
            } catch (e: Exception) {
                if (currentSpaceId == spaceId) {
                    _uiState.value = _uiState.value.copy(isLoading = false, error = e.message)
                }
            }
            try {
                val space = spaceRepository.getSpace(spaceId)
                val agentId = space.executionAgentId ?: space.agentId
                val agent = agentId?.let { spaceRepository.getAgent(it) }
                    ?: spaceRepository.getAgents().firstOrNull()
                _uiState.value = _uiState.value.copy(agent = agent)
            } catch (_: Exception) { }
        }
    }


    public fun loadApps(organizationId: String, workspaceId: String?) {
        val orgId = organizationId.trim().takeIf { it.isNotEmpty() } ?: return
        currentOrganizationId = orgId
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isAppCatalogLoading = _uiState.value.apps.isEmpty(),
                appCatalogError = null,
            )
            try {
                coroutineScope {
                    val catalogDeferred = async { contextApi.getOrganizationAppCatalog(orgId).unwrap() }
                    val workspaceDeferred = async {
                        val spaceId = workspaceId?.trim()?.takeIf { it.isNotEmpty() }
                        if (spaceId == null) null
                        else runCatching { contextApi.getWorkspaceApps(spaceId).unwrap() }.getOrNull()
                    }
                    val catalog = catalogDeferred.await()
                    val workspace = workspaceDeferred.await()
                    if (currentOrganizationId != orgId) return@coroutineScope
                    catalogApps = catalog.apps
                    workspaceApps = workspace?.apps
                    _uiState.value = _uiState.value.copy(
                        apps = projectApps(_uiState.value.resources),
                        isAppCatalogLoading = false,
                        appCatalogError = if (workspace == null && workspaceId != null) {
                            "应用状态暂不可确认"
                        } else {
                            null
                        },
                    )
                }
            } catch (e: Exception) {
                if (currentOrganizationId == orgId) {
                    _uiState.value = _uiState.value.copy(
                        isAppCatalogLoading = false,
                        appCatalogError = e.message,
                    )
                }
            }
        }
    }

    private fun projectApps(resources: List<SpaceResource>): List<TaskWorkbenchApp> {
        if (catalogApps.isEmpty()) return emptyList()
        return TaskWorkbenchAppProjector.project(
            catalog = catalogApps,
            workspaceApps = workspaceApps,
            resources = resources,
        )
    }

    /**
     * 任务 App 首页的「资料库 / 共享」入口必须看组织级 cloud-drive shared-feed。
     *
     * 只靠当前 workspace 的 [resources] 会漏掉别人分享给我的资源；这时消息里解析出的
     * tabtin://resource 也匹配不到 SpaceResource，工作台卡片就会退成「当前内容不可用」。
     * 新版优先 shared-feed；滚动发布环境 404 时才回退旧 doc/table shared-with-me。
     */
    public fun loadSharedAppHomeResources(
        kind: WorkbenchAppHomeKind,
        organizationId: String,
        force: Boolean = false,
    ) {
        if (kind != WorkbenchAppHomeKind.TABDOC && kind != WorkbenchAppHomeKind.TABDATA) return
        val orgId = organizationId.trim().takeIf { it.isNotEmpty() } ?: return
        val type = kind.appId
        val key = "$orgId:$type"
        if (!force && key in loadedSharedAppHomeKeys) return
        if (type in _uiState.value.loadingSharedAppHomeTypes) return

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                loadingSharedAppHomeTypes = _uiState.value.loadingSharedAppHomeTypes + type,
            )
            try {
                val shared = try {
                    cloudDriveRepository.listSharedFeedPage(
                        organizationId = orgId,
                        typeFilter = when (kind) {
                            WorkbenchAppHomeKind.TABDOC -> CloudDriveTypeFilter.TABDOC
                            WorkbenchAppHomeKind.TABDATA -> CloudDriveTypeFilter.TABDATA
                        },
                        limit = 12,
                    ).resources.map { it.toSpaceResource() }
                } catch (error: HttpException) {
                    if (error.code() != 404) throw error
                    sharedResourcesRepository.listSharedWithMe(orgId)
                        .filter { item ->
                            when (kind) {
                                WorkbenchAppHomeKind.TABDOC -> item.resourceType == SharedResourceType.DOC
                                WorkbenchAppHomeKind.TABDATA -> item.resourceType == SharedResourceType.TABLE
                            }
                        }
                        .map { it.toSpaceResource() }
                }
                loadedSharedAppHomeKeys += key
                _uiState.value = _uiState.value.copy(
                    sharedAppHomeResources = _uiState.value.sharedAppHomeResources + (type to shared),
                    loadingSharedAppHomeTypes = _uiState.value.loadingSharedAppHomeTypes - type,
                    apps = projectApps(_uiState.value.resources + shared),
                )
            } catch (error: Exception) {
                _uiState.value = _uiState.value.copy(
                    loadingSharedAppHomeTypes = _uiState.value.loadingSharedAppHomeTypes - type,
                )
                Log.w(TAG, "load shared app home resources failed type=$type", error)
            }
        }
    }

    public fun createDocument(spaceId: String, onCreated: (String) -> Unit) {
        if (_uiState.value.isCreatingDoc || _uiState.value.isCreatingBlank) return
        viewModelScope.safeLaunch(
            onError = { error ->
                Log.w(TAG, "create workbench document failed", error)
                val quotaExceeded = error as? AppError.DocumentQuotaExceeded
                _uiState.value = _uiState.value.copy(
                    createDocumentErrorRes = if (quotaExceeded == null) R.string.doc_error_create_failed else null,
                    createDocumentQuotaExceeded = quotaExceeded,
                )
            },
        ) {
            _uiState.value = _uiState.value.copy(
                isCreatingDoc = true,
                isCreatingBlank = true,
                createDocumentErrorRes = null,
                createDocumentQuotaExceeded = null,
            )
            try {
                val detail = docRepository.createDocument(title = "")
                onCreated(detail.document.id)
                currentSpaceId?.let { loadResources(it, force = true) }
            } finally {
                _uiState.value = _uiState.value.copy(isCreatingDoc = false, isCreatingBlank = false)
            }
        }
    }

    /**
     * App Home「空白文档 / 空白多维表」。对齐 iOS `createBlankTaskResource`。
     * [onCreated] 收到 (resourceType, resourceId, title)。
     */
    public fun createBlankTaskResource(
        kind: WorkbenchAppHomeKind,
        organizationId: String,
        onCreated: (resourceType: String, resourceId: String, title: String) -> Unit,
    ) {
        if (_uiState.value.isCreatingBlank || _uiState.value.isCreatingDoc) return
        val orgId = organizationId.trim().takeIf { it.isNotEmpty() } ?: return
        viewModelScope.safeLaunch(
            onError = { error ->
                Log.w(TAG, "create blank task resource failed kind=${kind.appId}", error)
                val quotaExceeded = error as? AppError.DocumentQuotaExceeded
                _uiState.value = _uiState.value.copy(
                    createDocumentErrorRes = if (quotaExceeded == null) {
                        when (kind) {
                            WorkbenchAppHomeKind.TABDATA -> R.string.workbench_tabdata_create_failed
                            else -> R.string.doc_error_create_failed
                        }
                    } else {
                        null
                    },
                    createDocumentQuotaExceeded = quotaExceeded,
                )
            },
        ) {
            _uiState.value = _uiState.value.copy(
                isCreatingBlank = true,
                isCreatingDoc = kind == WorkbenchAppHomeKind.TABDOC,
                createDocumentErrorRes = null,
                createDocumentQuotaExceeded = null,
            )
            try {
                when (kind) {
                    WorkbenchAppHomeKind.TABDOC -> {
                        val detail = cloudDriveRepository.createDocument(
                            organizationId = orgId,
                            title = "",
                            collectionId = null,
                        )
                        onCreated("tabdoc", detail.document.id, detail.document.title.ifBlank { "文档" })
                    }
                    WorkbenchAppHomeKind.TABDATA -> {
                        val defaultName = context.getString(R.string.cloud_drive_untitled_table)
                        val created = cloudDriveRepository.createTable(
                            organizationId = orgId,
                            name = defaultName,
                            collectionId = null,
                        )
                        onCreated("tabdata", created.id, created.name.ifBlank { defaultName })
                    }
                    else -> return@safeLaunch
                }
                currentSpaceId?.let { loadResources(it, force = true) }
            } finally {
                _uiState.value = _uiState.value.copy(isCreatingBlank = false, isCreatingDoc = false)
            }
        }
    }

    public fun consumeCreateDocumentError() {
        _uiState.value = _uiState.value.copy(createDocumentErrorRes = null)
    }

    public fun dismissCreateDocumentQuotaExceeded() {
        _uiState.value = _uiState.value.copy(createDocumentQuotaExceeded = null)
    }

    internal fun selectTab(tab: WorkbenchTab) {
        _uiState.value = _uiState.value.copy(selectedTab = tab)
    }

    public fun togglePin(resource: SpaceResource) {
        val newPinned = resource.isPinned != true
        viewModelScope.launch {
            try {
                repository.togglePin(resource.id, newPinned)
                _uiState.value = _uiState.value.copy(
                    resources = _uiState.value.resources.map {
                        if (it.id == resource.id) it.copy(isPinned = newPinned) else it
                    },
                    pinErrorRes = null,
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    pinErrorRes = if (newPinned) R.string.workbench_pin_error else R.string.workbench_unpin_error,
                )
            }
        }
    }

    public fun dismissPinError() {
        _uiState.value = _uiState.value.copy(pinErrorRes = null)
    }

    internal val webBaseUrl: String
        get() = resolveEffectiveWebBaseUrl(tokenManager)

    private companion object {
        const val TAG = "WorkbenchViewModel"
    }
}

private fun CloudDriveResourceRow.toSpaceResource(): SpaceResource = SpaceResource(
    id = contextItemId,
    itemType = itemType,
    title = title,
    preview = preview,
    resourceId = resourceId,
    spaceId = spaceId,
    organizationId = organizationId,
    spaceName = spaceName,
    metadata = metadata,
    isPinned = isPinned,
    updatedAt = updatedAt,
    lastVisitedAt = lastVisitedAt,
    collectionId = collectionId,
    owner = owner,
    canView = canView,
    canEdit = canEdit,
    canMove = canMove,
    canShare = canShare,
    canTrash = canTrash,
    canDelete = canDelete,
)

private fun SharedResourceItem.toSpaceResource(): SpaceResource = SpaceResource(
    id = id,
    itemType = when (resourceType) {
        SharedResourceType.DOC -> "tabdoc"
        SharedResourceType.TABLE -> "tabdata"
    },
    title = title,
    preview = null,
    resourceId = resourceId,
    spaceId = spaceId,
    organizationId = organizationId,
    updatedAt = updatedAt,
    canView = true,
)
