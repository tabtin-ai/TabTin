import Foundation
import os

struct TaskWorkbenchCatalogResponse: Decodable, Sendable {
    let apps: [TaskWorkbenchCatalogApp]
}

struct TaskWorkbenchCatalogApp: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let icon: String
    let description: String
    let surface: String?
    let installed: Bool?
    let order: Int
    /// catalog 透传的 `runtimeSupport.mobile.mode`；未声明为 nil。
    let mobileMode: String?

    enum CodingKeys: String, CodingKey {
        case id, name, icon, description, surface, installed, order
        case mobileMode = "mobile_mode"
    }

    init(
        id: String,
        name: String,
        icon: String,
        description: String,
        surface: String?,
        installed: Bool?,
        order: Int,
        mobileMode: String? = nil
    ) {
        self.id = id
        self.name = name
        self.icon = icon
        self.description = description
        self.surface = surface
        self.installed = installed
        self.order = order
        self.mobileMode = mobileMode
    }
}

struct TaskWorkbenchWorkspaceAppsResponse: Decodable, Sendable {
    let apps: [TaskWorkbenchWorkspaceApp]
}

struct TaskWorkbenchWorkspaceApp: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let icon: String
    let canCreate: Bool
    let enabled: Bool
    let order: Int
    let desktopGroup: String
    let surface: String?

    enum CodingKeys: String, CodingKey {
        case id, name, icon, enabled, order, surface
        case canCreate = "can_create"
        case desktopGroup = "desktop_group"
    }
}

enum TaskWorkbenchAppSurface: String, CaseIterable, Hashable, Sendable {
    case collaborative
    case builtin
    case local

    var title: String {
        switch self {
        case .collaborative: return "协作应用"
        case .builtin: return "内置能力"
        case .local: return "本机扩展"
        }
    }
}

enum TaskWorkbenchAppActivation: Hashable, Sendable {
    /// 进入该 App 在当前 Workspace 的资源列表（App 首页）。
    case openAppHome
    /// iOS 没有这个 App 的承载页，首页永远是空的，直接把活交给 Agent 更省一次点击。
    case requestAgent
    case unavailable(String)
}

struct TaskWorkbenchApp: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let manifestIcon: String
    let surface: TaskWorkbenchAppSurface
    let installed: Bool
    let workspaceAvailable: Bool?
    let enabled: Bool?
    let canCreate: Bool
    let order: Int
    let recentResource: SpaceResource?
    let resourceCount: Int
    /// catalog `mobile_mode`：full / unsupported / nil（未声明）。
    let mobileMode: String?

    init(
        id: String,
        name: String,
        description: String,
        manifestIcon: String,
        surface: TaskWorkbenchAppSurface,
        installed: Bool,
        workspaceAvailable: Bool?,
        enabled: Bool?,
        canCreate: Bool,
        order: Int,
        recentResource: SpaceResource?,
        resourceCount: Int,
        mobileMode: String? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.manifestIcon = manifestIcon
        self.surface = surface
        self.installed = installed
        self.workspaceAvailable = workspaceAvailable
        self.enabled = enabled
        self.canCreate = canCreate
        self.order = order
        self.recentResource = recentResource
        self.resourceCount = resourceCount
        self.mobileMode = mobileMode
    }

    /// 优先品牌资产，SF Symbol 仅 fallback（见 `AppIconResolver`）。
    var iconReference: AppIconReference {
        TaskWorkbenchAppIcon.resolve(manifestIcon: manifestIcon, appId: id)
    }

    /// 兼容旧调用点：始终返回 SF Symbol 名（无资产时的 fallback）。
    /// 新 UI 请用 `iconReference` / `AppIconImage`。
    var systemImage: String {
        TaskWorkbenchAppIcon.systemImage(manifestIcon: manifestIcon, appId: id)
    }

    var activation: TaskWorkbenchAppActivation {
        guard installed else {
            return .unavailable("“\(name)”尚未安装到当前组织，请先在桌面端的应用市场完成安装。")
        }
        guard let workspaceAvailable else {
            return .unavailable("应用状态暂不可确认，请重试后再使用“\(name)”。")
        }
        if workspaceAvailable == false {
            return .unavailable("当前 Workspace 的执行设备暂不支持“\(name)”。")
        }
        if enabled == false {
            return .unavailable("“\(name)”已在当前 Workspace 停用，请先在桌面端启用。")
        }
        if TaskWorkbenchMobileRuntime.isBlocked(mobileMode) {
            return .unavailable("“\(name)”暂未在移动端开放。")
        }
        // App 首页与资源数量解耦：full 明确可进；未声明走 hasAppRoute 兼容既有入口。
        return TaskWorkbenchMobileRuntime.allowsAppHome(mobileMode, appId: id)
            ? .openAppHome
            : .requestAgent
    }

    var actionLabel: String {
        switch activation {
        case .openAppHome:
            return resourceCount > 0 ? "进入 · \(resourceCount) 项" : "进入"
        case .requestAgent:
            return agentActionTitle
        case .unavailable:
            if !installed { return "未安装" }
            if workspaceAvailable == nil { return "状态未知" }
            if enabled == false { return "未启用" }
            return "暂不支持"
        }
    }

    var agentActionTitle: String {
        canCreate ? "让 Agent 新建" : "交给 Agent"
    }

    /// 最近一条资源降级成卡片提示：仍然看得见，但不再抢走「进首页」这个主操作。
    var recentResourceHint: String? {
        guard case .openAppHome = activation, let recentResource else { return nil }
        return "最近：\(recentResource.displayTitle)"
    }

    var agentRequestPrompt: String {
        if canCreate {
            return "请在当前任务中使用 \(name) 开始一项新的工作。"
        }
        return "请在当前任务中使用 \(name) 处理接下来的工作。"
    }
}

struct TaskWorkbenchAppSection: Identifiable, Hashable, Sendable {
    let surface: TaskWorkbenchAppSurface
    let apps: [TaskWorkbenchApp]

    var id: String { surface.rawValue }
    var title: String { surface.title }
}

enum TaskWorkbenchAppProjector {
    static func project(
        catalog: [TaskWorkbenchCatalogApp],
        workspaceApps: [TaskWorkbenchWorkspaceApp]?,
        resources: [SpaceResource]
    ) -> [TaskWorkbenchApp] {
        let workspaceById = Dictionary(
            (workspaceApps ?? []).map { (normalized($0.id), $0) },
            uniquingKeysWith: { lhs, rhs in lhs.order <= rhs.order ? lhs : rhs }
        )
        let latestResourceByType = Dictionary(
            resources
                .sorted { $0.sortTimestamp > $1.sortTimestamp }
                .map { ($0.normalizedType, $0) },
            uniquingKeysWith: { lhs, _ in lhs }
        )
        let resourceCountByType = resources.reduce(into: [String: Int]()) { counts, resource in
            counts[resource.normalizedType, default: 0] += 1
        }
        let workspaceStatusKnown = workspaceApps != nil

        return catalog.compactMap { item in
            guard let declaredSurface = item.surface.flatMap(TaskWorkbenchAppSurface.init(rawValue:)) else {
                return nil
            }
            let appId = normalized(item.id)
            let surface = mobileSurface(appId: appId, declared: declaredSurface)
            guard !TaskWorkbenchAppVisibility.isHidden(appId: appId) else { return nil }
            // mobile unsupported / unavailable：工作台不露死入口（含「本机扩展」里
            // cowart / Simple Todo 等 marketplace 样板），避免灰磁贴占位。
            guard !TaskWorkbenchMobileRuntime.isBlocked(item.mobileMode) else { return nil }
            let workspaceApp = workspaceById[appId]
            let installed = item.installed ?? (workspaceApp != nil)

            return TaskWorkbenchApp(
                id: appId,
                name: TaskWorkbenchAppDisplayName.resolve(
                    appId: appId,
                    fallback: firstNonEmpty(workspaceApp?.name, item.name) ?? appId
                ),
                description: item.description.trimmingCharacters(in: .whitespacesAndNewlines),
                manifestIcon: firstNonEmpty(workspaceApp?.icon, item.icon) ?? "",
                surface: surface,
                installed: installed,
                workspaceAvailable: workspaceStatusKnown ? workspaceApp != nil : nil,
                enabled: workspaceApp?.enabled,
                canCreate: workspaceApp?.canCreate ?? false,
                order: workspaceApp?.order ?? item.order,
                recentResource: latestResourceByType[appId],
                resourceCount: resourceCountByType[appId] ?? 0,
                mobileMode: item.mobileMode
            )
        }
        .sorted(by: appSort)
    }

    static func sections(from apps: [TaskWorkbenchApp]) -> [TaskWorkbenchAppSection] {
        TaskWorkbenchAppSurface.allCases.compactMap { surface in
            let sectionApps = apps.filter { $0.surface == surface }.sorted(by: appSort)
            guard !sectionApps.isEmpty else { return nil }
            return TaskWorkbenchAppSection(surface: surface, apps: sectionApps)
        }
    }

    static func quickStartApps(from apps: [TaskWorkbenchApp], limit: Int = 4) -> [TaskWorkbenchApp] {
        Array(
            apps
                .filter {
                    $0.installed
                        && $0.workspaceAvailable != false
                        && $0.enabled != false
                        && $0.canCreate
                }
                .sorted(by: appSort)
                .prefix(max(limit, 0))
        )
    }

    private static func appSort(_ lhs: TaskWorkbenchApp, _ rhs: TaskWorkbenchApp) -> Bool {
        if lhs.order != rhs.order { return lhs.order < rhs.order }
        if lhs.name != rhs.name {
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        return lhs.id < rhs.id
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// 自动化是系统执行能力，不是拥有独立资源首页的协作应用。
    private static func mobileSurface(
        appId: String,
        declared: TaskWorkbenchAppSurface
    ) -> TaskWorkbenchAppSurface {
        appId == "tabtracker" ? .builtin : declared
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        values.lazy.compactMap { value in
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else {
                return nil
            }
            return value
        }.first
    }
}

/// 工作台 App 图标映射已收口到 `AppIconResolver`（品牌资产优先，SF Symbol fallback）。
private enum TaskWorkbenchAppIcon {
    static func systemImage(manifestIcon: String, appId: String) -> String {
        let resolved = AppIconResolver.systemImageFallback(manifestIcon: manifestIcon, appId: appId)
        if resolved != "square.grid.2x2" { return resolved }
        let resourceIcon = SpaceResource.icon(forType: appId)
        return resourceIcon == "doc" ? "square.grid.2x2" : resourceIcon
    }

    static func resolve(manifestIcon: String, appId: String) -> AppIconReference {
        if let asset = AppIconResolver.resolveAssetName(appId: appId) {
            return .asset(asset)
        }
        return .system(systemImage(manifestIcon: manifestIcon, appId: appId))
    }
}

struct TaskWorkbenchOutput: Identifiable, Hashable, Sendable {
    let id: String
    let resourceType: String
    let resourceId: String
    let title: String
    let preview: String?
    let timestamp: Date
    let resource: SpaceResource?
    let openRequest: SpaceResourceOpenRequest
    var mimeType: String? = nil

    var icon: String { SpaceResource.icon(forType: resourceType) }
    /// 本任务产出卡用产品字形，不再落 SF Symbol。
    var iconReference: AppIconReference {
        AppIconResolver.resolveContentGlyph(
            appId: SpaceResource.normalizedType(resourceType),
            manifestIcon: icon
        )
    }
    var typeLabel: String { SpaceResource.typeLabel(forType: resourceType) }
    var fileKind: CloudDriveFileKind? {
        guard SpaceResource.normalizedType(resourceType) == "tabfiles" else { return nil }
        return CloudDrivePresentationResolver.kind(
            itemType: "tabfiles",
            title: resource?.fileName ?? title,
            mimeType: mimeType ?? resource?.mimeType,
            fileExtension: resource?.fileExtension
        )
    }
    var presentationTypeLabel: String { fileKind?.typeLabel ?? typeLabel }
    var route: SpaceAppRoute? { resource?.appRoute ?? openRequest.fallbackRoute }

    var canOpen: Bool {
        switch resourceType {
        case "tabsite":
            return resource?.appRoute != nil
        case "tabfiles":
            return resource?.appRoute != nil
                || TaskWorkbenchConversationArtifactPolicy.isOpenableFileRecord(resourceId)
        case "widget":
            return false
        default:
            return route != nil
        }
    }
}

/// 「本任务产出」列表：满宽条 + 默认只露出前 5 条。
enum TaskWorkbenchOutputListPolicy {
    static let collapsedVisibleCount = 5

    static func visible<T>(from outputs: [T], expanded: Bool) -> [T] {
        if expanded || outputs.count <= collapsedVisibleCount {
            return outputs
        }
        return Array(outputs.prefix(collapsedVisibleCount))
    }

    static func hiddenCount(total: Int, expanded: Bool) -> Int {
        if expanded || total <= collapsedVisibleCount { return 0 }
        return total - collapsedVisibleCount
    }
}

struct TaskWorkbenchCheckpoint: Hashable, Sendable {
    let messageId: String
    let title: String
    let createdAt: Date
    let status: ChatCheckpointStatus
    let changedFileCount: Int
    let canRestoreResources: Bool
}

struct TaskWorkbenchSnapshot: Equatable, Sendable {
    let resumeItem: TaskWorkbenchOutput?
    let outputs: [TaskWorkbenchOutput]
    let latestCheckpoint: TaskWorkbenchCheckpoint?
    let runState: AgentRunPresentationState
    let agentName: String
    let completedTodoCount: Int
    let totalTodoCount: Int

    static func empty(
        runState: AgentRunPresentationState = .idle,
        agentName: String = "Agent"
    ) -> TaskWorkbenchSnapshot {
        TaskWorkbenchSnapshot(
            resumeItem: nil,
            outputs: [],
            latestCheckpoint: nil,
            runState: runState,
            agentName: agentName,
            completedTodoCount: 0,
            totalTodoCount: 0
        )
    }
}

enum TaskWorkbenchConversationArtifactPolicy {
    struct Pointer: Equatable, Sendable {
        let rawType: String
        let resourceId: String
        let titleCandidates: [String?]
        let previewCandidates: [String?]
        var mimeType: String? = nil
    }

    private static let presentationalKinds: Set<String> = [
        "table_preview", "search_results", "memory_card", "document_excerpt",
    ]
    private static let deliverableArtifactKinds: Set<String> = [
        "oss_file", "local_file", "platform_resource",
    ]

    static func acceptsType(_ resourceType: String) -> Bool {
        let normalized = SpaceResource.normalizedType(resourceType)
        return !normalized.isEmpty && !presentationalKinds.contains(normalized)
    }

    static func isOpenableFileRecord(_ resourceId: String) -> Bool {
        let id = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty { return false }
        if id.contains("/") || id.contains("\\") { return false }
        if id.contains("\u{2026}") || id.contains("...") { return false }
        return true
    }

    static func pointer(from content: RichContentBlock) -> Pointer? {
        let kind = content.kind
        let artifactKind = content.artifactKind ?? ""
        if presentationalKinds.contains(kind) && !deliverableArtifactKinds.contains(artifactKind) {
            return nil
        }
        if kind == "widget" {
            guard let widgetId = normalized(content.widgetId),
                  !widgetId.hasPrefix("pending:"),
                  widgetHasDeliverableContent(content) else {
                return nil
            }
            return Pointer(
                rawType: "widget",
                resourceId: widgetId,
                titleCandidates: [content.title, content.summary, "图示"],
                previewCandidates: [content.summary]
            )
        }
        if artifactKind == "oss_file" || ((kind == "file" || kind == "image") && normalized(content.fileId) != nil) {
            guard let fileId = normalized(content.fileId) ?? fileIdFromResourceURL(content.url) else {
                return nil
            }
            return Pointer(
                rawType: "tabfiles",
                resourceId: fileId,
                titleCandidates: [content.filename, content.title, content.summary],
                previewCandidates: [content.summary, content.filename],
                mimeType: inferredMimeType(content)
            )
        }
        if artifactKind == "local_file" {
            guard let path = normalized(content.relativePath) else { return nil }
            return Pointer(
                rawType: "tabfiles",
                resourceId: path,
                titleCandidates: [content.filename, content.title, path],
                previewCandidates: [content.summary, content.filename],
                mimeType: inferredMimeType(content)
            )
        }
        if let rawType = normalized(content.resourceType),
           let resourceId = normalized(content.resourceId) {
            return Pointer(
                rawType: rawType,
                resourceId: resourceId,
                titleCandidates: [
                    content.resourceName,
                    content.title,
                    content.filename,
                    content.summary,
                ],
                previewCandidates: [
                    content.summary,
                    content.footer,
                    content.filename,
                ],
                mimeType: inferredMimeType(content)
            )
        }
        if let fileId = fileIdFromResourceURL(content.url) {
            return Pointer(
                rawType: "tabfiles",
                resourceId: fileId,
                titleCandidates: [content.filename, content.title, content.summary],
                previewCandidates: [content.summary, content.filename],
                mimeType: inferredMimeType(content)
            )
        }
        return nil
    }

    private static func widgetHasDeliverableContent(_ content: RichContentBlock) -> Bool {
        [
            content.sourceCode,
            content.mermaidSource,
            content.url,
        ].contains { normalized($0) != nil }
    }

    private static func inferredMimeType(_ content: RichContentBlock) -> String? {
        if let mime = normalized(content.mimeType) { return mime }
        return content.kind == "image" ? "image/*" : nil
    }

    private static func fileIdFromResourceURL(_ url: String?) -> String? {
        guard let href = normalized(url), href.hasPrefix("tabtin://resource/file/") else {
            return nil
        }
        let rest = String(href.dropFirst("tabtin://resource/file/".count))
        let encoded = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? rest
        return normalized(encoded.removingPercentEncoding ?? encoded)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

enum TaskWorkbenchProjector {
    static func project(
        messages: [ChatMessage],
        subagentRuns: [SubagentRun] = [],
        resources: [SpaceResource],
        currentRoute: SpaceAppRoute?,
        runState: AgentRunPresentationState,
        agentName: String,
        completedTodoCount: Int,
        totalTodoCount: Int
    ) -> TaskWorkbenchSnapshot {
        let resourcesByIdentity = Dictionary(
            resources.map { (resourceIdentity(type: $0.normalizedType, id: $0.resourceId), $0) },
            uniquingKeysWith: { lhs, rhs in
                lhs.sortTimestamp >= rhs.sortTimestamp ? lhs : rhs
            }
        )
        var outputsByIdentity: [String: TaskWorkbenchOutput] = [:]

        func recordPointer(
            rawType: String,
            resourceId: String,
            titleCandidates: [String?],
            previewCandidates: [String?],
            locationHint: String?,
            sourceTimestamp: Date,
            mimeType: String? = nil
        ) {
            guard let resourceId = normalized(resourceId) else { return }
            let resourceType = SpaceResource.normalizedType(rawType)
            guard TaskWorkbenchConversationArtifactPolicy.acceptsType(resourceType) else { return }

            let identity = resourceIdentity(type: resourceType, id: resourceId)
            let resource = resourcesByIdentity[identity]
            let title = firstNonEmpty(
                resource?.displayTitle,
                titleCandidates
            ) ?? SpaceResource.typeLabel(forType: resourceType)
            let preview = firstNonEmpty(
                resource?.preview,
                previewCandidates
            )
            let timestamp = max(sourceTimestamp, resource?.sortTimestamp ?? .distantPast)
            let request = SpaceResourceOpenRequest(
                resourceType: resourceType,
                resourceId: resourceId,
                title: title,
                locationHint: locationHint
            )
            let output = TaskWorkbenchOutput(
                id: identity,
                resourceType: resourceType,
                resourceId: resourceId,
                title: title,
                preview: preview,
                timestamp: timestamp,
                resource: resource,
                openRequest: request,
                mimeType: firstNonEmpty(mimeType, resource?.mimeType)
            )

            if let existing = outputsByIdentity[identity], existing.timestamp > output.timestamp {
                return
            }
            outputsByIdentity[identity] = output
        }

        func recordOutput(_ content: RichContentBlock, sourceTimestamp: Date) {
            guard let pointer = TaskWorkbenchConversationArtifactPolicy.pointer(from: content) else {
                return
            }
            recordPointer(
                rawType: pointer.rawType,
                resourceId: pointer.resourceId,
                titleCandidates: pointer.titleCandidates,
                previewCandidates: pointer.previewCandidates,
                locationHint: content.spaceName,
                sourceTimestamp: sourceTimestamp,
                mimeType: pointer.mimeType
            )
        }

        for message in messages where message.isAssistant && !message.isSubagentTranscript {
            for block in message.blocks {
                switch block {
                case let .richContent(content):
                    recordOutput(content, sourceTimestamp: message.createdAt)
                case let .text(textBlock):
                    for link in TaskWorkbenchResourceLinkExtractor.extract(from: textBlock.text) {
                        recordPointer(
                            rawType: link.resourceType,
                            resourceId: link.resourceId,
                            titleCandidates: [link.title],
                            previewCandidates: [],
                            locationHint: nil,
                            sourceTimestamp: message.createdAt
                        )
                    }
                case let .tool(tool) where !tool.isError:
                    // CLI `tabtin doc create` 常见路径：工具 JSON 含 data.document，
                    // 最终回复未必带 tabtin://resource 链接（见 dogfood 快照）。
                    if let output = tool.visibleOutputText {
                        for link in TaskWorkbenchResourceLinkExtractor.extract(from: output) {
                            recordPointer(
                                rawType: link.resourceType,
                                resourceId: link.resourceId,
                                titleCandidates: [link.title],
                                previewCandidates: [],
                                locationHint: nil,
                                sourceTimestamp: message.createdAt
                            )
                        }
                        for cli in TaskWorkbenchCLIResourceExtractor.extract(from: output) {
                            recordPointer(
                                rawType: cli.resourceType,
                                resourceId: cli.resourceId,
                                titleCandidates: [cli.title],
                                previewCandidates: [],
                                locationHint: nil,
                                sourceTimestamp: message.createdAt
                            )
                        }
                    }
                default:
                    continue
                }
            }
        }

        for run in subagentRuns {
            let runTimestamp = dateFromEpoch(run.endedAt ?? run.startedAt) ?? .distantPast
            for item in run.transcript {
                if item.kind == .richContent, let content = item.richContent {
                    recordOutput(content, sourceTimestamp: runTimestamp)
                    continue
                }
                if let text = item.text {
                    for link in TaskWorkbenchResourceLinkExtractor.extract(from: text) {
                        recordPointer(
                            rawType: link.resourceType,
                            resourceId: link.resourceId,
                            titleCandidates: [link.title, item.title],
                            previewCandidates: [],
                            locationHint: nil,
                            sourceTimestamp: runTimestamp
                        )
                    }
                }
                if let outputText = item.outputText {
                    for link in TaskWorkbenchResourceLinkExtractor.extract(from: outputText) {
                        recordPointer(
                            rawType: link.resourceType,
                            resourceId: link.resourceId,
                            titleCandidates: [link.title, item.title],
                            previewCandidates: [],
                            locationHint: nil,
                            sourceTimestamp: runTimestamp
                        )
                    }
                    for cli in TaskWorkbenchCLIResourceExtractor.extract(from: outputText) {
                        recordPointer(
                            rawType: cli.resourceType,
                            resourceId: cli.resourceId,
                            titleCandidates: [cli.title, item.title],
                            previewCandidates: [],
                            locationHint: nil,
                            sourceTimestamp: runTimestamp
                        )
                    }
                }
            }
        }

        let outputs = outputsByIdentity.values.sorted {
            if $0.timestamp != $1.timestamp { return $0.timestamp > $1.timestamp }
            return $0.id < $1.id
        }
        let resumeItem = currentRoute.flatMap { route in
            outputs.first(where: { $0.route == route })
        } ?? outputs.first

        let latestCheckpoint = messages.reversed().compactMap { message -> TaskWorkbenchCheckpoint? in
            guard let checkpoint = message.checkpointRecord else { return nil }
            let summary = checkpoint.impactSummary?.fileSummary
            let changedFileCount = max(summary?.changed ?? 0, summary?.files?.count ?? 0)
            return TaskWorkbenchCheckpoint(
                messageId: message.id,
                title: firstNonEmpty(
                    checkpoint.contextSummary?.intentSummary,
                    "最近检查点"
                ) ?? "最近检查点",
                createdAt: message.createdAt,
                status: checkpoint.normalizedStatus,
                changedFileCount: changedFileCount,
                canRestoreResources: checkpoint.capabilityScope?.resourceRestore == true
            )
        }.first

        return TaskWorkbenchSnapshot(
            resumeItem: resumeItem,
            outputs: outputs,
            latestCheckpoint: latestCheckpoint,
            runState: runState,
            agentName: normalized(agentName) ?? "Agent",
            completedTodoCount: min(max(completedTodoCount, 0), max(totalTodoCount, 0)),
            totalTodoCount: max(totalTodoCount, 0)
        )
    }

    private static func resourceIdentity(type: String, id: String) -> String {
        "\(SpaceResource.normalizedType(type)):\(id)"
    }

    private static func dateFromEpoch(_ value: Double?) -> Date? {
        guard let value, value.isFinite, value > 0 else { return nil }
        let seconds = value > 1_000_000_000_000 ? value / 1_000 : value
        return Date(timeIntervalSince1970: seconds)
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        values.lazy.compactMap(normalized).first
    }

    private static func firstNonEmpty(_ head: String?, _ values: [String?]) -> String? {
        if let head = normalized(head) { return head }
        return values.lazy.compactMap(normalized).first
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }
}

/// 从 assistant 正文 / 工具输出提取 `tabtin://resource/<type>/<id>`（对齐 Electron `extractResourceLinkArtifacts`）。
enum TaskWorkbenchResourceLinkExtractor {
    struct Link: Equatable, Sendable {
        let resourceType: String
        let resourceId: String
        let title: String?
    }

    private static let mdLinkRegex = try! NSRegularExpression(
        pattern: #"\[([^\]]+)\]\((tabtin://resource/[^)\s\"'`]+)\)"#
    )
    private static let bareURIRegex = try! NSRegularExpression(
        pattern: #"tabtin://resource/[^\s)\]\"'`]+"#
    )
    private static let fencedCodeRegex = try! NSRegularExpression(
        pattern: #"```[\s\S]*?(?:```|$)"#
    )
    private static let inlineCodeRegex = try! NSRegularExpression(
        pattern: #"`[^`\n]*`"#
    )

    static func extract(from rawText: String) -> [Link] {
        guard rawText.contains("tabtin://resource/") else { return [] }
        let text = stripCodeSegments(rawText)
        guard text.contains("tabtin://resource/") else { return [] }

        let nsText = text as NSString
        var labelByURL: [String: String] = [:]
        mdLinkRegex.enumerateMatches(in: text, range: NSRange(location: 0, length: nsText.length)) { match, _, _ in
            guard let match, match.numberOfRanges >= 3 else { return }
            let label = stripMarkdownInline(nsText.substring(with: match.range(at: 1)))
            let url = sanitizeURI(nsText.substring(with: match.range(at: 2)))
            if !url.isEmpty, !label.isEmpty, labelByURL[url] == nil {
                labelByURL[url] = label
            }
        }

        var links: [Link] = []
        var seen = Set<String>()
        bareURIRegex.enumerateMatches(in: text, range: NSRange(location: 0, length: nsText.length)) { match, _, _ in
            guard let match else { return }
            let href = sanitizeURI(nsText.substring(with: match.range))
            guard let parsed = parseResourceURI(href) else { return }
            if isTruncatedResourceId(type: parsed.type, id: parsed.id) { return }
            let key = "\(parsed.type):\(parsed.id)"
            guard !seen.contains(key) else { return }
            seen.insert(key)
            links.append(
                Link(
                    resourceType: parsed.type,
                    resourceId: parsed.id,
                    title: labelByURL[href]
                )
            )
        }
        return links
    }

    private static func stripCodeSegments(_ text: String) -> String {
        var result = text
        let ns = result as NSString
        let fenced = fencedCodeRegex.matches(in: result, range: NSRange(location: 0, length: ns.length))
        for match in fenced.reversed() {
            result = (result as NSString).replacingCharacters(in: match.range, with: " ")
        }
        let ns2 = result as NSString
        let inlines = inlineCodeRegex.matches(in: result, range: NSRange(location: 0, length: ns2.length))
        for match in inlines.reversed() {
            result = (result as NSString).replacingCharacters(in: match.range, with: " ")
        }
        return result
    }

    private static func stripMarkdownInline(_ value: String) -> String {
        value.replacingOccurrences(of: #"[*`_~]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func sanitizeURI(_ href: String) -> String {
        href.replacingOccurrences(
            of: #"[.,;:!?。，、；：！？…]+$"#,
            with: "",
            options: .regularExpression
        )
    }

    private static func isTruncatedResourceId(type: String, id: String) -> Bool {
        if id.contains("\u{2026}") { return true }
        return type != "file" && id.contains("...")
    }

    private static func parseResourceURI(_ href: String) -> (type: String, id: String)? {
        guard href.hasPrefix("tabtin://resource/") else { return nil }
        let rest = String(href.dropFirst("tabtin://resource/".count))
        let path = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first
            .map(String.init) ?? ""
        let parts = path.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let type = String(parts[0]).trimmingCharacters(in: .whitespacesAndNewlines)
        let id = String(parts[1])
            .removingPercentEncoding?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !type.isEmpty, !id.isEmpty else { return nil }
        let aliases = ["doc": "document"]
        return (aliases[type] ?? type, id)
    }
}

/// 从 `run_terminal_command` / CLI JSON 结果抽取云资源（`tabtin doc create --format json`）。
enum TaskWorkbenchCLIResourceExtractor {
    struct Resource: Equatable, Sendable {
        let resourceType: String
        let resourceId: String
        let title: String?
    }

    private static let objectKeys: [(key: String, type: String)] = [
        ("document", "tabdoc"),
        ("table", "tabdata"),
        ("doc", "tabdoc"),
    ]

    static func extract(from rawText: String) -> [Resource] {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var found: [Resource] = []
        var seen = Set<String>()

        if let data = trimmed.data(using: .utf8),
           let root = try? JSONSerialization.jsonObject(with: data) {
            collect(from: root, into: &found, seen: &seen)
        }

        // 结构化解析失败时，兜底扫 document/table 块里的 id。
        if found.isEmpty {
            collectByRegex(from: trimmed, into: &found, seen: &seen)
        }
        return found
    }

    private static func append(
        type: String,
        id: String,
        title: String?,
        into found: inout [Resource],
        seen: inout Set<String>
    ) {
        let resourceId = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !resourceId.isEmpty,
              !resourceId.contains("\u{2026}"),
              !resourceId.contains("...") else {
            return
        }
        let key = "\(type):\(resourceId)"
        guard !seen.contains(key) else { return }
        seen.insert(key)
        let cleanTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        found.append(
            Resource(
                resourceType: type,
                resourceId: resourceId,
                title: (cleanTitle?.isEmpty == false) ? cleanTitle : nil
            )
        )
    }

    private static func collect(
        from value: Any,
        into found: inout [Resource],
        seen: inout Set<String>
    ) {
        if let array = value as? [Any] {
            for item in array {
                collect(from: item, into: &found, seen: &seen)
            }
            return
        }
        if let array = value as? NSArray {
            for item in array {
                collect(from: item, into: &found, seen: &seen)
            }
            return
        }

        guard let dict = value as? NSDictionary else { return }

        if let stdout = dict["stdout"] as? String,
           let stdoutData = stdout.data(using: .utf8),
           let nested = try? JSONSerialization.jsonObject(with: stdoutData) {
            collect(from: nested, into: &found, seen: &seen)
        }

        if let data = dict["data"] as? NSDictionary {
            for (key, type) in objectKeys {
                if let object = data[key] as? NSDictionary,
                   let id = object["id"] as? String {
                    append(
                        type: type,
                        id: id,
                        title: (object["title"] as? String) ?? (object["name"] as? String),
                        into: &found,
                        seen: &seen
                    )
                }
            }
            if let id = data["id"] as? String,
               let itemType = (data["item_type"] as? String)
                ?? (data["resource_type"] as? String)
                ?? (data["type"] as? String) {
                let normalized = SpaceResource.normalizedType(itemType)
                if normalized == "tabdoc" || normalized == "tabdata" {
                    append(
                        type: normalized,
                        id: id,
                        title: (data["title"] as? String) ?? (data["name"] as? String),
                        into: &found,
                        seen: &seen
                    )
                }
            }
        }

        for (key, type) in objectKeys {
            if let object = dict[key] as? NSDictionary,
               let id = object["id"] as? String {
                append(
                    type: type,
                    id: id,
                    title: (object["title"] as? String) ?? (object["name"] as? String),
                    into: &found,
                    seen: &seen
                )
            }
        }

        for nested in dict.allValues {
            collect(from: nested, into: &found, seen: &seen)
        }
    }

    private static func collectByRegex(
        from text: String,
        into found: inout [Resource],
        seen: inout Set<String>
    ) {
        let patterns: [(type: String, pattern: String)] = [
            ("tabdoc", #""document"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)""#),
            ("tabdata", #""table"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)""#),
        ]
        let titlePattern = #"\"title\"\s*:\s*\"([^\"]+)\""#
        for item in patterns {
            guard let regex = try? NSRegularExpression(pattern: item.pattern) else { continue }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            regex.enumerateMatches(in: text, range: range) { match, _, _ in
                guard let match,
                      match.numberOfRanges >= 2,
                      let idRange = Range(match.range(at: 1), in: text) else {
                    return
                }
                let id = String(text[idRange])
                var title: String?
                if let blockRange = Range(match.range(at: 0), in: text),
                   let titleRegex = try? NSRegularExpression(pattern: titlePattern),
                   let titleMatch = titleRegex.firstMatch(
                    in: text,
                    range: NSRange(blockRange, in: text)
                   ),
                   titleMatch.numberOfRanges >= 2,
                   let titleRange = Range(titleMatch.range(at: 1), in: text) {
                    title = String(text[titleRange])
                }
                append(type: item.type, id: id, title: title, into: &found, seen: &seen)
            }
        }
    }
}

/// 工作台视图模型：拉一个 Space 的 context-items（内嵌 App 实例），按类型分组供 Workbench 展示。
///
/// 细粒度状态：由工作台承载层持有，不做全局单例。
/// 资源即 App 实例（resourceId），类型即 App（normalizedType）。
///
/// Task 资源单独持有：权威来自 current Task workbench `resources`，
/// `taskSnapshot.outputs` 只做待服务端确认的 pending overlay。
@MainActor @Observable
final class WorkbenchViewModel {
    private(set) var spaceId: String?
    private(set) var organizationId: String?
    /// 真实 chat session id（`X-Tabtin-Session-Id`）；禁止用展示标题或 Workspace ID。
    private(set) var sessionId: String?

    private(set) var resources: [SpaceResource] = []
    private(set) var isLoading = false
    var errorMessage: String?

    private(set) var taskResources: [TaskWorkbenchResource] = []
    private(set) var isTaskResourcesLoading = false
    var taskResourcesErrorMessage: String?
    private(set) var pendingTaskResourceOverlays: [TaskWorkbenchPendingOverlay] = []
    /// 当前会话是否绑定了可读取的 Project Task；非 Task 会话保持空列表，不伪装。
    private(set) var isProjectTaskSession = false
    private(set) var isCreatingBlankResource = false
    var blankCreateErrorMessage: String?

    private(set) var apps: [TaskWorkbenchApp] = []
    private(set) var isAppCatalogLoading = false
    var appCatalogErrorMessage: String?
    private(set) var appAvailabilityErrorMessage: String?

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "Workbench")
    private var loadGeneration = 0
    private var taskResourceLoadGeneration = 0
    /// 空白资源创建独立于资源拉取；scope 变化时只让旧创建结果失效，不误伤正常刷新。
    private var blankCreateGeneration = 0
    /// 云资源已创建、Task 投影尚未追上时的会话内桥接；服务端同身份资源始终覆盖本地快照。
    private var locallyCreatedTaskResources: [TaskWorkbenchResource] = []
    private var catalogApps: [TaskWorkbenchCatalogApp] = []
    private var workspaceApps: [TaskWorkbenchWorkspaceApp]?
    private static let visitedAtFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    init(spaceId: String?, organizationId: String? = nil, sessionId: String? = nil) {
        self.spaceId = Self.normalizedIdentifier(spaceId)
        self.organizationId = Self.normalizedIdentifier(organizationId)
        self.sessionId = Self.normalizedIdentifier(sessionId)
    }

    /// 该 Space 出现过的 App 类型（按常用顺序，其余字母序）——决定有哪些分组。
    var availableTypes: [String] {
        let all = Set(resources.map(\.normalizedType))
        let order = ["tabdata", "tabdoc", "tabslide", "tabsite", "tabtracker", "tabmemo"]
        return order.filter { all.contains($0) } + all.subtracting(order).sorted()
    }

    /// 某类型下的资源（置顶优先，再按更新时间倒序）。
    func resources(ofType type: String) -> [SpaceResource] {
        resources
            .filter { $0.normalizedType == type }
            .sorted {
                if ($0.isPinned ?? false) != ($1.isPinned ?? false) {
                    return ($0.isPinned ?? false)
                }
                return $0.sortTimestamp > $1.sortTimestamp
            }
    }

    /// 仅切换 Workspace 时的兼容入口；保留当前 org / session，但 Workspace 变化会失效 Task 资源请求。
    func updateScope(spaceId newSpaceId: String?) {
        updateScope(
            spaceId: newSpaceId,
            organizationId: organizationId,
            sessionId: sessionId
        )
    }

    /// Organization / Workspace / session 任一切换都使在途请求失效并清空对应状态。
    func updateScope(
        spaceId newSpaceId: String?,
        organizationId newOrganizationId: String?,
        sessionId newSessionId: String?
    ) {
        let normalizedSpaceId = Self.normalizedIdentifier(newSpaceId)
        let normalizedOrganizationId = Self.normalizedIdentifier(newOrganizationId)
        let normalizedSessionId = Self.normalizedIdentifier(newSessionId)

        let spaceChanged = normalizedSpaceId != spaceId
        let organizationChanged = normalizedOrganizationId != organizationId
        let sessionChanged = normalizedSessionId != sessionId
        guard spaceChanged || organizationChanged || sessionChanged else { return }

        loadGeneration += 1
        taskResourceLoadGeneration += 1

        if spaceChanged {
            spaceId = normalizedSpaceId
            resources = []
            isLoading = false
            errorMessage = nil
            apps = []
            isAppCatalogLoading = false
            appCatalogErrorMessage = nil
            appAvailabilityErrorMessage = nil
            catalogApps = []
            workspaceApps = nil
        }

        if organizationChanged {
            organizationId = normalizedOrganizationId
        }

        if sessionChanged {
            sessionId = normalizedSessionId
        }

        if spaceChanged || organizationChanged || sessionChanged {
            clearTaskResourceState()
        }
    }

    func load(organizationId: String? = nil, sessionId: String? = nil) async {
        // nil 维持既有 scope；显式的新 org / session 必须走统一失效路径，
        // 避免 @State ViewModel 被复用时旧创建请求回写新组织。
        updateScope(
            spaceId: spaceId,
            organizationId: Self.normalizedIdentifier(organizationId) ?? self.organizationId,
            sessionId: Self.normalizedIdentifier(sessionId) ?? self.sessionId
        )

        loadGeneration += 1
        taskResourceLoadGeneration += 1
        let generation = loadGeneration
        let taskGeneration = taskResourceLoadGeneration

        // Task resources 只依赖真实 session id，不依赖 Workspace；无 Space 时仍可单独拉取。
        async let taskLoad: Void = loadTaskResources(
            sessionId: self.sessionId,
            generation: taskGeneration
        )

        guard let spaceId else {
            resources = []
            isLoading = false
            errorMessage = nil
            apps = []
            isAppCatalogLoading = false
            appCatalogErrorMessage = nil
            appAvailabilityErrorMessage = nil
            await taskLoad
            return
        }

        async let resourceLoad: Void = loadResources(spaceId: spaceId, generation: generation)
        if let organizationId = Self.normalizedIdentifier(organizationId) ?? self.organizationId {
            async let appLoad: Void = loadApps(
                organizationId: organizationId,
                workspaceId: spaceId,
                generation: generation
            )
            _ = await (resourceLoad, appLoad, taskLoad)
        } else {
            _ = await (resourceLoad, taskLoad)
        }
    }

    /// 单独刷新 current Task resources（输出身份变化 / Run 终态）。
    func refreshTaskResources(sessionId: String? = nil) async {
        if let sessionId = Self.normalizedIdentifier(sessionId), sessionId != self.sessionId {
            taskResourceLoadGeneration += 1
            self.sessionId = sessionId
            clearTaskResourceState()
        }
        taskResourceLoadGeneration += 1
        let generation = taskResourceLoadGeneration
        await loadTaskResources(sessionId: self.sessionId, generation: generation)
    }

    ///  Task 6：走 TabDoc / TabData 已发布写接口直建，随后在当前会话本地挂载。
    @discardableResult
    func createBlankTaskResource(appKind: TaskResourceAppKind) async throws -> TaskWorkbenchResource {
        guard let sessionId = Self.normalizedIdentifier(sessionId) else {
            throw APIError.apiError(L10n.WorkbenchAppHome.blankCreateSessionMissing)
        }
        guard let organizationId = Self.normalizedIdentifier(organizationId) else {
            throw APIError.apiError(L10n.CloudDrive.missingOrganization)
        }
        guard !isCreatingBlankResource else {
            throw APIError.apiError(L10n.Common.loading)
        }

        blankCreateGeneration += 1
        let generation = blankCreateGeneration
        isCreatingBlankResource = true
        blankCreateErrorMessage = nil
        defer {
            if generation == blankCreateGeneration {
                isCreatingBlankResource = false
            }
        }

        let defaultTitle = L10n.CloudDocs.untitled
        // 创建成功后会立即打开；先记录这次真实访问，返回首页时“继续”应指向新资源。
        let createdAt = Self.visitedAtFormatter.string(from: Date())
        let created: TaskWorkbenchResource
        do {
            switch appKind {
            case .tabdoc:
                let document = try await CloudDriveRepository.createDocument(
                    organizationId: organizationId,
                    collectionId: nil,
                    title: defaultTitle
                )
                created = TaskWorkbenchResource(
                    contextItemId: "",
                    resourceType: appKind.resourceType,
                    resourceId: document.id,
                    title: Self.normalizedIdentifier(document.title) ?? defaultTitle,
                    organizationId: organizationId,
                    source: .candidate,
                    taskRunId: sessionId,
                    isPrimary: false,
                    canOpen: true,
                    createdAt: createdAt,
                    updatedAt: createdAt,
                    lastVisitedAt: createdAt
                )
            case .tabdata:
                let table = try await CloudDriveRepository.createTable(
                    organizationId: organizationId,
                    collectionId: nil,
                    name: defaultTitle
                )
                created = TaskWorkbenchResource(
                    contextItemId: "",
                    resourceType: appKind.resourceType,
                    resourceId: table.id,
                    title: Self.normalizedIdentifier(table.name) ?? defaultTitle,
                    organizationId: organizationId,
                    source: .candidate,
                    taskRunId: sessionId,
                    isPrimary: false,
                    canOpen: true,
                    createdAt: createdAt,
                    updatedAt: createdAt,
                    lastVisitedAt: createdAt
                )
            }
        } catch {
            guard isCurrentBlankCreation(
                generation: generation,
                organizationId: organizationId,
                sessionId: sessionId
            ) else {
                throw CancellationError()
            }
            throw error
        }
        guard isCurrentBlankCreation(
            generation: generation,
            organizationId: organizationId,
            sessionId: sessionId
        ) else {
            throw CancellationError()
        }
        upsertLocallyCreatedTaskResource(created)
        isProjectTaskSession = true
        logger.info(
            "Workbench created blank \(appKind.resourceType) resource \(created.resourceId) for session \(sessionId)"
        )
        return created
    }

    /// `taskSnapshot.outputs` 只做待服务端确认的即时 overlay，不冒充正式 Task 资源。
    func syncPendingOverlays(from outputs: [TaskWorkbenchOutput]) {
        pendingTaskResourceOverlays = TaskWorkbenchPendingOverlayBuilder.build(
            outputs: outputs,
            confirmedResources: taskResources
        )
    }

    /// 打开 Task 资源时记访问：有真实 ContextItem ID 才乐观更新并 fire-and-forget POST。
    /// 临时 pending overlay（无 ID）跳过，不伪造上报。
    func recordTaskResourceAccess(contextItemId: String?) {
        guard let contextItemId = Self.normalizedIdentifier(contextItemId) else { return }

        let visitedAt = Self.visitedAtFormatter.string(from: Date())
        if let index = taskResources.firstIndex(where: { $0.contextItemId == contextItemId }) {
            taskResources[index] = taskResources[index].withLastVisitedAt(visitedAt)
        }

        Task {
            do {
                let _: MessageResponse = try await APIClient.shared.post(
                    path: Endpoints.Context.contextItemAccess(contextItemId)
                )
            } catch {
                logger.debug(
                    "记录 Task 资源访问失败 item=\(contextItemId): \(error.localizedDescription)"
                )
            }
        }
    }

    private func loadResources(spaceId: String, generation: Int) async {
        isLoading = resources.isEmpty
        errorMessage = nil
        do {
            let response: SpaceResourceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.contextItems(spaceId: spaceId),
                query: MentionableResourceListQuery.parameters
            )
            guard generation == loadGeneration, self.spaceId == spaceId else { return }
            resources = response.items
            projectApps()
            logger.info("Workbench loaded \(response.items.count) resources for space \(spaceId)")
        } catch {
            guard generation == loadGeneration, self.spaceId == spaceId else { return }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("Workbench load failed: \(error.localizedDescription)")
        }
        if generation == loadGeneration {
            isLoading = false
        }
    }

    private func loadApps(
        organizationId: String,
        workspaceId: String,
        generation: Int
    ) async {
        isAppCatalogLoading = apps.isEmpty
        appCatalogErrorMessage = nil
        appAvailabilityErrorMessage = nil

        async let catalogRequest: TaskWorkbenchCatalogResponse = APIClient.shared.get(
            path: Endpoints.Context.organizationAppCatalog(organizationId)
        )
        async let workspaceRequest: TaskWorkbenchWorkspaceAppsResponse = APIClient.shared.get(
            path: Endpoints.Context.workspaceApps(workspaceId)
        )

        do {
            let catalog = try await catalogRequest
            let workspace: TaskWorkbenchWorkspaceAppsResponse?
            let workspaceErrorMessage: String?
            do {
                workspace = try await workspaceRequest
                workspaceErrorMessage = nil
            } catch {
                workspace = nil
                workspaceErrorMessage = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                logger.error("Workbench workspace apps load failed: \(error.localizedDescription)")
            }
            guard generation == loadGeneration, self.spaceId == workspaceId else { return }
            catalogApps = catalog.apps
            workspaceApps = workspace?.apps
            appAvailabilityErrorMessage = workspaceErrorMessage
            projectApps()
            logger.info(
                "Workbench loaded \(catalog.apps.count) catalog apps for organization \(organizationId)"
            )
        } catch {
            guard generation == loadGeneration, self.spaceId == workspaceId else { return }
            appCatalogErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            logger.error("Workbench app catalog load failed: \(error.localizedDescription)")
        }

        if generation == loadGeneration {
            isAppCatalogLoading = false
        }
    }

    private func loadTaskResources(sessionId: String?, generation: Int) async {
        guard let sessionId else {
            if generation == taskResourceLoadGeneration {
                clearTaskResourceState()
                isTaskResourcesLoading = false
            }
            return
        }

        isTaskResourcesLoading = taskResources.isEmpty
        taskResourcesErrorMessage = nil

        do {
            let response: TaskWorkbenchCurrentResponse = try await APIClient.shared.get(
                path: Endpoints.Context.currentTaskWorkbench,
                headers: ["X-Tabtin-Session-Id": sessionId]
            )
            guard generation == taskResourceLoadGeneration, self.sessionId == sessionId else {
                return
            }
            isProjectTaskSession = true
            taskResources = mergeServerTaskResources(response.resources)
            // 正式资源到位后剔除已确认的 pending overlay；完整重建由 syncPendingOverlays 负责。
            pendingTaskResourceOverlays = pendingTaskResourceOverlays.filter { overlay in
                !taskResources.contains(where: { $0.resourceIdentity == overlay.resourceIdentity })
            }
            logger.info(
                "Workbench loaded \(response.resources.count) task resources for session \(sessionId)"
            )
        } catch {
            guard generation == taskResourceLoadGeneration, self.sessionId == sessionId else {
                return
            }
            if Self.isNonProjectTaskSessionError(error) {
                // 普通非 Project Task 会话：清空 Task 资源，沿用原有 Space Workbench，不报错伪装。
                isProjectTaskSession = false
                taskResources = []
                taskResourcesErrorMessage = nil
                pendingTaskResourceOverlays = []
                logger.info("Workbench session \(sessionId) is not a Project Task; skip task resources")
            } else {
                taskResourcesErrorMessage = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                logger.error("Workbench task resources load failed: \(error.localizedDescription)")
            }
        }

        if generation == taskResourceLoadGeneration {
            isTaskResourcesLoading = false
        }
    }

    private func clearTaskResourceState() {
        // scope 清空后，旧组织发起的创建即使稍后成功，也不能回写当前页面。
        blankCreateGeneration += 1
        taskResources = []
        locallyCreatedTaskResources = []
        isTaskResourcesLoading = false
        taskResourcesErrorMessage = nil
        pendingTaskResourceOverlays = []
        isProjectTaskSession = false
        isCreatingBlankResource = false
        blankCreateErrorMessage = nil
    }

    private func isCurrentBlankCreation(
        generation: Int,
        organizationId: String,
        sessionId: String
    ) -> Bool {
        generation == blankCreateGeneration
            && self.organizationId == organizationId
            && self.sessionId == sessionId
    }

    private func projectApps() {
        apps = TaskWorkbenchAppProjector.project(
            catalog: catalogApps,
            workspaceApps: workspaceApps,
            resources: resources
        )
    }

    private func upsertLocallyCreatedTaskResource(_ resource: TaskWorkbenchResource) {
        locallyCreatedTaskResources.removeAll { $0.resourceIdentity == resource.resourceIdentity }
        locallyCreatedTaskResources.insert(resource, at: 0)
        taskResources.removeAll { $0.resourceIdentity == resource.resourceIdentity }
        taskResources.insert(resource, at: 0)
    }

    private func mergeServerTaskResources(
        _ serverResources: [TaskWorkbenchResource]
    ) -> [TaskWorkbenchResource] {
        let serverIdentities = Set(serverResources.map(\.resourceIdentity))
        let pendingLocal = locallyCreatedTaskResources.filter {
            !serverIdentities.contains($0.resourceIdentity)
        }
        locallyCreatedTaskResources = pendingLocal
        return serverResources + pendingLocal
    }

    private static func isNonProjectTaskSessionError(_ error: Error) -> Bool {
        if case APIError.apiErrorWithCode(let code, _) = error {
            return code == "PROJECT_TASK_SESSION_REQUIRED"
        }
        // 兜底：旧路径把带 code 的 400 收成 serverError 时，仍按文案静默分流。
        if case APIError.serverError(let status, let message) = error, status == 400 {
            let text = message ?? ""
            return text.contains("PROJECT_TASK_SESSION_REQUIRED")
                || text.contains("不是 Project Task")
        }
        return false
    }

    private static func normalizedIdentifier(_ value: String?) -> String? {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty else {
            return nil
        }
        return normalized
    }

    #if DEBUG
    /// 单测注入用（绕过网络）。
    func setResourcesForTest(_ items: [SpaceResource]) {
        resources = items
        projectApps()
    }

    func setTaskResourcesForTest(_ items: [TaskWorkbenchResource]) {
        locallyCreatedTaskResources = []
        isProjectTaskSession = !items.isEmpty
        taskResources = items
        pendingTaskResourceOverlays = pendingTaskResourceOverlays.filter { overlay in
            !items.contains(where: { $0.resourceIdentity == overlay.resourceIdentity })
        }
    }

    static func isNonProjectTaskSessionErrorForTest(_ error: Error) -> Bool {
        isNonProjectTaskSessionError(error)
    }
    #endif
}
