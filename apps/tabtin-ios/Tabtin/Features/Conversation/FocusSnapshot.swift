import Foundation
import OSLog

/// 跨端 FocusSnapshot 的 iOS Codable mirror。
///
/// 自动上下文只描述「在哪」：App 类型、打开的 tab、时区等；不含正文 / 选区 / 附件。
/// 字段命名与 `@tabtin/contracts` FocusSnapshot 对齐（内层 camelCase；tab 子字段保留 snake）。
struct FocusSnapshot: Codable, Equatable, Sendable {
    var appType: String?
    var appMeta: [String: String]?
    var openTabs: [FocusTab]?
    var spaceId: String?
    var userTimeZone: String?
    var workspaceMode: String?

    static let maxOpenTabs = 20
    static let maxStringLength = 512

    /// 从工作台导航纯投影；调用方在发送/入队瞬间冻结结果，重试不得再读当前页面。
    ///
    /// - Parameters:
    ///   - isCompactLayout / compactSurface: 影响 `workspaceMode`（desktop / conversation）。
    ///     资源 tabs / appMeta **始终以导航里仍挂着的页面为准**——工作台还开着文档时
    ///     即使人在对话面发问也要带真实 id；只有导航已清空才降级为空焦点。
    @MainActor
    static func projecting(
        navigationState: WorkbenchNavigationState,
        spaceId: String?,
        viewMode: TaskViewMode,
        isCompactLayout: Bool = false,
        compactSurface: ConversationTaskSurface = .conversation,
        userTimeZone: String = TimeZone.current.identifier
    ) -> FocusSnapshot {
        let conversationOnly = isConversationOnlySurface(
            viewMode: viewMode,
            isCompactLayout: isCompactLayout,
            compactSurface: compactSurface
        )

        let mode = workspaceMode(
            for: viewMode,
            isCompactLayout: isCompactLayout,
            compactSurface: compactSurface,
            conversationOnly: conversationOnly
        )

        var activeTab = resolveActiveTab(navigationState)
        // Web NativeFocus 回写的 viewId 挂在导航旁路表；投影时合并进 active tab。
        if var tab = activeTab,
           let resourceId = tab.id,
           let viewId = navigationState.viewId(forResourceId: resourceId) {
            tab.viewId = viewId
            activeTab = tab
        }
        var tabs: [FocusTab] = []
        if var tab = activeTab {
            tab.active = true
            tabs = [tab]
        }

        return FocusSnapshot(
            appType: Self.bounded(activeTab?.app_key ?? activeTab?.type),
            appMeta: Self.safeAppMeta(for: activeTab),
            openTabs: tabs.isEmpty ? nil : Array(tabs.prefix(maxOpenTabs)),
            spaceId: Self.bounded(spaceId),
            userTimeZone: Self.bounded(userTimeZone),
            workspaceMode: mode
        )
    }

    /// 对话-only：regular 的 chatFocus，或 compact 的 conversation 面。
    /// 只驱动 workspaceMode；不再用来剥掉仍打开的资源焦点。
    static func isConversationOnlySurface(
        viewMode: TaskViewMode,
        isCompactLayout: Bool,
        compactSurface: ConversationTaskSurface
    ) -> Bool {
        if isCompactLayout {
            return compactSurface == .conversation
        }
        return viewMode == .chatFocus
    }

    /// 解析当前应上报的 tab：具体资源 id 优先于 App 首页壳。
    ///
    /// App 首页 sheet 内 push 资源后，`presentedPage` 可能仍是 `.appHome`，
    /// `presentedFocusTab` 也可能停在首页；真实 id 在 `path.last`。
    @MainActor
    static func resolveActiveTab(_ navigationState: WorkbenchNavigationState) -> FocusTab? {
        let pathTab = FocusTab.from(route: navigationState.path.last)
        let presentedResourceTab: FocusTab? = {
            guard case .resource = navigationState.presentedPage else { return nil }
            return navigationState.presentedPage?.focusTab
        }()
        let concreteCandidates: [FocusTab?] = [
            navigationState.presentedFocusTab,
            pathTab,
            presentedResourceTab,
        ]
        if let concrete = concreteCandidates.compactMap({ $0 }).first(where: {
            let id = $0.id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !id.isEmpty
        }) {
            return concrete
        }
        return navigationState.presentedFocusTab
            ?? navigationState.presentedPage?.focusTab
            ?? pathTab
            ?? FocusTab.from(appHome: navigationState.appHome)
    }

    func asAppContextDictionary(userTimeZoneFallback: String) -> [String: Any] {
        var context: [String: Any] = [
            "userTimeZone": userTimeZone ?? userTimeZoneFallback,
            "user_time_zone": userTimeZone ?? userTimeZoneFallback,
        ]
        if let appType { context["appType"] = appType }
        if let appMeta { context["appMeta"] = appMeta }
        if let openTabs {
            context["openTabs"] = openTabs.map(\.asDictionary)
        }
        if let spaceId {
            context["spaceId"] = spaceId
            context["current_space_id"] = spaceId
        }
        if let workspaceMode { context["workspaceMode"] = workspaceMode }
        return context
    }

    static func encodeForPersistence(_ snapshot: FocusSnapshot) throws -> Data {
        try JSONEncoder().encode(snapshot)
    }

    static func decodeFromPersistence(_ data: Data) throws -> FocusSnapshot {
        try JSONDecoder().decode(FocusSnapshot.self, from: data)
    }

    static func decodeFromPersistenceIfPresent(_ data: Data?) throws -> FocusSnapshot? {
        guard let data else { return nil }
        return try decodeFromPersistence(data)
    }

    /// 工作台/资源面 → desktop；纯对话面 → conversation（对齐 Electron scope 语义）。
    private static func workspaceMode(
        for viewMode: TaskViewMode,
        isCompactLayout: Bool,
        compactSurface: ConversationTaskSurface,
        conversationOnly: Bool
    ) -> String {
        if conversationOnly { return "conversation" }
        if isCompactLayout, compactSurface == .workbench { return "desktop" }
        switch viewMode {
        case .chatFocus: return "conversation"
        case .split, .appFocus: return "desktop"
        }
    }

    /// 正典 appMeta：`idField`/`titleField` 只放 manifest 字段名；资源值写入对应键。
    /// App 首页只注入 `current_app_home`，禁止把 appId 写成 `current_doc_id`。
    private static func safeAppMeta(for tab: FocusTab?) -> [String: String]? {
        guard let tab else { return nil }
        if tab.is_home == true {
            let appId = bounded(tab.app_home ?? tab.app_key ?? tab.type)
            guard let appId else { return nil }
            return ["current_app_home": appId]
        }
        let appKey = tab.app_key ?? tab.type
        guard let fields = manifestContextFields(for: appKey) else { return nil }

        var meta: [String: String] = [:]
        meta["idField"] = fields.idField
        if let id = bounded(tab.id) {
            meta[fields.idField] = id
        }
        if let titleField = fields.titleField {
            meta["titleField"] = titleField
            if let title = bounded(tab.title) {
                meta[titleField] = title
            }
        }
        // tabdata：有真实 viewId 才写 current_view_id；无则省略，禁止空串。
        if appKey == "tabdata", let viewId = bounded(tab.viewId) {
            meta["current_view_id"] = viewId
        }
        return meta
    }

    /// 与 `packages/apps/*/app.json` contextFields + Electron handler.appMeta 对齐的最小表。
    private static func manifestContextFields(
        for appKey: String
    ) -> (idField: String, titleField: String?)? {
        switch appKey {
        case "tabdoc":
            return ("current_doc_id", "current_doc_title")
        case "tabdata":
            return ("current_table_id", nil)
        case "tabslide":
            return ("current_slide_id", "current_slide_title")
        case "tabmemo":
            return ("current_memo_id", "current_memo_title")
        case "tabfiles":
            return ("current_file_id", "current_file_name")
        case "tabsite":
            return ("current_site_id", "current_site_title")
        default:
            return nil
        }
    }

    private static func bounded(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxStringLength))
    }
}

struct FocusTab: Codable, Equatable, Sendable {
    var type: String
    var id: String?
    var title: String?
    var active: Bool?
    var group_id: String?
    var app_key: String?
    var display_name: String?
    var is_home: Bool?
    var app_home: String?
    var path: String?
    var kind: String?
    var url: String?
    var session_id: String?
    /// 宿主内部：TabData 当前视图；只进 appMeta.current_view_id，不进 openTabs wire。
    var viewId: String?

    var asDictionary: [String: Any] {
        var dict: [String: Any] = ["type": type]
        if let id { dict["id"] = id }
        if let title { dict["title"] = title }
        if let active { dict["active"] = active }
        if let group_id { dict["group_id"] = group_id }
        if let app_key { dict["app_key"] = app_key }
        if let display_name { dict["display_name"] = display_name }
        if let is_home { dict["is_home"] = is_home }
        if let app_home { dict["app_home"] = app_home }
        if let path { dict["path"] = path }
        if let kind { dict["kind"] = kind }
        if let url { dict["url"] = url }
        if let session_id { dict["session_id"] = session_id }
        return dict
    }

    static func from(route: SpaceAppRoute?) -> FocusTab? {
        guard let route else { return nil }
        switch route {
        case let .tabdoc(documentId, documentName):
            return FocusTab(type: "tabdoc", id: documentId, title: documentName, app_key: "tabdoc")
        case let .tabdata(tableId, tableName):
            return FocusTab(type: "tabdata", id: tableId, title: tableName, app_key: "tabdata")
        case let .tabsite(siteId, siteUrl, siteName):
            return FocusTab(type: "tabsite", id: siteId, title: siteName, app_key: "tabsite", url: siteUrl)
        case let .tabslide(slideId, slideName):
            return FocusTab(type: "tabslide", id: slideId, title: slideName, app_key: "tabslide")
        case let .tabmemo(memoId, memoName, _):
            return FocusTab(type: "tabmemo", id: memoId, title: memoName, app_key: "tabmemo")
        case let .tabfiles(context):
            return FocusTab(
                type: "tabfiles",
                id: context.fileRecordId,
                title: context.title,
                app_key: "tabfiles"
            )
        }
    }

    static func from(appHome: TaskWorkbenchApp?) -> FocusTab? {
        guard let appHome else { return nil }
        // 首页 tab：id 不得写成 appId（否则会污染 current_doc_id=tabdoc）。
        return FocusTab(
            type: appHome.id,
            id: nil,
            title: appHome.name,
            active: true,
            app_key: appHome.id,
            display_name: appHome.name,
            is_home: true,
            app_home: appHome.id
        )
    }

    /// App 首页预览 / 卸页时的焦点回写。
    ///
    /// 打开具体资源后 SwiftUI 会卸掉 App 首页并触发 `onPreviewFocusChange(nil)`；
    /// 若此时无脑回落首页，会盖掉刚同步到宿主的资源 id，Agent 就会读成「文档 (首页)」。
    static func resolveAppHomePresentedFocus(
        previewItemId: String?,
        previewItemTitle: String?,
        resourceType: String,
        path: [SpaceAppRoute],
        appHome: TaskWorkbenchApp
    ) -> FocusTab? {
        if let previewItemId {
            let trimmed = previewItemId.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return FocusTab(
                    type: resourceType,
                    id: trimmed,
                    title: previewItemTitle,
                    active: true,
                    app_key: resourceType
                )
            }
        }
        if let routeTab = FocusTab.from(route: path.last) {
            return routeTab
        }
        return FocusTab.from(appHome: appHome)
    }
}

///  发送瞬间 Focus 取证：写入 App Documents，可用 devicectl 拉回。
enum FocusProbe {
    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "FocusProbe")
    private static let fileName = "focus-probe-latest.json"

    @MainActor
    static func dump(
        snapshot: FocusSnapshot,
        navigation: WorkbenchNavigationState,
        compactSurface: ConversationTaskSurface,
        viewMode: TaskViewMode
    ) {
        let openTab = snapshot.openTabs?.first
        let payload: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "compactSurface": String(describing: compactSurface),
            "viewMode": viewMode.rawValue,
            "hostPathCount": navigation.path.count,
            "hostPathLast": navigation.path.last.map { String(describing: $0) } ?? NSNull(),
            "hostPresentedPage": navigation.presentedPage.map { String(describing: $0) } ?? NSNull(),
            "hostPresentedFocusId": navigation.presentedFocusTab?.id as Any? ?? NSNull(),
            "hostPresentedFocusIsHome": navigation.presentedFocusTab?.is_home as Any? ?? NSNull(),
            "snapshotAppType": snapshot.appType as Any? ?? NSNull(),
            "snapshotWorkspaceMode": snapshot.workspaceMode as Any? ?? NSNull(),
            "snapshotOpenTabId": openTab?.id as Any? ?? NSNull(),
            "snapshotOpenTabIsHome": openTab?.is_home as Any? ?? NSNull(),
            "snapshotAppMeta": snapshot.appMeta as Any? ?? NSNull(),
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(
                withJSONObject: payload,
                options: [.prettyPrinted, .sortedKeys]
              )
        else { return }

        logger.info(
            "FOCUS_PROBE id=\(openTab?.id ?? "nil", privacy: .public) is_home=\(String(describing: openTab?.is_home), privacy: .public)"
        )

        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return
        }
        try? data.write(to: dir.appendingPathComponent(fileName), options: .atomic)
    }
}
