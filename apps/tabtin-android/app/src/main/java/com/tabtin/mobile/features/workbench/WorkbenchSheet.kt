package com.tabtin.mobile.features.workbench

import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.CloudFileInfo
import com.tabtin.mobile.features.clouddocs.CloudFileInfoScreen
import com.tabtin.mobile.features.clouddocs.TabTinAppIcon
import com.tabtin.mobile.features.clouddocs.TabTinAppIconVariant
import java.time.Duration
import java.time.Instant
import com.tabtin.mobile.features.doc.DocumentQuotaExceededDialog
import com.tabtin.mobile.features.files.CloudDriveAppHomeScreen
import com.tabtin.mobile.features.files.CloudDriveFileViewportCard
import com.tabtin.mobile.features.files.CloudDriveResourceArtwork
import com.tabtin.mobile.features.files.cloudDriveCategoryLabel
import com.tabtin.mobile.features.memo.MemoAppHomeScreen
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion

/**
 * 工作台呈现方式。
 *
 * - [MODAL]：真正的底部抽屉（非任务入口等）；走 [TTBottomSheet]
 * - [EMBEDDED]：宽屏宿主侧栏内嵌；不套 sheet
 * - [TASK_PANE]：会话内全屏工作面（窄屏 overview 切屏）；嵌入内容区，**不**套 sheet
 */
public enum class WorkbenchPresentation {
    MODAL,
    EMBEDDED,
    TASK_PANE,
}

/** 仅 [WorkbenchPresentation.MODAL] 使用底部抽屉。 */
internal fun WorkbenchPresentation.wrapsInModalSheet(): Boolean =
    this == WorkbenchPresentation.MODAL

/** 会话 task pane：全屏占据宿主内容区（对齐 iOS embedded task pane）。 */
internal fun WorkbenchPresentation.isFullscreenTaskPane(): Boolean =
    this == WorkbenchPresentation.TASK_PANE

/**
 * 统一内容层（同层 when 切换；禁止按路径 early-return 整棵树）。
 * Web 优先于导航 pane。
 */
public enum class WorkbenchContentLayer {
    WEB,
    APP_HOME,
    DETAIL,
    OVERVIEW,
}

/** 资源详情在移动工作台中的唯一呈现策略，避免各入口自行判断 Web/原生。 */
public enum class WorkbenchResourcePresentation {
    NATIVE_WORKBENCH,
    WEB,
    HOST,
}

public fun resolveWorkbenchResourcePresentation(resourceType: String): WorkbenchResourcePresentation =
    when (SpaceResource.normalizedType(resourceType)) {
        "tabdoc", "tabdata" -> WorkbenchResourcePresentation.NATIVE_WORKBENCH
        "tabslide" -> WorkbenchResourcePresentation.WEB
        else -> WorkbenchResourcePresentation.HOST
    }

internal fun TaskWorkbenchOutput.syntheticNativeResource(
    spaceId: String?,
    organizationId: String,
): SpaceResource? {
    val normalizedType = SpaceResource.normalizedType(resourceType)
    if (
        resourceId.isBlank() ||
        resolveWorkbenchResourcePresentation(normalizedType) != WorkbenchResourcePresentation.NATIVE_WORKBENCH
    ) {
        return null
    }
    return SpaceResource(
        id = "workbench:$normalizedType:$resourceId",
        itemType = normalizedType,
        title = title,
        preview = preview,
        resourceId = resourceId,
        spaceId = spaceId,
        organizationId = organizationId,
        spaceName = openRequest.locationHint,
    )
}

/** 解析当前应展示的内容层；与 [WorkbenchContentHost] 的 when 分支保持同构。 */
public fun resolveWorkbenchContentLayer(
    hasWebTarget: Boolean,
    pane: WorkbenchNavigationPane,
): WorkbenchContentLayer {
    if (hasWebTarget) return WorkbenchContentLayer.WEB
    return when (pane) {
        is WorkbenchNavigationPane.AppHome -> WorkbenchContentLayer.APP_HOME
        is WorkbenchNavigationPane.Detail ->
            if (
                pane.kind != null ||
                resolveWorkbenchResourcePresentation(pane.request.normalizedType) ==
                WorkbenchResourcePresentation.NATIVE_WORKBENCH
            ) {
                WorkbenchContentLayer.DETAIL
            } else {
                WorkbenchContentLayer.OVERVIEW
            }
        WorkbenchNavigationPane.Overview -> WorkbenchContentLayer.OVERVIEW
    }
}

private fun mergeWorkbenchLibraryResources(
    owned: List<SpaceResource>,
    shared: List<SpaceResource>,
): List<SpaceResource> {
    if (shared.isEmpty()) return owned
    if (owned.isEmpty()) return shared
    val result = LinkedHashMap<String, SpaceResource>()
    fun key(resource: SpaceResource): String = "${resource.normalizedType}:${resource.resourceId}"
    (owned + shared).forEach { resource ->
        result.putIfAbsent(key(resource), resource)
    }
    return result.values.toList()
}

private fun mergeWorkbenchResources(
    owned: List<SpaceResource>,
    sharedByType: Map<String, List<SpaceResource>>,
): List<SpaceResource> {
    if (sharedByType.isEmpty()) return owned
    return mergeWorkbenchLibraryResources(owned, sharedByType.values.flatten())
}

/**
 * 宿主组合契约：内容层 + sheet 包装边界 + 反馈层可否同层挂载。
 * [sharedFeedbackLayerMountable] 在去 early-return 后恒为 true。
 */
public data class WorkbenchHostComposition(
    val contentLayer: WorkbenchContentLayer,
    /** overview 分支是否包 [TTBottomSheet]（仅 MODAL）。 */
    val wrapsOverviewInModalSheet: Boolean,
    /** AppHome / Placeholder 叶子是否自包 Modal（仅 MODAL；Web 永不自包）。 */
    val leafWrapsInModalSheet: Boolean,
    val sharedFeedbackLayerMountable: Boolean,
)

public fun resolveWorkbenchHostComposition(
    presentation: WorkbenchPresentation,
    hasWebTarget: Boolean,
    pane: WorkbenchNavigationPane,
): WorkbenchHostComposition {
    val layer = resolveWorkbenchContentLayer(hasWebTarget, pane)
    val modal = presentation.wrapsInModalSheet()
    return WorkbenchHostComposition(
        contentLayer = layer,
        wrapsOverviewInModalSheet = modal && layer == WorkbenchContentLayer.OVERVIEW,
        leafWrapsInModalSheet = modal &&
            (layer == WorkbenchContentLayer.APP_HOME || layer == WorkbenchContentLayer.DETAIL),
        sharedFeedbackLayerMountable = true,
    )
}

/**
 * MODAL 入口（深链 / SpaceTab 等）。内容体在 [WorkbenchSurface]；
 * 此处不再承载 Web/AppHome early-return。
 */
@Composable
public fun WorkbenchSheet(
    organizationId: String,
    spaceId: String?,
    initialOpenRequest: WorkbenchResourceOpenRequest? = null,
    onDismiss: () -> Unit,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onResourceOpen: (SpaceResource) -> Unit = {},
    /**
     * 可选：当前任务对话的引用接收器。
     * 非空时云盘 / App 首页才显示「发送到当前对话」；深链与非对话入口保持 null。
     * 任务宿主不应在回调里关闭工作台（避免语音/发送后丢失详情与滚动）。
     */
    activeConversationSink: ((ResourceReference) -> Unit)? = null,
    onRequestApp: ((TaskWorkbenchApp) -> Unit)? = null,
    onFocusChanged: ((WorkbenchFocusTarget) -> Unit)? = null,
    presentation: WorkbenchPresentation = WorkbenchPresentation.MODAL,
    /** 任务页进入资源/App 子页面时，让宿主隐藏「对话 / 工作台」切换。 */
    onTaskPaneDetailVisibilityChanged: (Boolean) -> Unit = {},
    viewModel: WorkbenchViewModel = hiltViewModel(),
) {
    WorkbenchSurface(
        organizationId = organizationId,
        spaceId = spaceId,
        initialOpenRequest = initialOpenRequest,
        onFocusChanged = onFocusChanged ?: {},
        onDismiss = onDismiss,
        onDelegateToAgent = onDelegateToAgent,
        onResourceOpen = onResourceOpen,
        onSendReference = activeConversationSink,
        onRequestApp = onRequestApp,
        presentation = presentation,
        onTaskPaneDetailVisibilityChanged = onTaskPaneDetailVisibilityChanged,
        viewModel = viewModel,
    )
}

/**
 * 可复用内容体：overview / AppHome / Web 同层 when；仅 MODAL overview 包 [TTBottomSheet]。
 * 由 [WorkbenchSurface] 挂载，并在其外层 Box 挂反馈层。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkbenchContentHost(
    organizationId: String,
    spaceId: String?,
    backHandlingEnabled: Boolean = true,
    initialOpenRequest: WorkbenchResourceOpenRequest? = null,
    onInitialOpenRequestConsumed: (WorkbenchResourceOpenRequest) -> Unit = {},
    onDismiss: () -> Unit,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onResourceOpen: (SpaceResource) -> Unit = {},
    activeConversationSink: ((ResourceReference) -> Unit)? = null,
    onRequestApp: ((TaskWorkbenchApp) -> Unit)? = null,
    conversationMessages: List<ChatMessage> = emptyList(),
    onFocusChanged: ((WorkbenchFocusTarget) -> Unit)? = null,
    presentation: WorkbenchPresentation = WorkbenchPresentation.MODAL,
    onTaskPaneDetailVisibilityChanged: (Boolean) -> Unit = {},
    viewModel: WorkbenchViewModel,
) {
    val scopedSpaceId = spaceId?.takeIf { it.isNotBlank() }
    val state by viewModel.uiState.collectAsState()
    val organizations by viewModel.organizations.collectAsState()
    val organizationName = organizations.firstOrNull { it.id == organizationId }?.name.orEmpty()
    val isStreaming by viewModel.streamManager.isStreaming.collectAsState()
    val context = LocalContext.current
    val sheetState = rememberTTSheetState(skipPartiallyExpanded = false)
    var selectedWebTarget by remember { mutableStateOf<WorkbenchWebTarget?>(null) }
    /** 从原生详情进入完整 Web 编辑器时，返回应回原生详情，而不是跳过一层回 App 首页。 */
    var webBackKeepsNativeDetail by remember { mutableStateOf(false) }
    var handledInitialRequest by remember(initialOpenRequest) { mutableStateOf(false) }
    var openNotice by remember(initialOpenRequest) { mutableStateOf<String?>(null) }
    val appHomeNav = remember(organizationId, scopedSpaceId) { WorkbenchAppHomeNavigationState() }
    var appHomeNavTick by remember { mutableStateOf(0) }
    var pendingMemoDetailId by remember { mutableStateOf<String?>(null) }
    // Native Focus Bridge 回传的 viewId；仅在 resourceId 匹配当前表格时生效。
    var reportedViewId by remember { mutableStateOf<String?>(null) }
    var reportedViewResourceId by remember { mutableStateOf<String?>(null) }

    val taskPaneShowsDetail = presentation == WorkbenchPresentation.TASK_PANE && (
        selectedWebTarget != null || appHomeNav.pane !is WorkbenchNavigationPane.Overview
    )
    LaunchedEffect(taskPaneShowsDetail) {
        onTaskPaneDetailVisibilityChanged(taskPaneShowsDetail)
    }
    DisposableEffect(Unit) {
        onDispose { onTaskPaneDetailVisibilityChanged(false) }
    }

    LaunchedEffect(scopedSpaceId, organizationId) {
        appHomeNav.resetForScopeChange()
        appHomeNavTick += 1
        pendingMemoDetailId = null
        reportedViewId = null
        reportedViewResourceId = null
        scopedSpaceId?.let { viewModel.loadResources(it) }
        if (organizationId.isNotBlank()) {
            viewModel.loadApps(organizationId, scopedSpaceId)
        }
    }
    LaunchedEffect(selectedWebTarget?.resourceId) {
        reportedViewId = null
        reportedViewResourceId = null
    }
    LaunchedEffect(appHomeNav.pane, selectedWebTarget, appHomeNavTick, reportedViewId, reportedViewResourceId) {
        val base = WorkbenchFocusTarget.fromPane(appHomeNav.pane)
        val focus = selectedWebTarget?.let { web ->
            val matchedViewId = reportedViewId?.takeIf {
                reportedViewResourceId == web.resourceId
            }
            base.copy(
                appType = web.resourceType,
                resourceId = web.resourceId,
                title = web.title,
                path = "detail/${web.resourceType}/${web.resourceId}",
                viewId = matchedViewId,
            )
        } ?: base.copy(
            viewId = reportedViewId?.takeIf {
                reportedViewResourceId == base.resourceId
            },
        )
        onFocusChanged?.invoke(focus)
    }
    LaunchedEffect(state.createDocumentErrorRes) {
        state.createDocumentErrorRes?.let { messageRes ->
            Toast.makeText(context, context.getString(messageRes), Toast.LENGTH_SHORT).show()
            viewModel.consumeCreateDocumentError()
        }
    }
    state.createDocumentQuotaExceeded?.let { quotaExceeded ->
        DocumentQuotaExceededDialog(
            error = quotaExceeded,
            onDismiss = viewModel::dismissCreateDocumentQuotaExceeded,
        )
    }
    LaunchedEffect(initialOpenRequest, state.resources, state.isLoading) {
        val request = initialOpenRequest ?: return@LaunchedEffect
        if (handledInitialRequest || (scopedSpaceId != null && state.isLoading)) return@LaunchedEffect
        handledInitialRequest = true
        when (
            val destination = WorkbenchRouteResolver.resolve(
                resourceType = request.resourceType,
                resourceId = request.resourceId,
                title = request.title,
                locationHint = request.locationHint,
            )
        ) {
            is WorkbenchOpenDestination.AppHome -> {
                appHomeNav.showAppHome(destination.kind)
                appHomeNavTick += 1
                openNotice = null
            }
            is WorkbenchOpenDestination.CloudDocs,
            is WorkbenchOpenDestination.WorkbenchDetail -> {
                val detailRequest = when (destination) {
                    is WorkbenchOpenDestination.CloudDocs -> destination.request
                    is WorkbenchOpenDestination.WorkbenchDetail -> destination.request
                }
                val kind = WorkbenchAppHomeKind.fromAppId(detailRequest.normalizedType)
                if (kind == WorkbenchAppHomeKind.TABMEMO) {
                    pendingMemoDetailId = detailRequest.resourceId.takeIf { it.isNotBlank() }
                    appHomeNav.showAppHome(WorkbenchAppHomeKind.TABMEMO)
                    appHomeNavTick += 1
                    openNotice = null
                } else if (kind != null) {
                    if (resolveWorkbenchResourcePresentation(detailRequest.normalizedType) ==
                        WorkbenchResourcePresentation.NATIVE_WORKBENCH
                    ) {
                        appHomeNav.showDirectDetail(detailRequest)
                    } else {
                        appHomeNav.showDetail(detailRequest, kind)
                    }
                    appHomeNavTick += 1
                    if (resolveWorkbenchResourcePresentation(detailRequest.normalizedType) ==
                        WorkbenchResourcePresentation.NATIVE_WORKBENCH
                    ) {
                        selectedWebTarget = null
                        webBackKeepsNativeDetail = false
                        reportedViewId = null
                        reportedViewResourceId = null
                        openNotice = null
                    } else {
                        val webTarget = WorkbenchWebTarget.from(detailRequest, state.resources)
                        if (webTarget != null) {
                            selectedWebTarget = webTarget
                            webBackKeepsNativeDetail = false
                        }
                        openNotice = null
                    }
                } else {
                    val webTarget = WorkbenchWebTarget.from(detailRequest, state.resources)
                    if (webTarget != null) {
                        selectedWebTarget = webTarget
                        webBackKeepsNativeDetail = false
                        openNotice = null
                    } else {
                        selectedWebTarget = null
                        webBackKeepsNativeDetail = false
                        openNotice = detailRequest.unsupportedOpenNotice
                    }
                }
            }
            is WorkbenchOpenDestination.Unsupported -> {
                selectedWebTarget = null
                webBackKeepsNativeDetail = false
                openNotice = destination.notice
            }
        }
        onInitialOpenRequestConsumed(request)
    }

    // 统一宿主：不再 early-return；Web/AppHome/Overview 同层切换，反馈层由 Surface 挂。
    @Suppress("UNUSED_VARIABLE")
    val paneTick = appHomeNavTick
    val webTarget = selectedWebTarget
    val pane = appHomeNav.pane
    val wrapInModalSheet = presentation.wrapsInModalSheet()
    val requestAppToComposer: (TaskWorkbenchApp) -> Unit = { app ->
        val handler = onRequestApp
        if (handler != null) {
            handler(app)
        } else {
            Toast.makeText(
                context,
                context.getString(R.string.workbench_request_app_hint, app.name),
                Toast.LENGTH_SHORT,
            ).show()
            if (wrapInModalSheet) onDismiss()
        }
    }
    val openResourceDetail: (SpaceResource) -> Unit = { resource ->
        when (resolveWorkbenchResourcePresentation(resource.normalizedType)) {
            WorkbenchResourcePresentation.NATIVE_WORKBENCH -> {
                val request = WorkbenchResourceOpenRequest(
                    resourceType = resource.normalizedType,
                    resourceId = resource.resourceId,
                    title = resource.displayTitle,
                )
                val sourceAppHome = (appHomeNav.pane as? WorkbenchNavigationPane.AppHome)?.kind
                if (sourceAppHome != null) {
                    appHomeNav.showDetail(request, sourceAppHome)
                } else {
                    appHomeNav.showDirectDetail(request)
                }
                appHomeNavTick += 1
                selectedWebTarget = null
                webBackKeepsNativeDetail = false
                reportedViewId = null
                reportedViewResourceId = null
            }
            WorkbenchResourcePresentation.WEB -> {
                selectedWebTarget = WorkbenchWebTarget.from(resource)
                webBackKeepsNativeDetail = false
            }
            WorkbenchResourcePresentation.HOST -> onResourceOpen(resource)
        }
    }
    val contentLayer = resolveWorkbenchContentLayer(
        hasWebTarget = webTarget != null,
        pane = pane,
    )
    val workbenchBody: @Composable () -> Unit = {
        when (contentLayer) {
            WorkbenchContentLayer.WEB -> {
                webTarget?.let { target ->
                    AuthenticatedWorkbenchWebScreen(
                        target = target,
                        organizationId = organizationId,
                        spaceId = spaceId,
                        backHandlingEnabled = backHandlingEnabled,
                        webBaseUrl = viewModel.webBaseUrl,
                        authCoordinator = viewModel.embeddedWebAuthCoordinator,
                        onNativeFocusReport = { report ->
                            if (report.resourceId == target.resourceId) {
                                reportedViewResourceId = report.resourceId
                                reportedViewId = report.viewId
                            }
                        },
                        onBack = {
                            selectedWebTarget = null
                            if (webBackKeepsNativeDetail) {
                                webBackKeepsNativeDetail = false
                            } else if (appHomeNav.pane is WorkbenchNavigationPane.Detail) {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            } else if (initialOpenRequest != null && wrapInModalSheet) {
                                onDismiss()
                            }
                        },
                    )
                }
            }
            WorkbenchContentLayer.APP_HOME -> {
                (pane as? WorkbenchNavigationPane.AppHome)?.let { appHome ->
                    if (appHome.kind == WorkbenchAppHomeKind.TABMEMO) {
                        val appTitle = state.apps.firstOrNull { it.id == appHome.kind.appId }?.name
                            ?: appHome.kind.displayName
                        MemoAppHomeScreen(
                            organizationId = organizationId,
                            organizationName = organizationName,
                            appTitle = appTitle,
                            initialMemoId = pendingMemoDetailId,
                            backHandlingEnabled = backHandlingEnabled,
                            onBack = {
                                pendingMemoDetailId = null
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                            onDismiss = onDismiss,
                            // EMBEDDED / TASK_PANE：宿主已有层，不再套叶子 Modal
                            wrapInModalSheet = wrapInModalSheet,
                        )
                    } else if (appHome.kind == WorkbenchAppHomeKind.TABFILES) {
                        val appTitle = state.apps.firstOrNull { it.id == appHome.kind.appId }?.name
                            ?: appHome.kind.displayName
                        CloudDriveAppHomeScreen(
                            organizationId = organizationId,
                            organizationName = organizationName,
                            appTitle = appTitle,
                            backHandlingEnabled = backHandlingEnabled,
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                            onDismiss = onDismiss,
                            wrapInModalSheet = wrapInModalSheet,
                            onOpenWebResource = { request ->
                                appHomeNav.showDetail(
                                    WorkbenchResourceOpenRequest(
                                        resourceType = request.resourceType,
                                        resourceId = request.resourceId,
                                        title = request.title,
                                    ),
                                    kind = WorkbenchAppHomeKind.TABFILES,
                                )
                                appHomeNavTick += 1
                                selectedWebTarget = WorkbenchWebTarget(
                                    resourceType = request.resourceType,
                                    resourceId = request.resourceId,
                                    title = request.title,
                                )
                                webBackKeepsNativeDetail = false
                            },
                            activeConversationSink = activeConversationSink,
                        )
                    } else if (
                        appHome.kind == WorkbenchAppHomeKind.TABDOC ||
                        appHome.kind == WorkbenchAppHomeKind.TABDATA
                    ) {
                        LaunchedEffect(appHome.kind, organizationId) {
                            viewModel.loadSharedAppHomeResources(appHome.kind, organizationId)
                        }
                        val workbenchResources = remember(state.resources, state.sharedAppHomeResources) {
                            mergeWorkbenchResources(state.resources, state.sharedAppHomeResources)
                        }
                        val taskSnapshot = remember(conversationMessages, workbenchResources) {
                            TaskWorkbenchProjector.project(
                                messages = conversationMessages,
                                resources = workbenchResources,
                                agentName = state.agent?.name ?: "Agent",
                            )
                        }
                        val taskTypeResources = remember(taskSnapshot, appHome.kind) {
                            taskSnapshot.outputs
                                .filter { it.resourceType == appHome.kind.appId }
                                .mapNotNull { it.resource }
                        }
                        val libraryResources = state.resources.filter {
                            it.normalizedType == appHome.kind.appId
                        }
                        val sharedLibraryResources = state.sharedAppHomeResources[appHome.kind.appId].orEmpty()
                        val mergedLibraryResources = remember(libraryResources, sharedLibraryResources) {
                            mergeWorkbenchLibraryResources(libraryResources, sharedLibraryResources)
                        }
                        TaskResourceAppHomeScreen(
                            kind = appHome.kind,
                            organizationName = organizationName,
                            taskResources = taskTypeResources.ifEmpty {
                                // 会话尚未抽出指针时，退回 Space 内同类型资源作为本任务内容
                                mergedLibraryResources
                            },
                            libraryResources = mergedLibraryResources,
                            sharedResourceIds = sharedLibraryResources.mapTo(mutableSetOf()) {
                                it.resourceId
                            },
                            collaborations = state.appHomeCollaborations,
                            isLoading = state.isLoading ||
                                appHome.kind.appId in state.loadingSharedAppHomeTypes,
                            isCreating = state.isCreatingBlank,
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                            onOpenResource = openResourceDetail,
                            onCreateBlank = {
                                viewModel.createBlankTaskResource(appHome.kind, organizationId) { type, id, title ->
                                    openResourceDetail(
                                        SpaceResource(
                                            id = "created:$type:$id",
                                            itemType = type,
                                            resourceId = id,
                                            title = title,
                                            spaceId = scopedSpaceId,
                                            organizationId = organizationId,
                                        ),
                                    )
                                }
                            },
                            onRequestAgent = {
                                val app = state.apps.firstOrNull { it.id == appHome.kind.appId }
                                if (app != null) {
                                    requestAppToComposer(app)
                                } else {
                                    Toast.makeText(
                                        context,
                                        context.getString(
                                            R.string.workbench_request_app_hint,
                                            appHome.kind.displayName,
                                        ),
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                    if (wrapInModalSheet) onDismiss()
                                }
                            },
                            onLoadCollaboration = viewModel::loadAppHomeCollaboration,
                            onDismiss = onDismiss,
                            wrapInModalSheet = wrapInModalSheet,
                        )
                    } else {
                        AppHomePlaceholderSheet(
                            kind = appHome.kind,
                            apps = state.apps,
                            resources = state.resources.filter { it.normalizedType == appHome.kind.appId },
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                            onOpenResource = openResourceDetail,
                            onDismiss = onDismiss,
                            wrapInModalSheet = wrapInModalSheet,
                        )
                    }
                }
            }
            WorkbenchContentLayer.DETAIL -> {
                val detail = pane as? WorkbenchNavigationPane.Detail
                val kind = detail?.kind
                    ?: detail?.request?.normalizedType?.let(WorkbenchAppHomeKind::fromAppId)
                if (detail != null && kind != null) {
                    // 详情层归工作台所有；有 Web 时由同层 WEB 分支接管。
                    if (kind == WorkbenchAppHomeKind.TABFILES &&
                        TaskWorkbenchConversationArtifactPolicy.isOpenableFileRecord(detail.request.resourceId)
                    ) {
                        CloudFileInfoScreen(
                            info = CloudFileInfo(
                                contextItemId = "",
                                organizationId = organizationId,
                                resourceId = detail.request.resourceId,
                                spaceId = scopedSpaceId,
                                spaceName = detail.request.locationHint,
                                fileName = detail.request.title ?: "文件",
                                preview = null,
                                mimeType = null,
                                typeLabel = "文件",
                                fileSizeBytes = null,
                            ),
                            organizationId = organizationId,
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                        )
                    } else if (kind == WorkbenchAppHomeKind.TABDOC || kind == WorkbenchAppHomeKind.TABDATA) {
                        WorkbenchNativeResourceHost(
                            request = detail.request,
                            organizationId = organizationId,
                            spaceId = scopedSpaceId,
                            backHandlingEnabled = backHandlingEnabled,
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                                reportedViewId = null
                                reportedViewResourceId = null
                            },
                            onOpenFullEditor = { request ->
                                selectedWebTarget = WorkbenchWebTarget(
                                    resourceType = request.normalizedType,
                                    resourceId = request.resourceId,
                                    title = request.title ?: kind.displayName,
                                )
                                webBackKeepsNativeDetail = true
                            },
                            onFocusChanged = { tableId, viewId ->
                                reportedViewResourceId = tableId
                                reportedViewId = viewId
                            },
                        )
                    } else {
                        AppHomePlaceholderSheet(
                            kind = kind,
                            apps = state.apps,
                            resources = state.resources.filter { it.normalizedType == kind.appId },
                            onBack = {
                                appHomeNav.goBack()
                                appHomeNavTick += 1
                            },
                            onOpenResource = { res ->
                                openResourceDetail(res)
                            },
                            onDismiss = onDismiss,
                            wrapInModalSheet = wrapInModalSheet,
                        )
                    }
                }
            }
            WorkbenchContentLayer.OVERVIEW -> {
                val overviewModifier = if (wrapInModalSheet) {
                    Modifier.padding(top = TTSpacing.lg, bottom = TTSpacing.xxxl)
                } else {
                    Modifier
                        .fillMaxSize()
                        .padding(top = TTSpacing.lg, bottom = TTSpacing.xxxl)
                }
                LaunchedEffect(organizationId) {
                    viewModel.loadSharedAppHomeResources(WorkbenchAppHomeKind.TABDOC, organizationId)
                    viewModel.loadSharedAppHomeResources(WorkbenchAppHomeKind.TABDATA, organizationId)
                }
                val workbenchResources = remember(state.resources, state.sharedAppHomeResources) {
                    mergeWorkbenchResources(state.resources, state.sharedAppHomeResources)
                }
                val taskSnapshot = remember(
                    conversationMessages,
                    workbenchResources,
                    selectedWebTarget?.resourceId,
                    state.agent?.name,
                ) {
                    TaskWorkbenchProjector.project(
                        messages = conversationMessages,
                        resources = workbenchResources,
                        currentResourceType = selectedWebTarget?.resourceType,
                        currentResourceId = selectedWebTarget?.resourceId,
                        agentName = state.agent?.name ?: "Agent",
                    )
                }
                val remainingOutputs = remember(taskSnapshot) {
                    val resumeId = taskSnapshot.resumeItem?.id
                    if (resumeId == null) taskSnapshot.outputs
                    else taskSnapshot.outputs.filter { it.id != resumeId }
                }
                val quickStartApps = remember(state.apps) {
                    TaskWorkbenchAppProjector.quickStartApps(state.apps)
                }
                val showsInitialSkeleton = shouldShowWorkbenchDashboardSkeleton(
                    hasOutputs = taskSnapshot.outputs.isNotEmpty(),
                    hasApps = state.apps.isNotEmpty(),
                    isResourceLoading = state.isLoading,
                    isAppCatalogLoading = state.isAppCatalogLoading,
                    hasResourceError = state.error != null,
                    hasAppCatalogError = state.appCatalogError != null,
                )
                val activateApp: (TaskWorkbenchApp) -> Unit = onActivate@{ app ->
                    when (app.activation) {
                        TaskWorkbenchAppActivation.OPEN_APP_HOME -> {
                            val kind = WorkbenchAppHomeKind.fromAppId(app.id)
                                ?: return@onActivate
                            pendingMemoDetailId = null
                            appHomeNav.showAppHome(kind)
                            appHomeNavTick += 1
                        }
                        TaskWorkbenchAppActivation.REQUEST_AGENT -> {
                            requestAppToComposer(app)
                        }
                        TaskWorkbenchAppActivation.UNAVAILABLE -> {
                            openNotice = app.unavailableReason
                                ?: context.getString(
                                    R.string.workbench_request_app_hint,
                                    app.name,
                                )
                        }
                    }
                }
                val openOutput: (TaskWorkbenchOutput) -> Unit = { output ->
                    val res = output.resource
                    if (res != null) {
                        openResourceDetail(res)
                    } else if (
                        SpaceResource.normalizedType(output.resourceType) == "tabfiles" &&
                        TaskWorkbenchConversationArtifactPolicy.isOpenableFileRecord(output.resourceId)
                    ) {
                        appHomeNav.showDetail(output.openRequest, WorkbenchAppHomeKind.TABFILES)
                        appHomeNavTick += 1
                    } else if (resolveWorkbenchResourcePresentation(output.resourceType) ==
                        WorkbenchResourcePresentation.NATIVE_WORKBENCH
                    ) {
                        output.syntheticNativeResource(
                            spaceId = scopedSpaceId,
                            organizationId = organizationId,
                        )?.let(openResourceDetail)
                    } else if (resolveWorkbenchResourcePresentation(output.resourceType) ==
                        WorkbenchResourcePresentation.WEB
                    ) {
                        selectedWebTarget = WorkbenchWebTarget(
                            resourceType = output.resourceType,
                            resourceId = output.resourceId,
                            title = output.title,
                        )
                        webBackKeepsNativeDetail = false
                    }
                }
                val overview: @Composable () -> Unit = {
                    if (showsInitialSkeleton) {
                        WorkbenchDashboardSkeleton(modifier = overviewModifier)
                    } else {
                        LazyColumn(
                            modifier = overviewModifier,
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.xl),
                        ) {
                            openNotice?.let { notice ->
                                item(key = "open_notice") {
                                    ResourceOpenNotice(
                                        message = notice,
                                        modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                    )
                                }
                            }

                            if (scopedSpaceId != null && isStreaming) {
                                item(key = "active_task") {
                                    ActiveTaskSection(modifier = Modifier.padding(horizontal = TTSpacing.lg))
                                }
                            }

                            // 对齐 iOS：继续工作 → 本任务产出 → 开始新的 → 全部应用 → 恢复与安全
                            if (scopedSpaceId != null) {
                                taskSnapshot.resumeItem?.let { resume ->
                                    item(key = "continue_work") {
                                        DashboardSection(
                                            title = stringResource(R.string.workbench_continue_work),
                                            modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                        ) {
                                            ResumeOutputCard(
                                                output = resume,
                                                organizationId = organizationId,
                                                onClick = { openOutput(resume) },
                                            )
                                        }
                                    }
                                }

                                if (taskSnapshot.outputs.isEmpty() || remainingOutputs.isNotEmpty()) {
                                    item(key = "task_outputs") {
                                        DashboardSection(
                                            title = stringResource(R.string.workbench_task_outputs),
                                            trailing = if (remainingOutputs.isEmpty()) {
                                                null
                                            } else {
                                                stringResource(
                                                    R.string.workbench_task_outputs_count,
                                                    remainingOutputs.size,
                                                )
                                            },
                                            modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                        ) {
                                            if (taskSnapshot.outputs.isEmpty()) {
                                                TaskOutputsEmptyState()
                                            } else {
                                                OutputBarsList(
                                                    outputs = remainingOutputs,
                                                    onOpen = openOutput,
                                                )
                                            }
                                        }
                                    }
                                }

                                if (quickStartApps.isNotEmpty()) {
                                    item(key = "start_new") {
                                        DashboardSection(
                                            title = stringResource(R.string.workbench_start_new),
                                            trailing = stringResource(R.string.workbench_start_new_trailing),
                                            modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                        ) {
                                            QuickStartAppsGrid(
                                                apps = quickStartApps,
                                                onRequest = requestAppToComposer,
                                            )
                                        }
                                    }
                                }
                            }

                            item(key = "all_apps") {
                                AllAppsSection(
                                    apps = state.apps,
                                    onActivate = activateApp,
                                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                )
                            }

                            if (scopedSpaceId != null) {
                                item(key = "restore_safety") {
                                    DashboardSection(
                                        title = stringResource(R.string.workbench_restore_safety),
                                        modifier = Modifier.padding(horizontal = TTSpacing.lg),
                                    ) {
                                        CheckpointEmptyState()
                                    }
                                }
                            }
                        }
                    }
                }
                // 仅 MODAL overview 包 TTBottomSheet；非 MODAL 直接嵌入内容区
                if (wrapInModalSheet) {
                    TTBottomSheet(
                        onDismissRequest = onDismiss,
                        sheetState = sheetState,
                    ) {
                        overview()
                    }
                } else {
                    overview()
                }
            }
        }
    }

    // 全屏壳 / 反馈层由 WorkbenchSurface 统一挂；此处只画内容体
    workbenchBody()
}

@Composable
private fun WorkbenchDashboardSkeleton(modifier: Modifier = Modifier) {
    val reduceMotion = rememberReduceMotion()
    val alpha = if (reduceMotion) {
        0.58f
    } else {
        val transition = rememberInfiniteTransition(label = "workbench-skeleton")
        val animatedAlpha by transition.animateFloat(
            initialValue = 0.42f,
            targetValue = 0.72f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 800),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "workbench-skeleton-alpha",
        )
        animatedAlpha
    }
    val skeletonColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = alpha)
    val loadingDescription = stringResource(R.string.common_loading)

    LazyColumn(
        modifier = modifier.clearAndSetSemantics {
            contentDescription = loadingDescription
        },
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xl),
    ) {
        item(key = "skeleton_resume") {
            WorkbenchSkeletonSection(
                color = skeletonColor,
                cardHeight = 96.dp,
                cardCount = 1,
            )
        }
        item(key = "skeleton_outputs") {
            WorkbenchSkeletonSection(
                color = skeletonColor,
                cardHeight = 88.dp,
                cardCount = 2,
            )
        }
        item(key = "skeleton_apps") {
            WorkbenchSkeletonSection(
                color = skeletonColor,
                cardHeight = 112.dp,
                cardCount = 3,
                showsTrailingLine = true,
            )
        }
    }
}

@Composable
private fun WorkbenchSkeletonSection(
    color: Color,
    cardHeight: androidx.compose.ui.unit.Dp,
    cardCount: Int,
    showsTrailingLine: Boolean = false,
) {
    Column(
        modifier = Modifier.padding(horizontal = TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WorkbenchSkeletonBlock(
                color = color,
                modifier = Modifier.size(width = 88.dp, height = 14.dp),
            )
            if (showsTrailingLine) {
                WorkbenchSkeletonBlock(
                    color = color,
                    modifier = Modifier.size(width = 52.dp, height = 12.dp),
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            repeat(cardCount) {
                WorkbenchSkeletonBlock(
                    color = color,
                    modifier = Modifier
                        .weight(1f)
                        .height(cardHeight),
                    radius = TTRadius.md,
                )
            }
        }
    }
}

@Composable
private fun WorkbenchSkeletonBlock(
    color: Color,
    modifier: Modifier = Modifier,
    radius: androidx.compose.ui.unit.Dp = TTRadius.full,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(radius))
            .background(color),
    )
}

/**
 * 「全部应用」：对齐 Electron DesktopHomePane / demo 紧凑磁贴。
 * 仅 icon + 中文 title，无描述 / 最近活动 /「进入·交给 Agent」CTA；约 3 列。
 */
@Composable
private fun AllAppsSection(
    apps: List<TaskWorkbenchApp>,
    onActivate: (TaskWorkbenchApp) -> Unit,
    modifier: Modifier = Modifier,
) {
    val sections = remember(apps) { TaskWorkbenchAppProjector.sections(apps) }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionHeader(title = stringResource(R.string.workbench_app_homes), icon = "▦")
            Text(
                text = stringResource(R.string.workbench_apps_count, apps.size),
                style = TTFonts.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }
        sections.forEach { section ->
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(
                    text = section.title,
                    style = TTFonts.captionMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                CompactAppGrid(
                    apps = section.apps,
                    onActivate = onActivate,
                )
            }
        }
    }
}

@Composable
private fun CompactAppGrid(
    apps: List<TaskWorkbenchApp>,
    onActivate: (TaskWorkbenchApp) -> Unit,
) {
    val columns = 3
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        apps.chunked(columns).forEach { rowApps ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                rowApps.forEach { app ->
                    CompactAppTile(
                        app = app,
                        onClick = { onActivate(app) },
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(columns - rowApps.size) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CompactAppTile(
    app: TaskWorkbenchApp,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(TTRadius.md)
    Column(
        modifier = modifier
            .heightIn(min = 112.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .border(
                width = 0.5.dp,
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                shape = shape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.md),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // 有白底完整品牌 icon（磁贴）
        TabTinAppIcon(
            appId = app.id,
            variant = TabTinAppIconVariant.APP,
            size = 48.dp,
        )
        Spacer(modifier = Modifier.height(TTSpacing.sm))
        Text(
            text = app.name,
            style = TTFonts.meta,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun DashboardSection(
    title: String,
    trailing: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            if (trailing != null) {
                Text(
                    text = trailing,
                    style = TTFonts.captionMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
        }
        content()
    }
}

@Composable
private fun ResumeOutputCard(
    output: TaskWorkbenchOutput,
    organizationId: String,
    onClick: () -> Unit,
) {
    if (TaskWorkbenchFilePresentation.category(output) != null) {
        CloudDriveFileViewportCard(
            row = TaskWorkbenchFilePresentation.viewportRow(output, organizationId),
            onClick = onClick,
            enabled = output.canOpen,
        )
        return
    }
    val kind = TaskWorkbenchContinueWindowPolicy.homeKind(output.resourceType)
    if (kind == null) {
        OutputCard(output = output, onClick = onClick, modifier = Modifier.fillMaxWidth())
        return
    }
    val isDarkTheme = LocalTTDarkTheme.current
    val colorScheme = MaterialTheme.colorScheme
    val palette = remember(kind, isDarkTheme, colorScheme) {
        AppHomePalette.forKind(kind, colorScheme, isDarkTheme)
    }
    ContinueResourceCard(
        kind = kind,
        item = TaskWorkbenchContinueWindowPolicy.resource(output),
        palette = palette,
        collaboration = TaskResourceCollaborationState.Idle,
        originText = stringResource(R.string.workbench_apphome_resume_task),
        onClick = onClick,
        enabled = output.canOpen,
    )
}

@Composable
private fun OutputBarsList(
    outputs: List<TaskWorkbenchOutput>,
    onOpen: (TaskWorkbenchOutput) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val visible = TaskWorkbenchOutputListPolicy.visible(outputs, expanded)
    val hiddenCount = TaskWorkbenchOutputListPolicy.hiddenCount(outputs.size, expanded)
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        visible.forEach { output ->
            OutputCard(
                output = output,
                onClick = { onOpen(output) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (
            hiddenCount > 0 ||
            (expanded && outputs.size > TaskWorkbenchOutputListPolicy.COLLAPSED_VISIBLE_COUNT)
        ) {
            TextButton(
                onClick = { expanded = !expanded },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = if (expanded) {
                        stringResource(R.string.workbench_task_outputs_show_less)
                    } else {
                        stringResource(R.string.workbench_task_outputs_show_more, hiddenCount)
                    },
                    style = TTFonts.captionMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun OutputCard(
    output: TaskWorkbenchOutput,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(TTRadius.sm)
    val fileCategory = TaskWorkbenchFilePresentation.category(output)
    val typeLabel = when {
        !output.canOpen -> stringResource(R.string.workbench_output_sync_pending)
        fileCategory != null -> cloudDriveCategoryLabel(fileCategory)
        else -> output.typeLabel
    }
    val relative = relativeTimestampLabel(output.timestampMs)
    val subtitle = if (relative.isNotEmpty()) "$typeLabel · $relative" else typeLabel
    Row(
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .border(
                width = 0.5.dp,
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                shape = shape,
            )
            .clickable(enabled = output.canOpen, onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        if (fileCategory != null) {
            CloudDriveResourceArtwork(category = fileCategory, size = 20.dp)
        } else {
            TabTinAppIcon(
                appId = output.resourceType,
                variant = TabTinAppIconVariant.GLYPH,
                size = 20.dp,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = output.title,
                style = TTFonts.meta,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = TTFonts.captionMedium,
                color = if (output.canOpen) {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                } else {
                    MaterialTheme.colorScheme.error
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = if (output.canOpen) {
                Icons.AutoMirrored.Filled.KeyboardArrowRight
            } else {
                Icons.Default.Sync
            },
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun QuickStartAppsGrid(
    apps: List<TaskWorkbenchApp>,
    onRequest: (TaskWorkbenchApp) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        apps.chunked(2).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                row.forEach { app ->
                    QuickStartAppTile(
                        app = app,
                        onClick = { onRequest(app) },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (row.size == 1) Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun QuickStartAppTile(
    app: TaskWorkbenchApp,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(TTRadius.md)
    Row(
        modifier = modifier
            .heightIn(min = 64.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .border(
                width = 0.5.dp,
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                shape = shape,
            )
            .clickable(onClick = onClick)
            .padding(TTSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabTinAppIcon(
            appId = app.id,
            variant = TabTinAppIconVariant.GLYPH,
            size = 34.dp,
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
        ) {
            Text(
                text = app.name,
                style = TTFonts.metaSemibold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(R.string.workbench_quick_start_agent),
                style = TTFonts.captionMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            imageVector = Icons.Default.Add,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun TaskOutputsEmptyState() {
    val shape = RoundedCornerShape(TTRadius.md)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f))
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
    ) {
        Text(
            text = stringResource(R.string.workbench_task_outputs_empty_title),
            style = TTFonts.meta,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringResource(R.string.workbench_task_outputs_empty_body),
            style = TTFonts.meta,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun CheckpointEmptyState() {
    val shape = RoundedCornerShape(TTRadius.md)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f))
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
    ) {
        Text(
            text = stringResource(R.string.workbench_checkpoint_empty_title),
            style = TTFonts.meta,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringResource(R.string.workbench_checkpoint_empty_body),
            style = TTFonts.meta,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun relativeTimestampLabel(timestampMs: Long): String {
    if (timestampMs <= 0L) return ""
    return try {
        val instant = Instant.ofEpochMilli(timestampMs)
        val minutes = Duration.between(instant, Instant.now()).toMinutes()
        when {
            minutes < 1 -> "刚刚"
            minutes < 60 -> "${minutes}分钟前"
            minutes < 1440 -> "${minutes / 60}小时前"
            minutes < 2880 -> "昨天"
            else -> {
                val date = instant.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                "${date.monthValue}/${date.dayOfMonth}"
            }
        }
    } catch (_: Exception) {
        ""
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppHomePlaceholderSheet(
    kind: WorkbenchAppHomeKind,
    apps: List<TaskWorkbenchApp>,
    resources: List<SpaceResource>,
    onBack: () -> Unit,
    onOpenResource: (SpaceResource) -> Unit,
    onDismiss: () -> Unit,
    wrapInModalSheet: Boolean = true,
) {
    val title = apps.firstOrNull { it.id == kind.appId }?.name ?: kind.displayName
    val body: @Composable () -> Unit = {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            TextButton(onClick = onBack) {
                Text(stringResource(R.string.workbench_back_to_overview))
            }
            Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            when (kind) {
                WorkbenchAppHomeKind.TABMEMO -> {
                    Text(
                        stringResource(R.string.workbench_memo_home_placeholder),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                WorkbenchAppHomeKind.TABFILES -> {
                    Text(
                        stringResource(R.string.workbench_files_home_placeholder),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                WorkbenchAppHomeKind.TABDOC, WorkbenchAppHomeKind.TABDATA -> {
                    if (resources.isEmpty()) {
                        Text(
                            stringResource(R.string.workbench_app_home_empty, title),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        resources.forEach { res ->
                            Text(
                                text = res.displayTitle,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenResource(res) }
                                    .padding(vertical = TTSpacing.sm),
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
    // R2-5：EMBEDDED / 宿主已有 Modal 时不再嵌套第二层底部抽屉
    if (wrapInModalSheet) {
        val sheetState = rememberTTSheetState(skipPartiallyExpanded = false)
        TTBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
        ) {
            body()
        }
    } else {
        body()
    }
}

// endregion

// region — Quick Actions

@Composable
private fun QuickActionsSection(
    isCreating: Boolean,
    onCreateDoc: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier) {
        SectionHeader(title = stringResource(R.string.workbench_quick_actions), icon = "⚡")
        Spacer(Modifier.height(TTSpacing.sm))
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            QuickActionButton(
                label = stringResource(R.string.workbench_new_document),
                emoji = "📄",
                isLoading = isCreating,
                onClick = onCreateDoc,
            )
        }
    }
}

@Composable
private fun QuickActionButton(label: String, emoji: String, isLoading: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(enabled = !isLoading, onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
        } else {
            Text(emoji, style = TTFonts.iconBody)
        }
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

// endregion

// region — Active Task

@Composable
private fun ActiveTaskSection(modifier: Modifier = Modifier) {
    SectionHeader(title = stringResource(R.string.workbench_active_task), icon = "⚡", modifier = modifier)
    Spacer(Modifier.height(TTSpacing.sm))
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f))
            .padding(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        Text(stringResource(R.string.workbench_agent_running), style = MaterialTheme.typography.bodyMedium)
    }
}

// endregion

@Composable
private fun ResourceOpenNotice(message: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(TTSpacing.md),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text("ℹ", style = TTFonts.iconBody)
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// region — Pinned Resources

@Composable
private fun PinnedResourcesSection(
    resources: List<SpaceResource>,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onTogglePin: (SpaceResource) -> Unit,
) {
    Column {
        SectionHeader(
            title = stringResource(R.string.workbench_pinned),
            icon = "📌",
            modifier = Modifier.padding(horizontal = TTSpacing.lg),
        )
        Spacer(Modifier.height(TTSpacing.sm))
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = TTSpacing.lg),
        ) {
            items(resources, key = { it.id }) { resource ->
                PinnedResourceCard(
                    resource = resource,
                    onDelegateToAgent = { onDelegateToAgent(resource) },
                    onTogglePin = { onTogglePin(resource) },
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PinnedResourceCard(
    resource: SpaceResource,
    onDelegateToAgent: () -> Unit,
    onTogglePin: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    val pinLabel = if (resource.isPinned == true) {
        stringResource(R.string.workbench_unpin)
    } else {
        stringResource(R.string.workbench_pin)
    }

    Box {
        Column(
            modifier = Modifier
                .width(120.dp)
                .clip(RoundedCornerShape(TTRadius.sm))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .combinedClickable(
                    onClick = { onDelegateToAgent() },
                    onLongClick = { showMenu = true },
                )
                .padding(TTSpacing.md),
        ) {
            TabTinAppIcon(
                appId = resource.normalizedType,
                variant = TabTinAppIconVariant.GLYPH,
                size = 28.dp,
            )
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                text = resource.displayTitle,
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = resource.typeLabel,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.workbench_delegate_to_agent)) },
                onClick = { showMenu = false; onDelegateToAgent() },
            )
            DropdownMenuItem(
                text = { Text(pinLabel) },
                onClick = { showMenu = false; onTogglePin() },
            )
        }
    }
}

// endregion

// region — Resource Browser

@Composable
private fun ResourceBrowserSection(
    tabs: List<WorkbenchTab>,
    selectedTab: WorkbenchTab,
    resources: List<SpaceResource>,
    isLoading: Boolean,
    error: String?,
    onTabSelected: (WorkbenchTab) -> Unit,
    onRetry: () -> Unit,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onTogglePin: (SpaceResource) -> Unit,
    onResourceOpen: (SpaceResource) -> Unit = {},
) {
    val showsInitialSkeleton = shouldShowWorkbenchResourceListSkeleton(
        hasResources = resources.isNotEmpty(),
        isLoading = isLoading,
        hasError = error != null,
    )
    Column(modifier = Modifier.padding(horizontal = TTSpacing.lg)) {
        SectionHeader(title = stringResource(R.string.workbench_resources), icon = "📁")
        Spacer(Modifier.height(TTSpacing.sm))

        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            tabs.forEach { tab ->
                TabChip(
                    label = tab.localizedLabel(),
                    isSelected = tab == selectedTab,
                    onClick = { onTabSelected(tab) },
                )
            }
        }

        Spacer(Modifier.height(TTSpacing.md))

        when {
            error != null -> {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xxl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(TTSpacing.sm))
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
                }
            }
            showsInitialSkeleton -> {
                WorkbenchResourceListSkeleton()
            }
            resources.isEmpty() -> {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xxl),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        stringResource(R.string.workbench_no_resources),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    resources.forEach { resource ->
                        ResourceRow(
                            resource = resource,
                            onClick = { onResourceOpen(resource) },
                            onDelegateToAgent = { onDelegateToAgent(resource) },
                            onTogglePin = { onTogglePin(resource) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkbenchResourceListSkeleton() {
    val reduceMotion = rememberReduceMotion()
    val alpha = if (reduceMotion) {
        0.58f
    } else {
        val transition = rememberInfiniteTransition(label = "workbench-resource-list-skeleton")
        val animatedAlpha by transition.animateFloat(
            initialValue = 0.42f,
            targetValue = 0.72f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 800),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "workbench-resource-list-skeleton-alpha",
        )
        animatedAlpha
    }
    val skeletonColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = alpha)
    val loadingDescription = stringResource(R.string.common_loading)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = loadingDescription },
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        repeat(3) { index ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(TTRadius.md))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.32f))
                    .padding(TTSpacing.md),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WorkbenchSkeletonBlock(
                    color = skeletonColor,
                    modifier = Modifier.size(32.dp),
                    radius = TTRadius.sm,
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    WorkbenchSkeletonBlock(
                        color = skeletonColor,
                        modifier = Modifier
                            .fillMaxWidth(if (index == 1) 0.72f else 0.9f)
                            .height(12.dp),
                    )
                    WorkbenchSkeletonBlock(
                        color = skeletonColor,
                        modifier = Modifier
                            .fillMaxWidth(0.56f)
                            .height(10.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ResourceRow(
    resource: SpaceResource,
    onClick: () -> Unit = {},
    onDelegateToAgent: () -> Unit,
    onTogglePin: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    val pinLabel = if (resource.isPinned == true) {
        stringResource(R.string.workbench_unpin)
    } else {
        stringResource(R.string.workbench_pin)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
            .clickable(onClick = onClick)
            .padding(start = TTSpacing.sm, top = TTSpacing.xs, bottom = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(TTRadius.xs))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            TabTinAppIcon(
                appId = resource.normalizedType,
                variant = TabTinAppIconVariant.GLYPH,
                size = 24.dp,
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = resource.displayTitle,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    text = resource.typeLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (resource.isPinned == true) {
            Icon(
                Icons.Default.PushPin,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(TTSpacing.xs))
        }

        IconButton(
            onClick = onDelegateToAgent,
            modifier = Modifier.size(40.dp),
        ) {
            Icon(
                Icons.Default.ChatBubbleOutline,
                contentDescription = stringResource(R.string.workbench_share_to_chat),
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.7f),
            )
        }

        Box {
            IconButton(
                onClick = { showMenu = true },
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    Icons.Default.MoreVert,
                    contentDescription = stringResource(R.string.workbench_more),
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workbench_delegate_to_agent)) },
                    onClick = { showMenu = false; onDelegateToAgent() },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(pinLabel) },
                    onClick = { showMenu = false; onTogglePin() },
                )
            }
        }
    }
}

// endregion

// region — Common Components

@Composable
private fun SectionHeader(title: String, icon: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(icon, style = TTFonts.iconBody)
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun TabChip(label: String, isSelected: Boolean, onClick: () -> Unit) {
    val bg = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
    val fg = if (isSelected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant

    Text(
        text = label,
        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
        color = fg,
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.full))
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs + TTSpacing.xxs),
    )
}

@Composable
private fun WorkbenchTab.localizedLabel(): String = when (this) {
    WorkbenchTab.RECENT -> stringResource(R.string.workbench_tab_recent)
    WorkbenchTab.TABDATA -> stringResource(R.string.workbench_tab_tabdata)
    WorkbenchTab.TABDOC -> stringResource(R.string.workbench_tab_tabdoc)
    WorkbenchTab.TABSLIDE -> stringResource(R.string.workbench_tab_tabslide)
    WorkbenchTab.TABSITE -> stringResource(R.string.workbench_tab_tabsite)
    WorkbenchTab.TABTRACKER -> stringResource(R.string.workbench_tab_tabtracker)
}

// endregion
