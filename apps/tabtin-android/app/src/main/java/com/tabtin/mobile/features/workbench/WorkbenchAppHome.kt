package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.SpaceResource
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 任务工作台 App 首页导航：overview → appHome(kind) → detail。
 * 与 iOS `WorkbenchNavigationState.appHome + path` 同构；详情返回落回原 App 首页。
 */
public enum class WorkbenchAppHomeKind(public val appId: String, public val displayName: String) {
    TABDOC("tabdoc", "文档"),
    TABDATA("tabdata", "多维表"),
    TABMEMO("tabmemo", "笔记"),
    TABFILES("tabfiles", "云盘"),
    ;

    public companion object {
        public fun fromAppId(raw: String): WorkbenchAppHomeKind? {
            val id = raw.trim().lowercase()
            return entries.firstOrNull { it.appId == id }
        }
    }
}

public sealed class WorkbenchNavigationPane {
    public data object Overview : WorkbenchNavigationPane()
    public data class AppHome(val kind: WorkbenchAppHomeKind) : WorkbenchNavigationPane()
    public data class Detail(
        val kind: WorkbenchAppHomeKind?,
        val request: WorkbenchResourceOpenRequest,
    ) : WorkbenchNavigationPane()
}

/** 纯值导航状态，便于单测；不依赖 Compose / ViewModel 生命周期。 */
public class WorkbenchAppHomeNavigationState {
    public var pane: WorkbenchNavigationPane = WorkbenchNavigationPane.Overview
        private set

    public fun resetForScopeChange() {
        pane = WorkbenchNavigationPane.Overview
    }

    public fun showAppHome(kind: WorkbenchAppHomeKind) {
        pane = WorkbenchNavigationPane.AppHome(kind)
    }

    public fun showDetail(request: WorkbenchResourceOpenRequest, kind: WorkbenchAppHomeKind? = null) {
        val resolvedKind = kind
            ?: WorkbenchAppHomeKind.fromAppId(request.normalizedType)
        pane = WorkbenchNavigationPane.Detail(kind = resolvedKind, request = request)
    }

    /** 会话卡片 / 工作台 overview 直达详情，返回应落回 overview，而不是凭资源类型猜 App 首页。 */
    public fun showDirectDetail(request: WorkbenchResourceOpenRequest) {
        pane = WorkbenchNavigationPane.Detail(kind = null, request = request)
    }

    /** 详情 → App 首页 → 工作台 overview。 */
    public fun goBack(): Boolean {
        return when (val current = pane) {
            is WorkbenchNavigationPane.Detail -> {
                pane = current.kind?.let { WorkbenchNavigationPane.AppHome(it) }
                    ?: WorkbenchNavigationPane.Overview
                true
            }
            is WorkbenchNavigationPane.AppHome -> {
                pane = WorkbenchNavigationPane.Overview
                true
            }
            WorkbenchNavigationPane.Overview -> false
        }
    }

    public fun closeAppHome() {
        if (pane is WorkbenchNavigationPane.AppHome || pane is WorkbenchNavigationPane.Detail) {
            pane = WorkbenchNavigationPane.Overview
        }
    }
}

@Serializable
public data class TaskWorkbenchCatalogResponse(
    val apps: List<TaskWorkbenchCatalogApp> = emptyList(),
)

@Serializable
public data class TaskWorkbenchCatalogApp(
    val id: String,
    val name: String,
    val icon: String = "",
    val description: String = "",
    val surface: String? = null,
    val installed: Boolean? = null,
    val order: Int = 0,
    @SerialName("mobile_mode") val mobileMode: String? = null,
)

@Serializable
public data class TaskWorkbenchWorkspaceAppsResponse(
    val apps: List<TaskWorkbenchWorkspaceApp> = emptyList(),
)

@Serializable
public data class TaskWorkbenchWorkspaceApp(
    val id: String,
    val name: String,
    val icon: String = "",
    @SerialName("can_create") val canCreate: Boolean = false,
    val enabled: Boolean = true,
    val order: Int = 0,
    @SerialName("desktop_group") val desktopGroup: String = "",
    val surface: String? = null,
)

public enum class TaskWorkbenchAppActivation {
    OPEN_APP_HOME,
    REQUEST_AGENT,
    UNAVAILABLE,
}

/** catalog `surface` 分组，对齐 iOS `TaskWorkbenchAppSurface`。 */
public enum class TaskWorkbenchAppSurface(public val raw: String, public val title: String) {
    COLLABORATIVE("collaborative", "协作应用"),
    BUILTIN("builtin", "内置能力"),
    LOCAL("local", "本机扩展"),
    ;

    public companion object {
        public fun fromRaw(raw: String?): TaskWorkbenchAppSurface? {
            val key = raw?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            return entries.firstOrNull { it.raw == key }
        }
    }
}

/**
 * 工作台 / 应用目录展示名：对齐 Electron `appName.*`，demo 优先
 *（Tables→多维表、Docs→文档、Scheduled Tasks→定时任务）。
 */
public object TaskWorkbenchAppDisplayName {
    private val titles = mapOf(
        "tabdoc" to "文档",
        "tabdata" to "多维表",
        "tabslide" to "演示",
        "tabvideo" to "视频",
        "tabwhiteboard" to "白板",
        "tabmemo" to "笔记",
        "tabsite" to "站点",
        "tabfolder" to "本地目录",
        "tabfiles" to "云盘",
        "tabcode" to "代码",
        "tabweb" to "浏览器",
        "tabdesktop" to "桌面",
        "orchestration" to "Agent",
        "tabphone" to "安卓手机",
        "terminal" to "终端",
        // demo：Scheduled Tasks → 定时任务（Electron/iOS 文案为「自动化」）
        "tabtracker" to "定时任务",
        "tabinbox" to "入口中心",
        "tabmail" to "邮箱",
        "marketplace" to "市场",
        "skill" to "Skill",
        "tins" to "Tins",
    )

    public fun resolve(appId: String, fallback: String): String {
        val key = appId.trim().lowercase()
        titles[key]?.let { return it }
        val trimmed = fallback.trim()
        return trimmed.ifEmpty { appId }
    }
}

public data class TaskWorkbenchApp(
    val id: String,
    val name: String,
    val icon: String = "",
    val surface: TaskWorkbenchAppSurface,
    val installed: Boolean,
    val workspaceAvailable: Boolean?,
    val enabled: Boolean?,
    val canCreate: Boolean,
    val order: Int,
    val resourceCount: Int,
    val mobileMode: String?,
    val activation: TaskWorkbenchAppActivation,
    val unavailableReason: String? = null,
) {
    val actionLabel: String
        get() = when (activation) {
            TaskWorkbenchAppActivation.OPEN_APP_HOME ->
                if (resourceCount > 0) "进入 · $resourceCount 项" else "进入"
            TaskWorkbenchAppActivation.REQUEST_AGENT ->
                if (canCreate) "让 Agent 新建" else "交给 Agent"
            TaskWorkbenchAppActivation.UNAVAILABLE -> when {
                !installed -> "未安装"
                workspaceAvailable == null -> "状态未知"
                enabled == false -> "未启用"
                else -> "暂不支持"
            }
        }

    val agentRequestPrompt: String
        get() = if (canCreate) {
            "请在当前任务中使用 $name 开始一项新的工作。"
        } else {
            "请在当前任务中使用 $name 处理接下来的工作。"
        }
}

public data class TaskWorkbenchAppSection(
    val surface: TaskWorkbenchAppSurface,
    val apps: List<TaskWorkbenchApp>,
) {
    val title: String get() = surface.title
}

public object TaskWorkbenchMobileRuntime {
    public fun normalized(mode: String?): String? =
        mode?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

    public fun isBlocked(mode: String?): Boolean =
        normalized(mode) in setOf("unsupported", "unavailable")

    /**
     * full → 可进 App 首页。
     *
     * 未声明（null）是过渡 shim：仅兼容尚未在 manifest 声明 mobile 的 tabdoc/tabdata，
     * 通过 [WorkbenchAppHomeKind] 放行。Memo/Files 必须以已提交的
     * `runtimeSupport.mobile.mode=full` 为准，不要依赖本 shim。
     */
    public fun allowsAppHome(mode: String?, appId: String): Boolean {
        val normalized = normalized(mode)
        if (normalized != null) return normalized == "full"
        return WorkbenchAppHomeKind.fromAppId(appId) != null
    }
}

public object TaskWorkbenchAppVisibility {
    private val hiddenAppIds = setOf(
        "tabsite", "tabslide", "tins", "tabwhiteboard", "tabvideo", "tabphone", "tabmail",
        "orchestration", "tabinbox", "tabdesktop",
        // 对标 Electron DESKTOP_APPS_EXCLUDED_IDS：工作台总览不露 tabmemo 磁贴；
        // MemoAppHome / deep link 仍由 WorkbenchAppHomeKind.TABMEMO 承载。
        "tabmemo",
    )

    public fun isHidden(appId: String): Boolean =
        appId.trim().lowercase() in hiddenAppIds
}

public object TaskWorkbenchAppProjector {
    public fun project(
        catalog: List<TaskWorkbenchCatalogApp>,
        workspaceApps: List<TaskWorkbenchWorkspaceApp>?,
        resources: List<SpaceResource>,
    ): List<TaskWorkbenchApp> {
        val workspaceById = (workspaceApps ?: emptyList())
            .associateBy { it.id.trim().lowercase() }
        val resourceCountByType = resources.groupingBy { it.normalizedType }.eachCount()
        val workspaceStatusKnown = workspaceApps != null

        return catalog.mapNotNull { item ->
            val appId = item.id.trim().lowercase()
            val declaredSurface = TaskWorkbenchAppSurface.fromRaw(item.surface) ?: return@mapNotNull null
            val surface = mobileSurface(appId, declaredSurface)
            if (TaskWorkbenchAppVisibility.isHidden(appId)) return@mapNotNull null
            // mobile unsupported / unavailable：工作台不露死入口（含「本机扩展」里的
            // cowart / Simple Todo 等 marketplace 样板），避免灰磁贴占位。
            if (TaskWorkbenchMobileRuntime.isBlocked(item.mobileMode)) return@mapNotNull null
            val workspaceApp = workspaceById[appId]
            val installed = item.installed ?: (workspaceApp != null)
            val workspaceAvailable = if (workspaceStatusKnown) workspaceApp != null else null
            val enabled = workspaceApp?.enabled
            val canCreate = workspaceApp?.canCreate ?: false
            val resourceCount = resourceCountByType[appId] ?: 0
            val name = TaskWorkbenchAppDisplayName.resolve(
                appId,
                workspaceApp?.name ?: item.name,
            )
            val (activation, reason) = resolveActivation(
                name = name,
                installed = installed,
                workspaceAvailable = workspaceAvailable,
                enabled = enabled,
                mobileMode = item.mobileMode,
                appId = appId,
            )
            TaskWorkbenchApp(
                id = appId,
                name = name,
                icon = workspaceApp?.icon?.takeIf { it.isNotBlank() } ?: item.icon,
                surface = surface,
                installed = installed,
                workspaceAvailable = workspaceAvailable,
                enabled = enabled,
                canCreate = canCreate,
                order = workspaceApp?.order ?: item.order,
                resourceCount = resourceCount,
                mobileMode = item.mobileMode,
                activation = activation,
                unavailableReason = reason,
            )
        }.sortedWith(compareBy({ it.order }, { it.name.lowercase() }, { it.id }))
    }

    public fun sections(from: List<TaskWorkbenchApp>): List<TaskWorkbenchAppSection> =
        TaskWorkbenchAppSurface.entries.mapNotNull { surface ->
            val apps = from.filter { it.surface == surface }
                .sortedWith(compareBy({ it.order }, { it.name.lowercase() }, { it.id }))
            if (apps.isEmpty()) null else TaskWorkbenchAppSection(surface, apps)
        }

    /** 自动化属于系统执行能力，不占用“拥有独立资源首页”的协作应用分组。 */
    private fun mobileSurface(
        appId: String,
        declared: TaskWorkbenchAppSurface,
    ): TaskWorkbenchAppSurface =
        if (appId == "tabtracker") TaskWorkbenchAppSurface.BUILTIN else declared

    /** 「开始新的」：可创建且可用的 App，对齐 iOS `quickStartApps`。 */
    public fun quickStartApps(from: List<TaskWorkbenchApp>, limit: Int = 4): List<TaskWorkbenchApp> =
        from
            .filter {
                it.installed &&
                    it.workspaceAvailable != false &&
                    it.enabled != false &&
                    it.canCreate
            }
            .sortedWith(compareBy({ it.order }, { it.name.lowercase() }, { it.id }))
            .take(limit.coerceAtLeast(0))

    private fun resolveActivation(
        name: String,
        installed: Boolean,
        workspaceAvailable: Boolean?,
        enabled: Boolean?,
        mobileMode: String?,
        appId: String,
    ): Pair<TaskWorkbenchAppActivation, String?> {
        if (!installed) {
            return TaskWorkbenchAppActivation.UNAVAILABLE to
                "“$name”尚未安装到当前组织，请先在桌面端的应用市场完成安装。"
        }
        if (workspaceAvailable == null) {
            return TaskWorkbenchAppActivation.UNAVAILABLE to
                "应用状态暂不可确认，请重试后再使用“$name”。"
        }
        if (!workspaceAvailable) {
            return TaskWorkbenchAppActivation.UNAVAILABLE to
                "当前 Workspace 的执行设备暂不支持“$name”。"
        }
        if (enabled == false) {
            return TaskWorkbenchAppActivation.UNAVAILABLE to
                "“$name”已在当前 Workspace 停用，请先在桌面端启用。"
        }
        if (TaskWorkbenchMobileRuntime.isBlocked(mobileMode)) {
            return TaskWorkbenchAppActivation.UNAVAILABLE to "“$name”暂未在移动端开放。"
        }
        // undeclared mobile_mode shim：见 TaskWorkbenchMobileRuntime.allowsAppHome。
        return if (TaskWorkbenchMobileRuntime.allowsAppHome(mobileMode, appId)) {
            TaskWorkbenchAppActivation.OPEN_APP_HOME to null
        } else {
            TaskWorkbenchAppActivation.REQUEST_AGENT to null
        }
    }
}

/**
 * deep link / 通知 / Workbench 共用的资源打开解析。
 * 不把未知类型丢进只能承载 tabsite/web 的通用壳。
 */
public sealed class WorkbenchOpenDestination {
    public data class CloudDocs(val request: WorkbenchResourceOpenRequest) : WorkbenchOpenDestination()
    public data class AppHome(val kind: WorkbenchAppHomeKind) : WorkbenchOpenDestination()
    public data class WorkbenchDetail(val request: WorkbenchResourceOpenRequest) : WorkbenchOpenDestination()
    public data class Unsupported(val notice: String) : WorkbenchOpenDestination()
}

public object WorkbenchRouteResolver {
    private val cloudDocsTypes = setOf("tabdoc", "tabdata")
    private val workbenchDetailTypes = setOf("tabslide", "tabsite", "tabtracker")

    public fun resolve(
        resourceType: String,
        resourceId: String,
        title: String? = null,
        locationHint: String? = null,
        preferAppHomeWhenEmptyResource: Boolean = false,
    ): WorkbenchOpenDestination {
        val normalized = SpaceResource.normalizedType(resourceType)
        val request = WorkbenchResourceOpenRequest(
            resourceType = normalized,
            resourceId = resourceId,
            title = title,
            locationHint = locationHint,
        )
        WorkbenchAppHomeKind.fromAppId(normalized)?.let { kind ->
            if (preferAppHomeWhenEmptyResource && resourceId.isBlank()) {
                return WorkbenchOpenDestination.AppHome(kind)
            }
            if (kind == WorkbenchAppHomeKind.TABMEMO || kind == WorkbenchAppHomeKind.TABFILES) {
                // Memo / 云盘：有资源 → Detail（kind 非空，goBack 落回 App 首页）；
                // 无资源 → App 首页。deep link / Cloud Tab / Workbench 共用本解析。
                return if (resourceId.isBlank()) {
                    WorkbenchOpenDestination.AppHome(kind)
                } else {
                    WorkbenchOpenDestination.WorkbenchDetail(request)
                }
            }
        }
        if (normalized in cloudDocsTypes) {
            return WorkbenchOpenDestination.CloudDocs(request)
        }
        if (normalized in workbenchDetailTypes) {
            return WorkbenchOpenDestination.WorkbenchDetail(request)
        }
        return WorkbenchOpenDestination.Unsupported(request.unsupportedOpenNotice)
    }
}
