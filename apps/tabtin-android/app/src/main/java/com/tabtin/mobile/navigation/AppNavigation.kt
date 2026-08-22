package com.tabtin.mobile.navigation

import android.util.Log
import com.tabtin.mobile.R
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.tabtin.mobile.data.api.AuthEventBus
import com.tabtin.mobile.data.im.ImConversationDataPlane
import com.tabtin.mobile.data.repository.OrganizationRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import com.tabtin.mobile.features.capabilities.CapabilitiesViewModel
import com.tabtin.mobile.features.capabilities.DeviceCapabilitiesScreen
import com.tabtin.mobile.features.conversation.ChatSessionRoute
import com.tabtin.mobile.features.conversation.ChatSessionScreen
import com.tabtin.mobile.features.conversation.ConversationViewModel
import com.tabtin.mobile.features.conversation.AllConversationsViewModel
import com.tabtin.mobile.features.conversation.ArchivedConversationsScreen
import com.tabtin.mobile.features.tabchat.ImConversationRoute
import com.tabtin.mobile.features.tabchat.ImConversationSettingsDestination
import com.tabtin.mobile.features.tabchat.ImConversationSettingsRoute
import com.tabtin.mobile.features.tabchat.ImConversationScreen
import com.tabtin.mobile.features.tabchat.ImConversationViewModel
import com.tabtin.mobile.features.tabchat.SharedSessionRoute
import com.tabtin.mobile.features.tabchat.SharedSessionScreen
import com.tabtin.mobile.features.tabchat.ContactsSection
import com.tabtin.mobile.features.doc.DocEditorScreen
import com.tabtin.mobile.features.doc.DocEditorViewModel
import com.tabtin.mobile.features.doc.DocListScreen
import com.tabtin.mobile.features.doc.DocListViewModel
import com.tabtin.mobile.features.tabdata.NativeTabDataScreen
import com.tabtin.mobile.features.main.MainScreen
import com.tabtin.mobile.features.main.AccountDrawerHost
import com.tabtin.mobile.features.main.MainComposeSheet
import com.tabtin.mobile.features.skills.MobileSkillLibraryScreen
import com.tabtin.mobile.features.skills.MobileSkillMarketTab
import com.tabtin.mobile.features.skills.MobileSkillDetailScreen
import com.tabtin.mobile.features.skills.MobileSkillQuickUseScreen
import com.tabtin.mobile.features.tracker.TrackerDetailScreen
import com.tabtin.mobile.features.tracker.TrackerDetailViewModel
import com.tabtin.mobile.features.tracker.TrackerListViewModel
import com.tabtin.mobile.features.tracker.TrackerScreen
import com.tabtin.mobile.features.tracker.MobileAutomationScreen
import com.tabtin.mobile.features.space.MemorySettingsScreen
import com.tabtin.mobile.features.space.MemorySettingsViewModel
import com.tabtin.mobile.features.space.SkillsManagementScreen
import com.tabtin.mobile.features.space.SkillsManagementViewModel
import com.tabtin.mobile.features.space.ExecutionLimitsScreen
import com.tabtin.mobile.features.space.ExecutionLimitsViewModel
import com.tabtin.mobile.features.space.AgentDetailScreen
import com.tabtin.mobile.features.space.AgentDetailViewModel
import com.tabtin.mobile.features.space.MyAgentsViewModel
import com.tabtin.mobile.features.space.AgentListViewModel
import com.tabtin.mobile.features.space.SpaceSecurityScreen
import com.tabtin.mobile.features.space.SpaceSecurityViewModel
import com.tabtin.mobile.features.profile.NotificationSettingsScreen
import com.tabtin.mobile.features.profile.SettingsAccountScreen
import com.tabtin.mobile.features.profile.ChangePasswordScreen
import com.tabtin.mobile.features.profile.SettingsAppearanceScreen
import com.tabtin.mobile.features.profile.SettingsDebugEnvironmentScreen
import com.tabtin.mobile.features.profile.SettingsDiagnosticsScreen
import com.tabtin.mobile.features.profile.SettingsDeviceInfoScreen
import com.tabtin.mobile.features.profile.SettingsHomeScreen
import com.tabtin.mobile.features.profile.SettingsOrganizationSummaryScreen
import com.tabtin.mobile.features.profile.SettingsPrivacyScreen
import com.tabtin.mobile.features.profile.VerificationScreen
import com.tabtin.mobile.features.profile.VerificationViewModel
import com.tabtin.mobile.features.profile.VoiceSettingsScreen
import com.tabtin.mobile.features.profile.VoiceSettingsViewModel
import com.tabtin.mobile.features.notification.NotificationCenterScreen
import com.tabtin.mobile.features.notification.NotificationOpenRequest
import com.tabtin.mobile.features.main.MainTabDestination
import com.tabtin.mobile.data.model.MobileNotificationTarget
import com.tabtin.mobile.data.model.conversationTitle
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.CloudDocsPendingOpen
import com.tabtin.mobile.features.clouddocs.CloudDocsPendingOpenResolver
import com.tabtin.mobile.features.clouddocs.CloudFileInfo
import com.tabtin.mobile.features.clouddocs.CloudFileInfoScreen
import com.tabtin.mobile.features.memo.MemoDetailScreen
import com.tabtin.mobile.features.memo.TabMemoViewModel
import com.tabtin.mobile.features.space.ArchivedSessionsScreen
import com.tabtin.mobile.features.space.ArchivedSessionsViewModel
import com.tabtin.mobile.features.space.SpaceSettingsScreen
import com.tabtin.mobile.features.space.SpaceSettingsViewModel
import com.tabtin.mobile.features.space.TrashBinScreen
import com.tabtin.mobile.features.space.TrashBinViewModel
import com.tabtin.mobile.features.space.SubAgentListScreen
import com.tabtin.mobile.features.space.SubAgentListViewModel
import com.tabtin.mobile.features.auth.LoginScreen
import com.tabtin.mobile.features.auth.LoginViewModel
import com.tabtin.mobile.features.auth.InviteCodeGateDialog
import com.tabtin.mobile.features.profile.AboutScreen
import com.tabtin.mobile.features.profile.MeScreen
import com.tabtin.mobile.features.profile.OrganizationInvitationsScreen
import com.tabtin.mobile.features.profile.ProfileEditScreen
import com.tabtin.mobile.features.tabsite.TabSitePreviewScreen
import com.tabtin.mobile.features.tabsite.TabSitePreviewViewModel
import com.tabtin.mobile.features.tabslide.TabSlideViewerScreen
import com.tabtin.mobile.features.tabslide.TabSlideViewerViewModel
import com.tabtin.mobile.features.workspace.AcceptInvitationScreen
import com.tabtin.mobile.features.workspace.AcceptInvitationViewModel
import com.tabtin.mobile.features.workspace.UsageScreen
import com.tabtin.mobile.features.workspace.UsageViewModel
import com.tabtin.mobile.features.workspace.WalletScreen
import com.tabtin.mobile.features.workspace.WalletViewModel
import com.tabtin.mobile.features.workspace.OrganizationSettingsScreen
import com.tabtin.mobile.features.workspace.OrganizationSettingsViewModel
import com.tabtin.mobile.features.workbench.WorkbenchAppHomeKind
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchOpenDestination
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.features.workbench.WorkbenchRouteResolver
import com.tabtin.mobile.features.workbench.WorkbenchSheet
import com.tabtin.mobile.features.workbench.AuthenticatedWorkbenchWebScreen
import com.tabtin.mobile.features.workbench.WorkbenchViewModel
import com.tabtin.mobile.features.workbench.WorkbenchWebTarget
import com.tabtin.mobile.features.version.ForceUpdateDialog
import com.tabtin.mobile.features.version.SoftUpdateDialog
import com.tabtin.mobile.features.version.VersionGateViewModel
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.Serializable

// W_DT.2 Compose Navigation 2.8+ Type-Safe Routes（与 iOS Y_DT.2 等价）

@Serializable public data object LoginRoute
@Serializable public data object MainRoute
@Serializable public data object DeviceCapabilitiesRoute
@Serializable public data object AboutRoute
@Serializable public data object MeRoute
@Serializable public data object ProfileEditRoute
@Serializable public data object SettingsRoute
@Serializable public data object SettingsAccountRoute
@Serializable public data object SettingsChangePasswordRoute
@Serializable public data object SettingsAppearanceRoute
@Serializable public data object SettingsPrivacyRoute
@Serializable public data object SettingsDeviceInfoRoute
@Serializable public data object SettingsDebugEnvironmentRoute
@Serializable public data object SettingsDiagnosticsRoute
@Serializable public data class SettingsOrganizationSummaryRoute(val organizationId: String)
@Serializable public data object NotificationSettingsRoute
@Serializable public data object NotificationCenterRoute
@Serializable public data object OrganizationInvitationsRoute
@Serializable public data class VerificationRoute(val target: String = "")
@Serializable public data object VoiceSettingsRoute
@Serializable public data class ContactsRoute(val organizationId: String)
@Serializable public data class AgentDetailRoute(val agentId: String)

@Serializable public data class DocListRoute(val spaceId: String)
@Serializable public data class DocEditorRoute(
    val documentId: String,
    val organizationId: String,
)
@Serializable public data class WorkspaceSettingsRoute(
    val organizationId: String,
    val initialSection: String? = null,
)
@Serializable public data class WalletRoute(val organizationId: String)
@Serializable public data class UsageRoute(val organizationId: String)
@Serializable public data class AcceptInvitationRoute(val token: String)
@Serializable public data class SpaceSettingsRoute(val spaceId: String)
@Serializable public data class SpaceSecurityRoute(val spaceId: String)
@Serializable public data class MemorySettingsRoute(val spaceId: String)
@Serializable public data class SkillsManagementRoute(val spaceId: String)
@Serializable public data class MobileSkillLibraryRoute(
    val initialAgentId: String? = null,
    /** `skills` | `connectors`；缺省技能分段。 */
    val initialMarketTab: String = "skills",
)
@Serializable public data class MobileSkillDetailRoute(
    val skillKey: String,
    val initialAgentId: String? = null,
)
@Serializable public data class MobileSkillQuickUseRoute(
    val skillKey: String,
    val presetId: String,
    val agentId: String,
)
@Serializable public data class MobileSkillTaskComposerRoute(
    val prompt: String,
    val agentId: String,
)
@Serializable public data object MobileAutomationRoute
@Serializable public data object ArchivedConversationsRoute
@Serializable public data class SubAgentListRoute(val spaceId: String)
@Serializable public data class ArchivedSessionsRoute(val spaceId: String)
@Serializable public data class TrashBinRoute(val organizationId: String)
@Serializable public data class ExecutionLimitsRoute(val spaceId: String)
@Serializable public data class TrackerListRoute(
    val spaceId: String,
    val sessionId: String = "",
)
@Serializable public data class TrackerDetailRoute(val trackerId: String)

@Serializable public data class TabSitePreviewRoute(
    val siteId: String,
    val siteName: String,
    val siteUrl: String,
    val siteStatus: String,
)

@Serializable public data class TabSlideViewerRoute(
    val slideId: String,
    val slideName: String,
)

internal sealed interface CloudResourceDestination

/**
 * TabDoc 的移动原生工作面。组织 / Space / 标题随资源一起进入路由，既保留来源上下文，
 * 也让编辑器能显式回到同一份资源的 Web 完整编辑器。
 */
@Serializable
internal data class NativeCloudResourceRoute(
    val resourceType: String,
    val resourceId: String,
    val organizationId: String,
    val spaceId: String? = null,
    val title: String,
) : CloudResourceDestination

internal fun nativeCloudResourceRoute(
    resourceType: String,
    resourceId: String,
    organizationId: String,
    spaceId: String?,
    title: String,
): NativeCloudResourceRoute? {
    val normalized = SpaceResource.normalizedType(resourceType)
    if (normalized !in setOf("tabdoc", "tabdata") || resourceId.isBlank()) return null
    return NativeCloudResourceRoute(
        resourceType = normalized,
        resourceId = resourceId,
        organizationId = organizationId,
        spaceId = spaceId,
        title = title,
    )
}

@Serializable
internal data class CloudWebResourceRoute(
    val organizationId: String,
    val spaceId: String? = null,
    val resourceType: String,
    val resourceId: String,
    val title: String,
) : CloudResourceDestination

@Serializable
internal data class CloudMemoRoute(
    val memoId: String,
) : CloudResourceDestination

@Serializable
internal data class CloudFileRoute(
    /** ContextItemID — 签名下载 / 访问上报。 */
    val contextItemId: String,
    val organizationId: String,
    /** FileRecordID（TabFiles resource_id）。 */
    val resourceId: String,
    val spaceId: String? = null,
    val spaceName: String?,
    val fileName: String,
    val preview: String?,
    val mimeType: String?,
    val typeLabel: String,
    val fileSizeBytes: Long?,
    /** 不再信任；保留字段仅为兼容旧导航序列化。 */
    val fileUrl: String? = null,
    val canShare: Boolean = false,
    val canTrash: Boolean = false,
) : CloudResourceDestination

internal data class CloudSiteDestination(
    val route: TabSitePreviewRoute,
) : CloudResourceDestination

/**
 * Cloud Tab / 通知打开 Memo（及空 id 的 Files App Home）时走 Workbench App Home 链
 *（详情 → App 首页 → 工作台），与 [WorkbenchRouteResolver] 同口径。
 *
 * 带 resourceId 的 tabfiles 仍走 [CloudFileRoute]（签名 URL 详情），不进入 App Home。
 */
internal data class CloudWorkbenchOpenDestination(
    val organizationId: String,
    val spaceId: String?,
    val request: WorkbenchResourceOpenRequest,
) : CloudResourceDestination

@Suppress("UNUSED_PARAMETER")
internal fun resolveCloudResourceDestination(
    organizationId: String,
    resource: SpaceResource,
    spaceName: String?,
): CloudResourceDestination? {
    nativeCloudResourceRoute(
        resourceType = resource.normalizedType,
        resourceId = resource.resourceId,
        organizationId = organizationId,
        spaceId = resource.spaceId,
        title = resource.displayTitle,
    )?.let { return it }

    val webTarget = WorkbenchWebTarget.from(resource)
    if (webTarget != null) {
        return CloudWebResourceRoute(
            organizationId = organizationId,
            spaceId = resource.spaceId,
            resourceType = webTarget.resourceType,
            resourceId = webTarget.resourceId,
            title = webTarget.title,
        )
    }

    // tabfiles + 非空 resourceId：保留 CloudFileRoute，详情升级为签名 URL。
    if (resource.normalizedType == "tabfiles" && resource.resourceId.isNotBlank()) {
        return CloudFileRoute(
            contextItemId = resource.contextItemId,
            organizationId = organizationId,
            resourceId = resource.resourceId,
            spaceId = resource.spaceId,
            spaceName = spaceName,
            fileName = resource.fileName,
            preview = resource.preview,
            mimeType = resource.mimeType,
            typeLabel = resource.typeLabel,
            fileSizeBytes = resource.fileSizeBytes,
            fileUrl = null,
            canShare = resource.canShare != false,
            canTrash = resource.canTrash != false,
        )
    }

    when (
        val workbench = WorkbenchRouteResolver.resolve(
            resourceType = resource.normalizedType,
            resourceId = resource.resourceId,
            title = resource.displayTitle,
        )
    ) {
        is WorkbenchOpenDestination.AppHome -> {
            if (workbench.kind == WorkbenchAppHomeKind.TABMEMO ||
                workbench.kind == WorkbenchAppHomeKind.TABFILES
            ) {
                return CloudWorkbenchOpenDestination(
                    organizationId = organizationId,
                    spaceId = resource.spaceId,
                    request = WorkbenchResourceOpenRequest(
                        resourceType = workbench.kind.appId,
                        resourceId = resource.resourceId,
                        title = resource.displayTitle,
                    ),
                )
            }
        }
        is WorkbenchOpenDestination.WorkbenchDetail -> {
            // Memo 有资源：Workbench App Home → detail；tabfiles 有资源已在上方走 CloudFileRoute。
            if (WorkbenchAppHomeKind.fromAppId(workbench.request.normalizedType) ==
                WorkbenchAppHomeKind.TABMEMO
            ) {
                return CloudWorkbenchOpenDestination(
                    organizationId = organizationId,
                    spaceId = resource.spaceId,
                    request = workbench.request,
                )
            }
        }
        is WorkbenchOpenDestination.CloudDocs,
        is WorkbenchOpenDestination.Unsupported -> Unit
    }

    return when (resource.normalizedType) {
        "tabsite" -> CloudSiteDestination(
            TabSitePreviewRoute(
                siteId = resource.resourceId,
                siteName = resource.displayTitle,
                siteUrl = resource.siteUrl.orEmpty(),
                siteStatus = (resource.metadata?.get("status") as? JsonPrimitive)?.content ?: "published",
            ),
        )
        else -> null
    }
}

private const val NAV_LOG_TAG = "AppNavigation"

/** 判定「栈真的空了」前的观察窗口，用来滤掉导航过渡期的瞬时空栈。 */
private const val NAV_STACK_EMPTY_CONFIRM_MS = 300L

/** 旧资源导航壳仍把宿主参数叫 spaceId；只在这里适配，通知领域不再解释该旧概念。 */
private val MobileNotificationTarget.AppResource.legacyResourceHostId: String?
    get() = projectId ?: workspaceId ?: legacyHostId

private val MobileNotificationTarget.SharedResource.legacyResourceHostId: String?
    get() = projectId ?: workspaceId ?: legacyHostId

@HiltViewModel
internal class AppNavigationViewModel @Inject constructor(
    private val organizationRepository: OrganizationRepository,
    private val imConversationDataPlane: ImConversationDataPlane,
) : ViewModel() {
    val organizationAccessRevokedNotice = organizationRepository.organizationAccessRevokedNotice

    fun dismissOrganizationAccessRevokedNotice() {
        organizationRepository.clearOrganizationAccessRevokedNotice()
    }

    fun switchToDefaultOrganization() {
        viewModelScope.launch {
            if (organizationRepository.selectDefaultOrganization()) {
                organizationRepository.clearOrganizationAccessRevokedNotice()
            }
        }
    }

    fun isOrganizationSelected(organizationId: String): Boolean =
        organizationRepository.selectedOrganization.value?.id == organizationId

    suspend fun selectNotificationOrganization(organizationId: String): Boolean {
        if (organizationId.isBlank()) {
            return true
        }
        organizationRepository.loadOrganizations()
        if (runCatching { organizationRepository.error.value }.getOrNull() != null) return false
        if (organizationRepository.selectedOrganization.value?.id == organizationId) return true
        val organization = organizationRepository.organizations.value.firstOrNull { it.id == organizationId }
            ?: run {
                runCatching { organizationRepository.notifyOrganizationAccessRevoked(organizationId) }
                return false
            }
        organizationRepository.selectOrganization(organization)
        return organizationRepository.selectedOrganization.value?.id == organizationId
    }

    /**
     * IM 推送携带的是发送方视角的组织提示。外部联系人双方可能归属不同组织，必须用
     * conversationId 在接收方可见目录中解析真实组织，不能直接切到推送提示组织。
     */
    suspend fun selectImNotificationOrganization(
        conversationId: String,
        hintedOrganizationId: String,
    ): Boolean {
        if (conversationId.isBlank()) return false

        organizationRepository.loadOrganizations()
        if (organizationRepository.error.value != null) return false

        val organizations = organizationRepository.organizations.value
        val availableById = organizations.associateBy { it.id }
        val candidateIds = buildList {
            organizationRepository.selectedOrganization.value?.id?.let(::add)
            hintedOrganizationId.takeIf { it.isNotBlank() }?.let(::add)
            addAll(organizations.map { it.id })
        }.filter { it in availableById }.distinct()

        val resolvedOrganizationId = try {
            candidateIds.firstOrNull { organizationId ->
                imConversationDataPlane.listConversations(organizationId)
                    .any { it.id == conversationId }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return false
        } ?: return false

        if (organizationRepository.selectedOrganization.value?.id == resolvedOrganizationId) return true
        val organization = availableById[resolvedOrganizationId] ?: return false
        organizationRepository.selectOrganization(organization)
        return organizationRepository.selectedOrganization.value?.id == resolvedOrganizationId
    }
}

/**
 * 新建会话直进草稿：push 空 sessionId + startsNewSession 的 [ChatSessionRoute]。
 *
 * 任务首页 / 会话顶栏「新对话」等入口走此助手；正式会话仍用既有
 * `ChatSessionRoute(sessionId=...)`（startsNewSession 默认 false）。
 */
public fun NavController.navigateToDraftSession(
    spaceId: String,
    spaceName: String,
    organizationId: String,
    agentId: String? = null,
) {
    navigateOnce(
        ChatSessionRoute(
            sessionId = "",
            spaceId = spaceId,
            spaceName = spaceName,
            organizationId = organizationId,
            startsNewSession = true,
            agentId = agentId.orEmpty(),
        ),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AppNavigation(deepLinkHandler: DeepLinkHandler) {
    val navController = rememberNavController()
    val navigationVm: AppNavigationViewModel = hiltViewModel()
    val authVm: LoginViewModel = hiltViewModel()
    val isLoggedIn by authVm.isLoggedIn.collectAsState()
    val isRestoringSession by authVm.isRestoringSession.collectAsState()
    val needsInviteCode by authVm.needsInviteCode.collectAsState()
    val authUiState by authVm.uiState.collectAsState()
    val versionGateVm: VersionGateViewModel = hiltViewModel()
    val versionDecision by versionGateVm.decision.collectAsState()
    val isVersionDecisionLive by versionGateVm.isDecisionLive.collectAsState()
    val dismissedSoftBuild by versionGateVm.dismissedSoftBuild.collectAsState()
    var rootWorkbenchRequest by remember { mutableStateOf<WorkbenchResourceOpenRequest?>(null) }
    var rootWorkbenchSpaceId by remember { mutableStateOf<String?>(null) }
    var rootWorkbenchOrganizationId by remember { mutableStateOf<String?>(null) }
    var requestedMainTab by remember { mutableStateOf<MainTabDestination?>(null) }
    var requestedRecentSection by remember { mutableStateOf<Int?>(null) }
    var pendingCloudDocsOpen by remember { mutableStateOf<CloudDocsPendingOpen?>(null) }
    val organizationAccessRevokedNotice by navigationVm.organizationAccessRevokedNotice.collectAsState()
    val navigationScope = rememberCoroutineScope()

    fun navigateCloudRoute(route: Any, guaranteedDelivery: Boolean) {
        if (guaranteedDelivery) {
            // pending-open / create 完成事件来自 LaunchedEffect。此时上一个 Tab 的导航过渡
            // 可能尚未 RESUMED，不能用 navigateOnce 的用户点击闸门，否则事件会永久丢失。
            navController.navigate(route)
        } else {
            navController.navigateOnce(route)
        }
    }

    fun openCloudResource(
        organizationId: String,
        resource: SpaceResource,
        spaceName: String?,
        guaranteedDelivery: Boolean,
    ) {
        if (!navigationVm.isOrganizationSelected(organizationId)) {
            navigationScope.launch {
                if (navigationVm.selectNotificationOrganization(organizationId)) {
                    openCloudResource(organizationId, resource, spaceName, guaranteedDelivery)
                }
            }
            return
        }
        when (
            val destination = resolveCloudResourceDestination(
                organizationId = organizationId,
                resource = resource,
                spaceName = spaceName,
            )
        ) {
            is NativeCloudResourceRoute -> navigateCloudRoute(destination, guaranteedDelivery)
            is CloudWebResourceRoute -> navigateCloudRoute(destination, guaranteedDelivery)
            is CloudWorkbenchOpenDestination -> {
                rootWorkbenchRequest = destination.request
                rootWorkbenchSpaceId = destination.spaceId
                rootWorkbenchOrganizationId = destination.organizationId
            }
            is CloudSiteDestination -> navigateCloudRoute(destination.route, guaranteedDelivery)
            is CloudMemoRoute -> navigateCloudRoute(destination, guaranteedDelivery)
            is CloudFileRoute -> navigateCloudRoute(destination, guaranteedDelivery)
            null -> {
                android.widget.Toast.makeText(
                    navController.context,
                    navController.context.getString(R.string.resource_deep_link_unsupported_type),
                    android.widget.Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    // 版本门禁弹窗：作为窗口级 overlay 置于最上层，且在 restoring / 未登录时也生效。
    // force 不可关闭，且仅在实时决策下触发（缓存 force 不拦，避免离线/停用时变砖）；soft 可「稍后」。
    versionDecision?.let { decision ->
        when {
            decision.isForce && isVersionDecisionLive -> ForceUpdateDialog(decision = decision)
            decision.isSoft && decision.latestBuild > dismissedSoftBuild -> SoftUpdateDialog(
                decision = decision,
                onDismiss = { versionGateVm.dismissSoftPrompt() },
            )
            else -> Unit
        }
    }

    organizationAccessRevokedNotice?.let { notice ->
        AlertDialog(
            onDismissRequest = { },
            title = { Text(stringResource(R.string.organization_access_revoked_title)) },
            text = {
                Text(
                    if (notice.organizationName.isNullOrBlank()) {
                        stringResource(R.string.organization_access_revoked_message_generic)
                    } else {
                        stringResource(
                            R.string.organization_access_revoked_message,
                            notice.organizationName.orEmpty(),
                        )
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (notice.fallbackOrganization != null) {
                            navigationVm.switchToDefaultOrganization()
                        } else {
                            navigationVm.dismissOrganizationAccessRevokedNotice()
                        }
                    },
                ) {
                    Text(
                        stringResource(
                            if (notice.fallbackOrganization != null) {
                                R.string.organization_access_revoked_switch_default
                            } else {
                                R.string.organization_access_revoked_acknowledge
                            },
                        ),
                    )
                }
            },
        )
    }

    LaunchedEffect(Unit) {
        AuthEventBus.logoutRequired.collect {
            authVm.logout()
            android.widget.Toast.makeText(
                navController.context,
                navController.context.getString(R.string.error_session_expired_toast),
                android.widget.Toast.LENGTH_LONG,
            ).show()
            // 冷启动竞态守卫：存量 token 过期时，启动期首批请求 401 → refresh 失败会在
            // NavHost 完成 setGraph 之前就 emit logoutRequired（SharedFlow buffer=1 缓存）。
            // 直接 navigate 会触发 "You must call setGraph() before calling getGraph()"
            // 崩溃循环（每次冷启动必现，只能清数据自救）。先等首个 back stack entry
            // 挂载（currentBackStackEntryFlow replay=1，图已就绪时立即放行）再导航。
            navController.currentBackStackEntryFlow.first()
            navController.navigate(LoginRoute) {
                popUpTo(navController.graph.id) { inclusive = true }
            }
        }
    }

    val pendingToken by deepLinkHandler.pendingInviteToken.collectAsState()
    LaunchedEffect(pendingToken, isLoggedIn, needsInviteCode) {
        val token = pendingToken ?: return@LaunchedEffect
        if (isLoggedIn && !needsInviteCode) {
            deepLinkHandler.consumeInviteToken()
            navController.navigate(AcceptInvitationRoute(token = token))
        }
    }

    val pendingResource by deepLinkHandler.pendingResourceNavigation.collectAsState()
    LaunchedEffect(pendingResource, isLoggedIn, needsInviteCode) {
        val target = pendingResource ?: return@LaunchedEffect
        if (!isLoggedIn || needsInviteCode) return@LaunchedEffect
        val spaceId = target.spaceId?.takeIf { it.isNotBlank() }
        val organizationId = target.organizationId?.takeIf { it.isNotBlank() }
        if (organizationId == null || spaceId == null) {
            // 资源 URL 必须同时携带组织与 Space。缺上下文时明确提示，不静默。
            android.widget.Toast.makeText(
                navController.context,
                navController.context.getString(R.string.resource_deep_link_missing_context),
                android.widget.Toast.LENGTH_LONG,
            ).show()
            deepLinkHandler.consumeResourceNavigation()
            return@LaunchedEffect
        }
        // tabdoc / tabdata：切 CLOUD Tab 打开（对齐 iOS）；其它类型仍走 WorkbenchSheet。
        if (CloudDocsPendingOpenResolver.isCloudDocsType(target.resourceType)) {
            pendingCloudDocsOpen = CloudDocsPendingOpen(
                organizationId = organizationId,
                spaceId = spaceId,
                resourceType = target.resourceType,
                resourceId = target.resourceId,
                title = target.title,
                locationHint = target.locationHint,
                preferSharedSegment = false,
            )
            requestedMainTab = MainTabDestination.CLOUD
            // 外部深链可能在 ChatSession/设置等根 destination 上到达；只改隐藏的 Main
            // 状态用户看不见。回到 Main 后再由 CloudDocs pending 可靠投递。
            navController.popBackStack<MainRoute>(inclusive = false)
            deepLinkHandler.consumeResourceNavigation()
            return@LaunchedEffect
        }
        rootWorkbenchRequest = WorkbenchResourceOpenRequest(
            resourceType = target.resourceType,
            resourceId = target.resourceId,
            title = target.title,
            locationHint = target.locationHint,
        )
        rootWorkbenchSpaceId = spaceId
        rootWorkbenchOrganizationId = organizationId
        navController.popBackStack<MainRoute>(inclusive = false)
        deepLinkHandler.consumeResourceNavigation()
    }

    //  推送点击深链：解析出的会话目标 → 导航到 ChatSessionRoute（对齐 iOS）。
    val pendingConversation by deepLinkHandler.pendingConversationNavigation.collectAsState()
    LaunchedEffect(pendingConversation, isLoggedIn) {
        val target = pendingConversation ?: return@LaunchedEffect
        if (!isLoggedIn) return@LaunchedEffect
        val sessionId = target.sessionId?.takeIf { it.isNotBlank() }
        // 有 session_id 才能直达会话；仅 Workspace 级推送暂只拉起 App（后端
        // interaction/agent_done 推送都带 session_id，缺失属兜底）。
        if (sessionId != null) {
            navController.navigate(
                ChatSessionRoute(
                    sessionId = sessionId,
                    // ChatSessionRoute 的参数名是旧壳；推送链路到此始终保持 workspaceId 语义。
                    spaceId = target.workspaceId,
                    organizationId = target.organizationId,
                    projectId = target.projectId.orEmpty(),
                ),
            )
        }
        deepLinkHandler.consumeConversationNavigation()
    }

    val pendingImConversation by deepLinkHandler.pendingImConversationNavigation.collectAsState()
    LaunchedEffect(pendingImConversation, isLoggedIn) {
        val target = pendingImConversation ?: return@LaunchedEffect
        if (!isLoggedIn) return@LaunchedEffect
        if (!navigationVm.selectImNotificationOrganization(
                conversationId = target.conversationId,
                hintedOrganizationId = target.organizationId,
            )
        ) {
            android.widget.Toast.makeText(
                navController.context,
                navController.context.getString(R.string.im_dm_open_failed),
                android.widget.Toast.LENGTH_LONG,
            ).show()
            deepLinkHandler.consumeImConversationNavigation()
            return@LaunchedEffect
        }
        requestedRecentSection = 1
        navController.navigateOnce(
            ImConversationRoute(
                conversationId = target.conversationId,
                title = "",
            ),
        )
        deepLinkHandler.consumeImConversationNavigation()
    }

    if (isRestoringSession) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator()
        }
        return
    }

    val rootRoute: Any = if (isLoggedIn && !needsInviteCode) MainRoute else LoginRoute

    // 导航栈自愈：最后一道防线。
    //
    // NavHost 是整个 App 唯一的内容来源，栈一旦被清空就没有任何 destination 可渲染，
    // ComposeView 会被 measure 成 0x0 —— 表现为整屏纯白，且切后台、重进 Activity 都不
    // 恢复，用户只能杀进程重开。正常路径已由 popBackStackSafely 堵住，这里兜住任何未知
    // 路径（例如带 inclusive 的定向 pop 遇上非预期栈形）。
    //
    // 用 visibleEntries 而不是 currentBackStackEntryAsState：后者由 destination 变更事件
    // 驱动，栈被清空时不会发出 null，检测不到这个故障。
    val visibleEntries by navController.visibleEntries.collectAsState()
    var navGraphEverRendered by remember { mutableStateOf(false) }
    LaunchedEffect(visibleEntries) {
        if (visibleEntries.isNotEmpty()) navGraphEverRendered = true
    }
    LaunchedEffect(visibleEntries, navGraphEverRendered, rootRoute) {
        if (!navGraphEverRendered || visibleEntries.isNotEmpty()) return@LaunchedEffect
        delay(NAV_STACK_EMPTY_CONFIRM_MS) // 避开导航过渡期的瞬时空栈，只对真正的空栈动手
        if (navController.currentBackStackEntry != null) return@LaunchedEffect
        Log.e(NAV_LOG_TAG, "back stack emptied unexpectedly, recovering to root=$rootRoute")
        navController.navigate(rootRoute) {
            popUpTo(navController.graph.id) { inclusive = true }
        }
    }

    NavHost(
        navController = navController,
        startDestination = rootRoute,
        // 撑满可用空间：即便 NavHost 一时没有内容可渲染，宿主 ComposeView 也不会塌成 0x0。
        modifier = Modifier.fillMaxSize(),
    ) {
        composable<LoginRoute> {
            LoginScreen(
                viewModel = authVm,
                onLoginSuccess = { requiresInviteCode ->
                    if (!requiresInviteCode) {
                        val token = deepLinkHandler.consumeInviteToken()
                        if (token != null) {
                            navController.navigateOnce(AcceptInvitationRoute(token = token)) {
                                popUpTo<LoginRoute> { inclusive = true }
                            }
                        } else {
                            navController.navigateOnce(MainRoute) {
                                popUpTo<LoginRoute> { inclusive = true }
                            }
                        }
                    }
                },
            )
        }

        composable<MainRoute> {
            AccountDrawerHost(
                onNavigateToMe = {
                    navController.navigateOnce(MeRoute)
                },
                onNavigateToSettings = {
                    navController.navigateOnce(SettingsRoute)
                },
                onNavigateToNotifications = {
                    navController.navigateOnce(NotificationCenterRoute)
                },
            ) { openAccountDrawer ->
            MainScreen(
                onLogout = {
                    authVm.logout()
                    navController.navigateOnce(LoginRoute) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
                onOpenAccountDrawer = openAccountDrawer,
                onNavigateToCapabilities = {
                    navController.navigateOnce(DeviceCapabilitiesRoute)
                },
                onNavigateToAbout = {
                    navController.navigateOnce(AboutRoute)
                },
                onNavigateToSettings = {
                    navController.navigateOnce(SettingsRoute)
                },
                onNavigateToNotifications = {
                    navController.navigateOnce(NotificationCenterRoute)
                },
                onNavigateToOrganizationSettings = { organizationId ->
                    navController.navigateOnce(WorkspaceSettingsRoute(organizationId = organizationId))
                },
                onNavigateToSpaceSettings = { spaceId ->
                    navController.navigateOnce(SpaceSettingsRoute(spaceId = spaceId))
                },
                onNavigateToAgentDetail = { agentId ->
                    navController.navigateOnce(AgentDetailRoute(agentId = agentId))
                },
                requestedTab = requestedMainTab,
                onRequestedTabConsumed = { requestedMainTab = null },
                onNavigateToCloudResource = { organizationId, resource, spaceName ->
                    openCloudResource(organizationId, resource, spaceName, guaranteedDelivery = false)
                },
                onNavigateToCloudResourceFromEvent = { organizationId, resource, spaceName ->
                    openCloudResource(organizationId, resource, spaceName, guaranteedDelivery = true)
                },
                onNavigateToChatSession = { sid, spId, spName, wsId ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sid,
                            spaceId = spId,
                            spaceName = spName,
                            organizationId = wsId,
                        ),
                    )
                },
                onNavigateToDraftSession = { space, agentId ->
                    navController.navigateToDraftSession(
                        spaceId = space.id,
                        spaceName = space.name,
                        organizationId = space.organizationId,
                        agentId = agentId,
                    )
                },
                onNavigateToImConversation = { conversationId, title ->
                    navController.navigateOnce(
                        ImConversationRoute(conversationId = conversationId, title = title),
                    )
                },
                onNavigateToContacts = { organizationId ->
                    navController.navigateOnce(ContactsRoute(organizationId = organizationId))
                },
                onNavigateToMobileSkills = { marketTab ->
                    navController.navigateOnce(
                        MobileSkillLibraryRoute(initialMarketTab = marketTab.name.lowercase()),
                    )
                },
                onNavigateToMobileAutomation = { navController.navigateOnce(MobileAutomationRoute) },
                onNavigateToArchivedConversations = {
                    navController.navigateOnce(ArchivedConversationsRoute)
                },
                onNavigateToTracker = { trackerId ->
                    navController.navigateOnce(TrackerDetailRoute(trackerId = trackerId))
                },
                requestedRecentSection = requestedRecentSection,
                onRequestedRecentSectionConsumed = { requestedRecentSection = null },
                pendingCloudDocsOpen = pendingCloudDocsOpen,
                onPendingCloudDocsOpenConsumed = { pendingCloudDocsOpen = null },
            )
            }
        }

        composable<AgentDetailRoute> { backStackEntry ->
            val detailVm: AgentDetailViewModel = hiltViewModel()
            // AI分身列表与详情要共享同一个状态所有者：详情保存/停用后，返回列表无需再请求一次。
            val mainEntry = remember(backStackEntry) { navController.getBackStackEntry<MainRoute>() }
            val agentsVm: MyAgentsViewModel = hiltViewModel(mainEntry)
            AgentDetailScreen(
                viewModel = detailVm,
                agentsViewModel = agentsVm,
                onBack = { navController.popBackStackSafely() },
                onOpenChatSession = { sessionId, spaceId, spaceName, organizationId ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sessionId,
                            spaceId = spaceId,
                            spaceName = spaceName,
                            organizationId = organizationId,
                        ),
                    )
                },
            )
        }

        composable<ImConversationRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<ImConversationRoute>()
            val conversationVm: ImConversationViewModel = hiltViewModel(backStackEntry)
            // 指令卡不自行创建任务：复用首页的新任务 composer，让用户仍可确认 AI 分身和 Workspace。
            val mainEntry = remember(backStackEntry) { navController.getBackStackEntry<MainRoute>() }
            val myAgentsVm: MyAgentsViewModel = hiltViewModel(mainEntry)
            val agentListVm: AgentListViewModel = hiltViewModel(mainEntry)
            val myAgentsState by myAgentsVm.uiState.collectAsState()
            val agentState by agentListVm.uiState.collectAsState()
            var promptDraft by remember { mutableStateOf<String?>(null) }
            ImConversationScreen(
                onBack = { navController.popBackStackSafely() },
                onOpenConversation = { conversationId, title ->
                    navController.navigateOnce(ImConversationRoute(conversationId, title))
                },
                onOpenSettings = {
                    navController.navigateOnce(
                        ImConversationSettingsRoute(
                            conversationId = route.conversationId,
                            title = route.title,
                        ),
                    )
                },
                onOpenCloudResource = { organizationId, spaceId, resourceType, resourceId, title ->
                    val normalizedType = SpaceResource.normalizedType(resourceType)
                    if (CloudDocsPendingOpenResolver.isCloudDocsType(normalizedType)) {
                        nativeCloudResourceRoute(
                            resourceType = normalizedType,
                            resourceId = resourceId,
                            organizationId = organizationId,
                            spaceId = spaceId,
                            title = title,
                        )?.let { navController.navigateOnce(it) }
                    } else {
                        rootWorkbenchRequest = WorkbenchResourceOpenRequest(
                            resourceType = resourceType,
                            resourceId = resourceId,
                            title = title,
                        )
                        rootWorkbenchSpaceId = spaceId
                        rootWorkbenchOrganizationId = organizationId
                    }
                },
                onOpenChatSession = {
                    sessionId,
                    workspaceId,
                    spaceName,
                    organizationId,
                    projectId,
                    initialMessage,
                    ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sessionId,
                            spaceId = workspaceId.orEmpty(),
                            spaceName = spaceName,
                            organizationId = organizationId,
                            projectId = projectId,
                            initialMessage = initialMessage,
                        ),
                    )
                },
                onOpenSharedSession = { shareId, sessionId, title, organizationId ->
                    navController.navigateOnce(
                        SharedSessionRoute(
                            shareId = shareId,
                            sessionId = sessionId,
                            title = title,
                            organizationId = organizationId,
                        ),
                    )
                },
                onOpenSpace = { spaceId, agentId ->
                    if (agentId.isNullOrBlank()) {
                        navController.navigateOnce(SpaceSettingsRoute(spaceId))
                    } else {
                        navController.navigateOnce(AgentDetailRoute(agentId))
                    }
                },
                viewModel = conversationVm,
                onUsePrompt = { promptDraft = it },
            )
            promptDraft?.let { prompt ->
                val executionSpaces = agentState.spaces.filter { it.isExecutionSpace }
                MainComposeSheet(
                    agents = myAgentsState.agents,
                    workspaces = executionSpaces,
                    defaultWorkspace = executionSpaces.firstOrNull(),
                    isLoadingAgents = myAgentsState.isLoading,
                    initialDraft = prompt,
                    onDismiss = { promptDraft = null },
                    onChatPrepared = { session, space ->
                        promptDraft = null
                        navController.navigateOnce(
                            ChatSessionRoute(
                                sessionId = session.id,
                                spaceId = space.id,
                                spaceName = space.name,
                                organizationId = space.organizationId,
                            ),
                        )
                    },
                )
            }
        }

        composable<ImConversationSettingsRoute> { backStackEntry ->
            // 设置页与会话页必须共享同一实例：同一 conversation 只能有一个 chat
            // realtime listener / message store，避免设置页销毁时误退订父会话。
            val conversationEntry = remember(backStackEntry) {
                navController.getBackStackEntry<ImConversationRoute>()
            }
            val conversationVm: ImConversationViewModel = hiltViewModel(conversationEntry)
            ImConversationSettingsDestination(
                onBack = { navController.popBackStackSafely() },
                onLeaveConversation = {
                    navController.popBackStack<ImConversationRoute>(inclusive = true)
                },
                viewModel = conversationVm,
            )
        }

        composable<ContactsRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<ContactsRoute>()
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text(stringResource(R.string.im_contacts)) },
                        navigationIcon = {
                            IconButton(onClick = { navController.popBackStackSafely() }) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = stringResource(R.string.common_back),
                                )
                            }
                        },
                    )
                },
            ) { padding ->
                Box(modifier = Modifier.padding(padding)) {
                    ContactsSection(
                        organizationId = route.organizationId,
                        onOpenConversation = { conversationId, title ->
                            navController.navigateOnce(ImConversationRoute(conversationId, title))
                        },
                        onAddOrganizationMember = {
                            navController.navigateOnce(
                                WorkspaceSettingsRoute(
                                    organizationId = route.organizationId,
                                    initialSection = "invite",
                                ),
                            )
                        },
                    )
                }
            }
        }

        composable<SharedSessionRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<SharedSessionRoute>()
            SharedSessionScreen(
                onBack = { navController.popBackStackSafely() },
                onOpenFork = { sessionId, workspace, title ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sessionId,
                            spaceId = workspace.id,
                            spaceName = workspace.name,
                            organizationId = route.organizationId,
                            agentId = workspace.primaryAgentId.orEmpty(),
                        ),
                    )
                },
            )
        }

        composable<ChatSessionRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<ChatSessionRoute>()
            val mainEntry = remember(backStackEntry) { navController.getBackStackEntry<MainRoute>() }
            val myAgentsVm: MyAgentsViewModel = hiltViewModel(mainEntry)
            ChatSessionScreen(
                messageId = route.messageId,
                initialMessage = route.initialMessage,
                onBack = { navController.popBackStackSafely() },
                onNavigateToWallet = if (route.organizationId.isNotEmpty()) {
                    { navController.navigateOnce(WalletRoute(organizationId = route.organizationId)) }
                } else null,
                onNavigateToTabSite = { siteId, siteName, siteUrl, siteStatus ->
                    navController.navigateOnce(
                        TabSitePreviewRoute(siteId, siteName, siteUrl, siteStatus),
                    )
                },
                onNavigateToMemo = { memoId -> navController.navigateOnce(CloudMemoRoute(memoId)) },
                onForkPush = { sid, spId, spName, wsId ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sid,
                            spaceId = spId,
                            spaceName = spName,
                            organizationId = wsId,
                        ),
                    )
                },
                onNewDraftSession = { spId, spName, orgId, agentId ->
                    navController.navigateToDraftSession(
                        spaceId = spId,
                        spaceName = spName,
                        organizationId = orgId,
                        agentId = agentId,
                    )
                },
                onRelogin = {
                    authVm.logout()
                    navController.navigateOnce(LoginRoute) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
                myAgentsViewModel = myAgentsVm,
            )
        }

        composable<DeviceCapabilitiesRoute> {
            val vm: CapabilitiesViewModel = hiltViewModel()
            DeviceCapabilitiesScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<AboutRoute> {
            AboutScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<MeRoute> {
            MeScreen(
                onBack = { navController.popBackStackSafely() },
                onNavigateToEdit = { navController.navigateOnce(ProfileEditRoute) },
            )
        }

        composable<ProfileEditRoute> {
            ProfileEditScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsRoute> {
            SettingsHomeScreen(
                onLogout = {
                    authVm.logout()
                    navController.navigateOnce(LoginRoute) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
                onBack = { navController.popBackStackSafely() },
                onNavigateToAccount = { navController.navigateOnce(SettingsAccountRoute) },
                onNavigateToChangePassword = { navController.navigateOnce(SettingsChangePasswordRoute) },
                onNavigateToAppearance = { navController.navigateOnce(SettingsAppearanceRoute) },
                onNavigateToNotifications = { navController.navigateOnce(NotificationSettingsRoute) },
                onNavigateToPrivacy = { navController.navigateOnce(SettingsPrivacyRoute) },
                onNavigateToDeviceInfo = { navController.navigateOnce(SettingsDeviceInfoRoute) },
                onNavigateToDebugEnvironment = { navController.navigateOnce(SettingsDebugEnvironmentRoute) },
                onNavigateToDiagnostics = { navController.navigateOnce(SettingsDiagnosticsRoute) },
                onNavigateToAbout = { navController.navigateOnce(AboutRoute) },
                onNavigateToOrganizationSummary = { organizationId ->
                    navController.navigateOnce(SettingsOrganizationSummaryRoute(organizationId))
                },
                onNavigateToOrganizationSettings = { organizationId ->
                    navController.navigateOnce(WorkspaceSettingsRoute(organizationId))
                },
            )
        }

        composable<SettingsAccountRoute> {
            SettingsAccountScreen(
                onBack = { navController.popBackStackSafely() },
                onNavigateToVerify = { target -> navController.navigateOnce(VerificationRoute(target = target)) },
            )
        }

        composable<SettingsChangePasswordRoute> {
            ChangePasswordScreen(
                onBack = { navController.popBackStackSafely() },
                onPasswordChanged = {
                    authVm.logout()
                    navController.navigateOnce(LoginRoute) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
            )
        }

        composable<SettingsAppearanceRoute> {
            SettingsAppearanceScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsPrivacyRoute> {
            SettingsPrivacyScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsDeviceInfoRoute> {
            SettingsDeviceInfoScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsDebugEnvironmentRoute> {
            SettingsDebugEnvironmentScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsDiagnosticsRoute> {
            SettingsDiagnosticsScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<SettingsOrganizationSummaryRoute> {
            SettingsOrganizationSummaryScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<WorkspaceSettingsRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<WorkspaceSettingsRoute>()
            val vm: OrganizationSettingsViewModel = hiltViewModel()
            OrganizationSettingsScreen(
                viewModel = vm,
                initialSection = route.initialSection,
                onBack = { navController.popBackStackSafely() },
                onNavigateToUsage = { id ->
                    navController.navigateOnce(UsageRoute(organizationId = id))
                },
                onNavigateToWallet = { id ->
                    navController.navigateOnce(WalletRoute(organizationId = id))
                },
                onNavigateToTrash = { id ->
                    navController.navigateOnce(TrashBinRoute(organizationId = id))
                },
                onNavigateToImConversation = { conversationId, title ->
                    navController.navigateOnce(
                        ImConversationRoute(conversationId = conversationId, title = title),
                    )
                },
            )
        }

        composable<WalletRoute> {
            val vm: WalletViewModel = hiltViewModel()
            WalletScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<UsageRoute> {
            val vm: UsageViewModel = hiltViewModel()
            UsageScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<AcceptInvitationRoute> {
            val vm: AcceptInvitationViewModel = hiltViewModel()
            AcceptInvitationScreen(
                viewModel = vm,
                onBack = {
                    if (!navController.popBackStackSafely()) {
                        navController.navigateOnce(MainRoute) {
                            popUpTo(navController.graph.id) { inclusive = true }
                        }
                    }
                },
                onAccepted = {
                    navController.navigateOnce(MainRoute) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
            )
        }

        composable<SpaceSettingsRoute> {
            val vm: SpaceSettingsViewModel = hiltViewModel()
            SpaceSettingsScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
                onNavigateToSecurity = { spaceId ->
                    navController.navigateOnce(SpaceSecurityRoute(spaceId = spaceId))
                },
                onNavigateToMemory = { spaceId ->
                    navController.navigateOnce(MemorySettingsRoute(spaceId = spaceId))
                },
                onNavigateToSkills = { spaceId ->
                    navController.navigateOnce(SkillsManagementRoute(spaceId = spaceId))
                },
                onNavigateToSubAgents = { spaceId ->
                    navController.navigateOnce(SubAgentListRoute(spaceId = spaceId))
                },
                onNavigateToArchivedSessions = { spaceId ->
                    navController.navigateOnce(ArchivedSessionsRoute(spaceId = spaceId))
                },
                onNavigateToExecutionLimits = { spaceId ->
                    navController.navigateOnce(ExecutionLimitsRoute(spaceId = spaceId))
                },
            )
        }

        composable<SpaceSecurityRoute> {
            val vm: SpaceSecurityViewModel = hiltViewModel()
            SpaceSecurityScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<ExecutionLimitsRoute> {
            val vm: ExecutionLimitsViewModel = hiltViewModel()
            ExecutionLimitsScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<NotificationSettingsRoute> {
            NotificationSettingsScreen(onBack = { navController.popBackStackSafely() })
        }

        composable<NotificationCenterRoute> {
            NotificationCenterScreen(
                onBack = { navController.popBackStackSafely() },
                onNavigate = { request: NotificationOpenRequest ->
                    when (val target = request.target) {
                        is MobileNotificationTarget.ChatSession -> {
                            // ChatSessionRoute 的旧 spaceId 参数只接受执行 Workspace，不能塞 Project。
                            val workspaceId = target.workspaceId
                            if (!workspaceId.isNullOrBlank()) {
                                navController.navigateOnce(
                                    ChatSessionRoute(
                                        sessionId = target.id,
                                        spaceId = workspaceId,
                                        spaceName = request.notification.conversationTitle,
                                        organizationId = target.organizationId.orEmpty(),
                                        projectId = target.projectId.orEmpty(),
                                        messageId = target.messageId.orEmpty(),
                                    ),
                                )
                            }
                        }
                        is MobileNotificationTarget.ImConversation -> {
                            // 先把「最近」切到「消息」段（对齐 iOS），再 push 会话详情。
                            requestedRecentSection = 1
                            navController.navigateOnce(
                                ImConversationRoute(
                                    conversationId = target.id,
                                    title = target.title ?: request.notification.title,
                                ),
                            )
                        }
                        is MobileNotificationTarget.Tracker -> {
                            navController.navigateOnce(TrackerDetailRoute(trackerId = target.id))
                        }
                        is MobileNotificationTarget.AppResource -> {
                            val legacyHostId = target.legacyResourceHostId
                            val organizationId = target.organizationId
                            val resourceId = target.resourceId
                            if (!organizationId.isNullOrBlank() && !resourceId.isNullOrBlank()) {
                                if (CloudDocsPendingOpenResolver.isCloudDocsType(target.appId)) {
                                    pendingCloudDocsOpen = CloudDocsPendingOpen(
                                        organizationId = organizationId,
                                        spaceId = legacyHostId,
                                        resourceType = target.appId,
                                        resourceId = resourceId,
                                        title = request.notification.title,
                                        locationHint = target.route,
                                        preferSharedSegment = false,
                                    )
                                    requestedMainTab = MainTabDestination.CLOUD
                                } else {
                                    rootWorkbenchRequest = WorkbenchResourceOpenRequest(
                                        resourceType = target.appId,
                                        resourceId = resourceId,
                                        title = request.notification.title,
                                        locationHint = target.route,
                                    )
                                    rootWorkbenchSpaceId = legacyHostId
                                    rootWorkbenchOrganizationId = organizationId
                                }
                                navController.popBackStack<MainRoute>(inclusive = false)
                            }
                        }
                        is MobileNotificationTarget.SharedResource -> {
                            val legacyHostId = target.legacyResourceHostId
                            val organizationId = target.organizationId
                            if (!organizationId.isNullOrBlank()) {
                                if (CloudDocsPendingOpenResolver.isCloudDocsType(target.resourceType)) {
                                    pendingCloudDocsOpen = CloudDocsPendingOpen(
                                        organizationId = organizationId,
                                        spaceId = legacyHostId,
                                        resourceType = target.resourceType,
                                        resourceId = target.id,
                                        title = target.resourceTitle ?: request.notification.title,
                                        preferSharedSegment = true,
                                    )
                                    requestedMainTab = MainTabDestination.CLOUD
                                } else {
                                    rootWorkbenchRequest = WorkbenchResourceOpenRequest(
                                        resourceType = target.resourceType,
                                        resourceId = target.id,
                                        title = target.resourceTitle ?: request.notification.title,
                                    )
                                    rootWorkbenchSpaceId = legacyHostId
                                    rootWorkbenchOrganizationId = organizationId
                                }
                                navController.popBackStack<MainRoute>(inclusive = false)
                            }
                        }
                        is MobileNotificationTarget.ResourceAccessRequest -> Unit
                        MobileNotificationTarget.Invitation -> {
                            navController.navigateOnce(OrganizationInvitationsRoute)
                        }
                        MobileNotificationTarget.ProfileSettings -> {
                            requestedMainTab = MainTabDestination.SETTINGS
                            navController.popBackStack<MainRoute>(inclusive = false)
                        }
                        MobileNotificationTarget.NotificationPanel,
                        MobileNotificationTarget.Unsupported -> Unit
                    }
                },
            )
        }

        composable<OrganizationInvitationsRoute> {
            OrganizationInvitationsScreen(
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<VerificationRoute> {
            val route = it.toRoute<VerificationRoute>()
            val vm: VerificationViewModel = hiltViewModel()
            VerificationScreen(
                initialTarget = route.target,
                onBack = { navController.popBackStackSafely() },
                viewModel = vm,
            )
        }

        composable<VoiceSettingsRoute> {
            val vm: VoiceSettingsViewModel = hiltViewModel()
            VoiceSettingsScreen(viewModel = vm, onBack = { navController.popBackStackSafely() })
        }

        composable<ArchivedSessionsRoute> {
            val vm: ArchivedSessionsViewModel = hiltViewModel()
            ArchivedSessionsScreen(viewModel = vm, onBack = { navController.popBackStackSafely() })
        }

        composable<ArchivedConversationsRoute> { backStackEntry ->
            val vm: AllConversationsViewModel = hiltViewModel()
            val mainEntry = remember(backStackEntry) { navController.getBackStackEntry<MainRoute>() }
            val agentListVm: AgentListViewModel = hiltViewModel(mainEntry)
            val agentState by agentListVm.uiState.collectAsState()
            ArchivedConversationsScreen(
                viewModel = vm,
                workspaces = agentState.spaces.filter { it.isExecutionSpace },
                onBack = { navController.popBackStackSafely() },
                onSessionClick = { sessionId, workspaceId, workspaceName, organizationId ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = sessionId,
                            spaceId = workspaceId,
                            spaceName = workspaceName,
                            organizationId = organizationId,
                        ),
                    )
                },
            )
        }

        composable<TrashBinRoute> {
            val vm: TrashBinViewModel = hiltViewModel()
            TrashBinScreen(viewModel = vm, onBack = { navController.popBackStackSafely() })
        }

        composable<MemorySettingsRoute> {
            val vm: MemorySettingsViewModel = hiltViewModel()
            MemorySettingsScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<SkillsManagementRoute> {
            val vm: SkillsManagementViewModel = hiltViewModel()
            SkillsManagementScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<MobileSkillLibraryRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<MobileSkillLibraryRoute>()
            MobileSkillLibraryScreen(
                onBack = { navController.popBackStackSafely() },
                initialAgentId = route.initialAgentId,
                initialMarketTab = MobileSkillMarketTab.fromRouteParam(route.initialMarketTab),
                onOpenDetail = { skillKey, initialAgentId ->
                    navController.navigateOnce(MobileSkillDetailRoute(skillKey, initialAgentId))
                },
            )
        }

        composable<MobileSkillDetailRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<MobileSkillDetailRoute>()
            val libraryEntry = remember(backStackEntry) { navController.getBackStackEntry<MobileSkillLibraryRoute>() }
            MobileSkillDetailScreen(
                skillKey = route.skillKey,
                initialAgentId = route.initialAgentId,
                onBack = { navController.popBackStackSafely() },
                onQuickUse = { preset, agentId ->
                    navController.navigateOnce(MobileSkillQuickUseRoute(route.skillKey, preset.resolvedId, agentId))
                },
                viewModel = hiltViewModel(libraryEntry),
            )
        }

        composable<MobileSkillQuickUseRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<MobileSkillQuickUseRoute>()
            val libraryEntry = remember(backStackEntry) { navController.getBackStackEntry<MobileSkillLibraryRoute>() }
            MobileSkillQuickUseScreen(
                skillKey = route.skillKey,
                presetId = route.presetId,
                agentId = route.agentId,
                onBack = { navController.popBackStackSafely() },
                onStartTask = { prompt, agentId ->
                    navController.navigateOnce(
                        MobileSkillTaskComposerRoute(prompt = prompt, agentId = agentId),
                    )
                },
                viewModel = hiltViewModel(libraryEntry),
            )
        }

        composable<MobileSkillTaskComposerRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<MobileSkillTaskComposerRoute>()
            val mainEntry = remember(backStackEntry) { navController.getBackStackEntry<MainRoute>() }
            val myAgentsVm: MyAgentsViewModel = hiltViewModel(mainEntry)
            val agentListVm: AgentListViewModel = hiltViewModel(mainEntry)
            val myAgentsState by myAgentsVm.uiState.collectAsState()
            val agentState by agentListVm.uiState.collectAsState()
            val executionSpaces = agentState.spaces.filter { it.isExecutionSpace }
            MainComposeSheet(
                agents = myAgentsState.agents,
                workspaces = executionSpaces,
                defaultWorkspace = executionSpaces.firstOrNull(),
                defaultAgentId = route.agentId,
                isLoadingAgents = myAgentsState.isLoading,
                initialDraft = route.prompt,
                onDismiss = { navController.popBackStackSafely() },
                onChatPrepared = { session, space ->
                    navController.navigateOnce(
                        ChatSessionRoute(
                            sessionId = session.id,
                            spaceId = space.id,
                            spaceName = space.name,
                            organizationId = space.organizationId,
                        ),
                    ) {
                        popUpTo<MobileSkillTaskComposerRoute> { inclusive = true }
                    }
                },
            )
        }

        composable<MobileAutomationRoute> {
            MobileAutomationScreen(
                onBack = { navController.popBackStackSafely() },
                onOpenTracker = { trackerId ->
                    navController.navigateOnce(TrackerDetailRoute(trackerId = trackerId))
                },
            )
        }

        composable<SubAgentListRoute> {
            val vm: SubAgentListViewModel = hiltViewModel()
            SubAgentListScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<DocListRoute> {
            val vm: DocListViewModel = hiltViewModel()
            val state by vm.uiState.collectAsState()
            LaunchedEffect(state.createdDocId) {
                state.createdDocId?.let { docId ->
                    vm.consumeCreatedDocId()
                    val created = state.documents.firstOrNull { it.id == docId } ?: return@let
                    navController.navigate(
                        DocEditorRoute(
                            documentId = docId,
                            organizationId = created.organizationId,
                        ),
                    )
                }
            }
            DocListScreen(
                viewModel = vm,
                onDocClick = { doc ->
                    navController.navigateOnce(
                        DocEditorRoute(
                            documentId = doc.id,
                            organizationId = doc.organizationId,
                        ),
                    )
                },
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<DocEditorRoute> {
            val vm: DocEditorViewModel = hiltViewModel()
            DocEditorScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<NativeCloudResourceRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<NativeCloudResourceRoute>()
            val sessionEntry = remember(backStackEntry) {
                runCatching { navController.getBackStackEntry<ChatSessionRoute>() }.getOrNull()
            }
            val conversationVm: ConversationViewModel? = sessionEntry?.let { hiltViewModel(it) }
            // 跳转由 ViewModel 的一次性事件在 LaunchedEffect 里驱动，不能过 navigateOnce 的
            // RESUMED 闸门：被挡掉就静默丢失，而 tryEmit 的事件不会重投，用户点了没反应。
            // 只读字段唯一的编辑退路就是这里，所以保证投递，改用 launchSingleTop 兜连点。
            val openFullEditor = {
                navController.navigate(
                    CloudWebResourceRoute(
                        organizationId = route.organizationId,
                        spaceId = route.spaceId,
                        resourceType = route.resourceType,
                        resourceId = route.resourceId,
                        title = route.title,
                    ),
                ) {
                    launchSingleTop = true
                }
            }
            when (route.resourceType) {
                "tabdoc" -> {
                    val vm: DocEditorViewModel = hiltViewModel(backStackEntry)
                    DocEditorScreen(
                        viewModel = vm,
                        onBack = { navController.popBackStackSafely() },
                        onOpenFullEditor = openFullEditor,
                    )
                }
                "tabdata" -> NativeTabDataScreen(
                    onBack = { navController.popBackStackSafely() },
                    onOpenFullEditor = openFullEditor,
                    viewModel = hiltViewModel(backStackEntry),
                    onFocusChanged = { tableId, viewId ->
                        conversationVm?.updateWorkbenchFocus(
                            route.spaceId,
                            WorkbenchFocusTarget(
                                appType = "tabdata",
                                resourceId = tableId,
                                title = route.title,
                                path = "detail/tabdata/$tableId",
                                viewId = viewId,
                                pane = WorkbenchNavigationPane.Detail(
                                    kind = WorkbenchAppHomeKind.TABDATA,
                                    request = WorkbenchResourceOpenRequest(
                                        resourceType = "tabdata",
                                        resourceId = tableId,
                                        title = route.title,
                                    ),
                                ),
                            ),
                        )
                    },
                )
            }
        }

        composable<CloudWebResourceRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<CloudWebResourceRoute>()
            val vm: WorkbenchViewModel = hiltViewModel()
            AuthenticatedWorkbenchWebScreen(
                target = WorkbenchWebTarget(
                    resourceType = route.resourceType,
                    resourceId = route.resourceId,
                    title = route.title,
                ),
                organizationId = route.organizationId,
                spaceId = route.spaceId,
                webBaseUrl = vm.webBaseUrl,
                authCoordinator = vm.embeddedWebAuthCoordinator,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<CloudMemoRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<CloudMemoRoute>()
            val vm: TabMemoViewModel = hiltViewModel()
            MemoDetailScreen(
                memoId = route.memoId,
                viewModel = vm,
                onDismiss = { navController.popBackStackSafely() },
            )
        }

        composable<CloudFileRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<CloudFileRoute>()
            CloudFileInfoScreen(
                info = CloudFileInfo(
                    contextItemId = route.contextItemId,
                    organizationId = route.organizationId,
                    resourceId = route.resourceId,
                    spaceId = route.spaceId,
                    spaceName = route.spaceName,
                    fileName = route.fileName,
                    preview = route.preview,
                    mimeType = route.mimeType,
                    typeLabel = route.typeLabel,
                    fileSizeBytes = route.fileSizeBytes,
                    fileUrl = null,
                    canShare = route.canShare,
                    canTrash = route.canTrash,
                ),
                organizationId = route.organizationId,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<TabSitePreviewRoute> {
            val vm: TabSitePreviewViewModel = hiltViewModel()
            TabSitePreviewScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<TabSlideViewerRoute> {
            val vm: TabSlideViewerViewModel = hiltViewModel()
            TabSlideViewerScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<TrackerListRoute> {
            val vm: TrackerListViewModel = hiltViewModel()
            TrackerScreen(
                viewModel = vm,
                onTrackerClick = { trackerId ->
                    navController.navigateOnce(TrackerDetailRoute(trackerId = trackerId))
                },
                onBack = { navController.popBackStackSafely() },
            )
        }

        composable<TrackerDetailRoute> {
            val vm: TrackerDetailViewModel = hiltViewModel()
            TrackerDetailScreen(
                viewModel = vm,
                onBack = { navController.popBackStackSafely() },
                onOpenConversation = { sessionId ->
                    navController.navigateOnce(ChatSessionRoute(sessionId = sessionId, spaceId = ""))
                },
            )
        }
    }

    val openRequest = rootWorkbenchRequest
    val openSpaceId = rootWorkbenchSpaceId
    val openOrganizationId = rootWorkbenchOrganizationId
    if (openRequest != null && !openOrganizationId.isNullOrBlank()) {
        WorkbenchSheet(
            organizationId = openOrganizationId,
            spaceId = openSpaceId,
            initialOpenRequest = openRequest,
            onDismiss = {
                rootWorkbenchRequest = null
                rootWorkbenchSpaceId = null
                rootWorkbenchOrganizationId = null
            },
            onDelegateToAgent = {},
            onResourceOpen = { resource ->
                rootWorkbenchRequest = null
                rootWorkbenchSpaceId = null
                rootWorkbenchOrganizationId = null
                if (resource.normalizedType in setOf("tabdoc", "tabdata")) {
                    nativeCloudResourceRoute(
                        resourceType = resource.normalizedType,
                        resourceId = resource.resourceId,
                        organizationId = resource.organizationId ?: openOrganizationId,
                        spaceId = resource.spaceId ?: openSpaceId,
                        title = resource.displayTitle,
                    )?.let { navController.navigateOnce(it) }
                } else if (resource.normalizedType == "tabsite") {
                    val meta = resource.metadata
                    val publishedUrl = (meta?.get("published_url") as? JsonPrimitive)?.content ?: ""
                    val status = (meta?.get("status") as? JsonPrimitive)?.content ?: "draft"
                    navController.navigateOnce(
                        TabSitePreviewRoute(
                            resource.resourceId,
                            resource.displayTitle,
                            publishedUrl,
                            status,
                        ),
                    )
                }
            },
        )
    }

    if (isLoggedIn && needsInviteCode) {
        InviteCodeGateDialog(
            isRedeeming = authUiState.isRedeemingInviteCode,
            errorMessage = authUiState.inviteCodeError,
            onRedeem = { inviteCode ->
                authVm.redeemInviteCode(inviteCode) {
                    navController.navigateOnce(MainRoute) {
                        popUpTo<LoginRoute> { inclusive = true }
                    }
                }
            },
            onChangeAccount = {
                authVm.logout()
                navController.navigateOnce(LoginRoute) {
                    popUpTo(navController.graph.id) { inclusive = true }
                }
            },
        )
    }
}
