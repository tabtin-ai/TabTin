import Foundation
import SwiftUI
import os

struct MobileNotification: Decodable, Identifiable, Sendable {
    let id: String
    let type: String
    let title: String
    let body: String
    let metadata: [String: AnyCodable]
    let organizationId: String
    /// Canonical execution scope. Historical `space_id` is deliberately not folded into this
    /// field because old notifications used it for both Workspace and Project/resource hosts.
    let workspaceId: String?
    let projectId: String?
    let legacyHostId: String?
    let workspaceName: String?
    let projectName: String?
    let priority: String?
    let category: String?
    let sourceExtensionId: String?
    let navigateTo: [String: AnyCodable]?
    var isRead: Bool
    let readAt: String?
    let createdAt: String

    /// Agent 会话页的初始标题应使用通知副标题；通知标题描述的是事件本身。
    var conversationTitle: String {
        let subtitle = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return subtitle.isEmpty ? title : subtitle
    }

    var isDesktopOnly: Bool {
        metadata["desktop_only"]?.boolValue == true
    }

    enum CodingKeys: String, CodingKey {
        case id, type, title, body, metadata, priority, category
        case organizationId = "organization_id"
        case workspaceId = "workspace_id"
        case projectId = "project_id"
        case legacyHostId = "space_id"
        case workspaceName = "workspace_name"
        case projectName = "project_name"
        case sourceExtensionId = "source_extension_id"
        case navigateTo = "navigate_to"
        case isRead = "is_read"
        case readAt = "read_at"
        case createdAt = "created_at"
    }

    init(
        id: String,
        type: String,
        title: String,
        body: String,
        metadata: [String: AnyCodable],
        organizationId: String,
        workspaceId: String? = nil,
        projectId: String? = nil,
        legacyHostId: String? = nil,
        workspaceName: String? = nil,
        projectName: String? = nil,
        priority: String?,
        category: String?,
        sourceExtensionId: String?,
        navigateTo: [String: AnyCodable]?,
        isRead: Bool,
        readAt: String?,
        createdAt: String
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.body = body
        let canonicalMetadata = Self.normalizedMetadata(metadata)
        self.metadata = canonicalMetadata
        self.organizationId = organizationId
        let resolvedLegacyHostId = Self.nonEmpty(legacyHostId)
            ?? Self.string(canonicalMetadata, "legacy_host_id", "legacyHostId")
        self.workspaceId = Self.nonEmpty(workspaceId)
            ?? Self.string(canonicalMetadata, "workspace_id", "workspaceId")
        self.projectId = Self.nonEmpty(projectId)
            ?? Self.string(canonicalMetadata, "project_id", "projectId")
            ?? (Self.isLegacyProjectNotification(type) ? resolvedLegacyHostId : nil)
        self.legacyHostId = resolvedLegacyHostId
        self.workspaceName = Self.nonEmpty(workspaceName)
            ?? Self.string(canonicalMetadata, "workspace_name", "workspaceName")
        self.projectName = Self.nonEmpty(projectName)
            ?? Self.string(canonicalMetadata, "project_name", "projectName")
            ?? (Self.isLegacyProjectNotification(type)
                ? Self.string(canonicalMetadata, "space_name", "spaceName")
                : nil)
        self.priority = priority
        self.category = category
        self.sourceExtensionId = sourceExtensionId
        self.navigateTo = Self.normalizedNavigationTarget(navigateTo)
        self.isRead = isRead
        self.readAt = readAt
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata) ?? [:]
        self.init(
            id: try container.decode(String.self, forKey: .id),
            type: try container.decodeIfPresent(String.self, forKey: .type) ?? "system",
            title: try container.decodeIfPresent(String.self, forKey: .title) ?? "",
            body: try container.decodeIfPresent(String.self, forKey: .body) ?? "",
            metadata: metadata,
            organizationId: try container.decodeIfPresent(String.self, forKey: .organizationId) ?? "",
            workspaceId: try container.decodeIfPresent(String.self, forKey: .workspaceId),
            projectId: try container.decodeIfPresent(String.self, forKey: .projectId),
            legacyHostId: try container.decodeIfPresent(String.self, forKey: .legacyHostId),
            workspaceName: try container.decodeIfPresent(String.self, forKey: .workspaceName),
            projectName: try container.decodeIfPresent(String.self, forKey: .projectName),
            priority: try container.decodeIfPresent(String.self, forKey: .priority),
            category: try container.decodeIfPresent(String.self, forKey: .category),
            sourceExtensionId: try container.decodeIfPresent(String.self, forKey: .sourceExtensionId),
            navigateTo: try container.decodeIfPresent([String: AnyCodable].self, forKey: .navigateTo),
            isRead: try container.decodeIfPresent(Bool.self, forKey: .isRead) ?? false,
            readAt: try container.decodeIfPresent(String.self, forKey: .readAt),
            createdAt: try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        )
    }

    init?(payload: [String: Any]) {
        guard let id = payload["id"] as? String, !id.isEmpty else { return nil }
        let metadata = Self.codableDictionary(payload["metadata"] as? [String: Any])
        self.init(
            id: id,
            type: payload["type"] as? String ?? "system",
            title: payload["title"] as? String ?? "",
            body: payload["body"] as? String ?? "",
            metadata: metadata,
            organizationId: payload["organization_id"] as? String ?? "",
            workspaceId: payload["workspace_id"] as? String,
            projectId: payload["project_id"] as? String,
            legacyHostId: payload["space_id"] as? String,
            workspaceName: payload["workspace_name"] as? String,
            projectName: payload["project_name"] as? String,
            priority: payload["priority"] as? String,
            category: payload["category"] as? String,
            sourceExtensionId: payload["source_extension_id"] as? String,
            navigateTo: Self.codableDictionaryOrNil(payload["navigate_to"] as? [String: Any]),
            isRead: payload["is_read"] as? Bool ?? false,
            readAt: payload["read_at"] as? String,
            createdAt: payload["created_at"] as? String ?? ISO8601DateFormatter().string(from: Date())
        )
    }

    private static func codableDictionary(_ value: [String: Any]?) -> [String: AnyCodable] {
        (value ?? [:]).mapValues(AnyCodable.init)
    }

    private static func codableDictionaryOrNil(_ value: [String: Any]?) -> [String: AnyCodable]? {
        guard let value else { return nil }
        return value.mapValues(AnyCodable.init)
    }

    /// The decode/initializer boundary is the only place allowed to interpret historical
    /// `space_id`. Preserve it under an honest compatibility name instead of guessing its kind.
    private static func normalizedMetadata(
        _ metadata: [String: AnyCodable]
    ) -> [String: AnyCodable] {
        var result = metadata
        if let legacyHostId = string(metadata, "legacy_host_id", "legacyHostId", "space_id", "spaceId") {
            result["legacy_host_id"] = AnyCodable(legacyHostId)
        }
        result.removeValue(forKey: "space_id")
        result.removeValue(forKey: "spaceId")
        return result
    }

    private static func normalizedNavigationTarget(
        _ target: [String: AnyCodable]?
    ) -> [String: AnyCodable]? {
        guard var target else { return nil }
        if let legacyHostId = string(target, "legacy_host_id", "legacyHostId", "space_id", "spaceId") {
            target["legacy_host_id"] = AnyCodable(legacyHostId)
        }
        target.removeValue(forKey: "space_id")
        target.removeValue(forKey: "spaceId")
        return target
    }

    private static func string(_ source: [String: AnyCodable], _ keys: String...) -> String? {
        for key in keys {
            if let value = nonEmpty(source[key]?.stringValue) { return value }
        }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func isLegacyProjectNotification(_ type: String) -> Bool {
        type.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("team_space.")
    }
}

enum MobileNotificationCategory: String, CaseIterable, Hashable, Sendable {
    case task
    case collaboration
    case organization
    case system
}

enum MobileNotificationFilter: String, CaseIterable, Hashable, Sendable {
    case all
    case pending
    case task
    case collaboration
    case organization
    case system
}

enum MobileNotificationSource: Hashable, Sendable {
    case tabAgent
    case tabTracker
    case tabChat
    case tabDoc
    case tabData
    case tabMail
    case tabInbox
    case sharedResource
    case organization
    case extensionEvent
    case system
}

enum MobileNotificationPresentationPolicy {
    private static let pendingTypes = Set([
        "agent.hitl.waiting",
        "agent.task.error",
        "tracker.run.failed",
        "resource_access_request",
        "organization.invitation",
        "invite_received",
    ])

    static func category(for type: String) -> MobileNotificationCategory {
        let type = normalized(type)
        if type.hasPrefix("agent.") || type.hasPrefix("tracker.") {
            return .task
        }
        if type.hasPrefix("im.")
            || type.hasPrefix("tabdoc.")
            || type.hasPrefix("tabdata.")
            || [
                "resource_shared",
                "resource_access_request",
                "tabmail.received",
                "tabinbox.received",
                "tabinbox.route",
            ].contains(type) {
            return .collaboration
        }
        if type.hasPrefix("organization.")
            || type.hasPrefix("team_space.")
            || type.hasPrefix("invite_")
            || type.hasPrefix("member_")
            || type == "role_changed"
            || type == "ownership_transfer" {
            return .organization
        }
        return .system
    }

    static func isPending(_ notification: MobileNotification) -> Bool {
        !isResolved(notification)
            && (pendingTypes.contains(normalized(notification.type))
                || normalized(notification.priority) == "urgent")
    }

    static func hasPendingResourceAccessRequest(
        in notifications: [MobileNotification],
        requestId: String
    ) -> Bool {
        notifications.contains { notification in
            normalized(notification.type) == "resource_access_request"
                && metadataString(notification.metadata, "request_id", "requestId") == requestId
                && !isResolved(notification)
        }
    }

    static func filtered(
        _ notifications: [MobileNotification],
        by filter: MobileNotificationFilter
    ) -> [MobileNotification] {
        notifications.filter { matches($0, filter: filter) }
    }

    static func count(
        in notifications: [MobileNotification],
        for filter: MobileNotificationFilter
    ) -> Int {
        notifications.reduce(into: 0) { count, notification in
            if matches(notification, filter: filter) { count += 1 }
        }
    }

    static func source(for notification: MobileNotification) -> MobileNotificationSource {
        let type = normalized(notification.type)
        if type.hasPrefix("agent.") { return .tabAgent }
        if type.hasPrefix("tracker.") { return .tabTracker }
        if type.hasPrefix("im.") { return .tabChat }
        if type.hasPrefix("tabdoc.") { return .tabDoc }
        if type.hasPrefix("tabdata.") { return .tabData }
        if type == "tabmail.received" { return .tabMail }
        if type == "tabinbox.received" || type == "tabinbox.route" { return .tabInbox }
        if type == "resource_shared" || type == "resource_access_request" {
            switch metadataString(notification.metadata, "resource_type")?.lowercased() {
            case "doc", "document", "tabdoc": return .tabDoc
            case "table", "tabdata": return .tabData
            default: return .sharedResource
            }
        }
        if category(for: type) == .organization { return .organization }
        if type == "extension_event" || nonEmpty(notification.sourceExtensionId) != nil {
            return .extensionEvent
        }
        return .system
    }

    static func contextName(for notification: MobileNotification) -> String? {
        let name = nonEmpty(notification.projectName) ?? nonEmpty(notification.workspaceName)
        guard let name else { return nil }
        return displayText(name, for: notification.type)
    }

    static func displayTitle(for notification: MobileNotification) -> String {
        displayText(notification.title, for: notification.type)
    }

    static func displayBody(for notification: MobileNotification) -> String {
        displayText(notification.body, for: notification.type)
    }

    private static func matches(
        _ notification: MobileNotification,
        filter: MobileNotificationFilter
    ) -> Bool {
        switch filter {
        case .all: return true
        case .pending: return isPending(notification)
        case .task: return category(for: notification.type) == .task
        case .collaboration: return category(for: notification.type) == .collaboration
        case .organization: return category(for: notification.type) == .organization
        case .system: return category(for: notification.type) == .system
        }
    }

    private static func metadataString(
        _ metadata: [String: AnyCodable],
        _ keys: String...
    ) -> String? {
        for key in keys {
            if let value = nonEmpty(metadata[key]?.stringValue) { return value }
        }
        return nil
    }

    private static func isResolved(_ notification: MobileNotification) -> Bool {
        notification.metadata["resolved"]?.boolValue == true
            || normalized(metadataString(notification.metadata, "behavior")) == "notification_only"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func normalized(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    /// `team_space.*` is the Project-shell legacy event family. Normalize only its presentation
    /// copy; the wire snapshot remains untouched for audit and deep-link recovery.
    private static func displayText(_ value: String, for type: String) -> String {
        guard normalized(type).hasPrefix("team_space.") else { return value }
        return value
            .replacingOccurrences(of: "团队 Space", with: "项目")
            .replacingOccurrences(of: "团队空间", with: "项目")
            .replacingOccurrences(of: "项目房间", with: "项目")
            .replacingOccurrences(of: "Team Space", with: "Project", options: .caseInsensitive)
            .replacingOccurrences(of: "project room", with: "project", options: .caseInsensitive)
    }
}

private struct MobileNotificationListResponse: Decodable, Sendable {
    let items: [MobileNotification]
    let total: Int
    let page: Int
    let limit: Int
}

private struct NotificationUnreadCountResponse: Decodable, Sendable {
    let count: Int
}

private struct NotificationMarkAllResponse: Decodable, Sendable {
    let count: Int
}

private struct NotificationAgentSessionAcknowledgeResponse: Decodable, Sendable {
    let count: Int
}

enum MobileNotificationTarget: Hashable, Sendable {
    case chatSession(
        id: String,
        messageId: String?,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?
    )
    case imConversation(id: String, title: String?, messageId: String?, organizationId: String?)
    case tracker(
        id: String,
        runId: String?,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?
    )
    case app(
        id: String,
        resourceId: String?,
        title: String?,
        route: String?,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?,
        legacyHostId: String?
    )
    case sharedResource(
        id: String,
        resourceType: String,
        title: String?,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?,
        legacyHostId: String?
    )
    case resourceAccessRequest(MobileResourceAccessRequest)
    case invitation
    case profileSettings
    case notificationPanel
    case unsupported
}

struct MobileResourceAccessRequest: Hashable, Identifiable, Sendable {
    var id: String { requestId }
    let requestId: String
    let title: String
    let body: String
    let organizationId: String?
    let workspaceId: String?
    let projectId: String?
    let legacyHostId: String?
}

enum MobileNotificationTargetResolver {
    static func resolve(_ notification: MobileNotification) -> MobileNotificationTarget? {
        let metadata = notification.metadata
        let scopeOrganizationId = emptyToNil(notification.organizationId)
            ?? string(metadata, "organization_id", "organizationId")
        let scopeWorkspaceId = notification.workspaceId
        let scopeProjectId = notification.projectId
        let legacyHostId = notification.legacyHostId

        if let trackerTarget = trackerTarget(
            notification,
            organizationId: scopeOrganizationId,
            workspaceId: scopeWorkspaceId,
            projectId: scopeProjectId,
            legacyHostId: legacyHostId
        ) {
            return trackerTarget
        }

        if let explicit = notification.navigateTo ?? dictionary(metadata["navigate_to"]),
           let target = explicitTarget(
               explicit,
               organizationId: scopeOrganizationId,
               workspaceId: scopeWorkspaceId,
               projectId: scopeProjectId,
               legacyHostId: legacyHostId
           ) {
            return target
        }

        if notification.type == "organization.invitation" {
            return .invitation
        }

        if notification.type == "resource_access_request" {
            if notification.metadata["resolved"]?.boolValue == true
                || string(metadata, "behavior")?.lowercased() == "notification_only" {
                return .unsupported
            }
            guard let requestId = string(metadata, "request_id", "requestId") else {
                return .unsupported
            }
            return .resourceAccessRequest(MobileResourceAccessRequest(
                requestId: requestId,
                title: notification.title,
                body: notification.body,
                organizationId: scopeOrganizationId,
                workspaceId: scopeWorkspaceId,
                projectId: scopeProjectId,
                legacyHostId: legacyHostId
            ))
        }

        if let sessionId = string(metadata, "session_id", "sessionId"),
           notification.type.hasPrefix("agent.") {
            return .chatSession(
                id: sessionId,
                messageId: string(metadata, "message_id", "messageId"),
                organizationId: scopeOrganizationId,
                workspaceId: scopeWorkspaceId,
                projectId: scopeProjectId
            )
        }

        // IM 新消息桥接通知：navigate_to 缺失时按 type + conversation_id 兜底跳转。
        if notification.type.hasPrefix("im."),
           let conversationId = string(metadata, "conversation_id", "conversationId") {
            return .imConversation(
                id: conversationId,
                title: emptyToNil(notification.title),
                messageId: string(metadata, "message_id", "messageId"),
                organizationId: scopeOrganizationId
            )
        }

        if notification.type == "tabmail.received"
            || notification.type == "tabinbox.received"
            || notification.type == "tabinbox.route" {
            let messageId = string(metadata, "message_id", "messageId")
            let threadId = string(metadata, "thread_id", "threadId")
            let route = messageId.map { "message/\($0)" } ?? threadId.map { "thread/\($0)" }
            return .app(
                id: "tabmail",
                resourceId: nil,
                title: notification.title,
                route: route,
                organizationId: scopeOrganizationId,
                workspaceId: scopeWorkspaceId,
                projectId: scopeProjectId,
                legacyHostId: legacyHostId
            )
        }

        if notification.type == "resource_shared" {
            let action = string(metadata, "action")
            if ["removed", "auto_removed", "auto_removed_summary", "owner_reassigned_summary"].contains(action) {
                return .unsupported
            }
            guard let resourceType = string(metadata, "resource_type"),
                  let resourceId = string(metadata, "resource_id") else { return .unsupported }
            return .sharedResource(
                id: resourceId,
                resourceType: resourceType,
                title: string(metadata, "resource_title"),
                organizationId: scopeOrganizationId,
                workspaceId: scopeWorkspaceId,
                projectId: scopeProjectId,
                legacyHostId: legacyHostId
            )
        }

        if notification.type == "extension_event" {
            return .profileSettings
        }
        return .unsupported
    }

    /// Tracker 的底层 Agent DONE 与 Tracker 运行终态会各自落一条通知。后者
    /// 语义是任务详情，不能被历史 chat-session target 抢走，否则用户只会看见
    /// 用于审计的无标题 transcript。
    private static func trackerTarget(
        _ notification: MobileNotification,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?,
        legacyHostId: String?
    ) -> MobileNotificationTarget? {
        let metadata = notification.metadata
        guard let trackerId = string(metadata, "tracker_id", "trackerId") else { return nil }
        let isTrackerNotification = notification.type.hasPrefix("tracker.run.")
            || string(metadata, "notification_target") == "tracker"
        guard isTrackerNotification else { return nil }

        if notification.type.hasPrefix("tracker.run.") {
            let status = string(metadata, "tracker_event_status")
                ?? (notification.type == "tracker.run.completed" ? "completed" : nil)
            if status == "completed",
               let appId = artifactAppId(from: string(metadata, "skill_key")),
               let artifact = dictionary(metadata["artifact_ref"] ?? metadata["artifactRef"]),
               let resourceId = artifactResourceId(artifact) {
                return .app(
                    id: appId,
                    resourceId: resourceId,
                    title: notification.title,
                    route: nil,
                    organizationId: organizationId,
                    workspaceId: workspaceId,
                    projectId: projectId,
                    legacyHostId: legacyHostId
                )
            }
        }
        return .tracker(
            id: trackerId,
            runId: string(metadata, "run_id", "runId"),
            organizationId: organizationId,
            // Tracker's historical host was always its execution Workspace. Normalize it here
            // so the typed target never asks navigation callers to guess legacy host semantics.
            workspaceId: workspaceId ?? legacyHostId,
            projectId: projectId
        )
    }

    private static func explicitTarget(
        _ raw: [String: AnyCodable],
        organizationId: String?,
        workspaceId: String?,
        projectId: String?,
        legacyHostId: String?
    ) -> MobileNotificationTarget? {
        guard let type = raw["type"]?.stringValue,
              let id = raw["id"]?.stringValue,
              !type.isEmpty,
              !id.isEmpty else { return nil }
        let targetOrganizationId = raw["organizationId"]?.stringValue
            ?? raw["organization_id"]?.stringValue
            ?? organizationId
        let targetWorkspaceId = raw["workspaceId"]?.stringValue
            ?? raw["workspace_id"]?.stringValue
            ?? workspaceId
        let targetProjectId = raw["projectId"]?.stringValue
            ?? raw["project_id"]?.stringValue
            ?? projectId
        let targetLegacyHostId = raw["legacyHostId"]?.stringValue
            ?? raw["legacy_host_id"]?.stringValue
            ?? raw["spaceId"]?.stringValue
            ?? raw["space_id"]?.stringValue
            ?? legacyHostId
        switch type {
        case "chat-session":
            return .chatSession(
                id: id,
                messageId: raw["messageId"]?.stringValue ?? raw["message_id"]?.stringValue,
                organizationId: targetOrganizationId,
                workspaceId: targetWorkspaceId,
                projectId: targetProjectId
            )
        case "im-conversation":
            return .imConversation(
                id: id,
                title: raw["title"]?.stringValue,
                messageId: raw["messageId"]?.stringValue ?? raw["message_id"]?.stringValue,
                organizationId: targetOrganizationId
            )
        case "tracker":
            return .tracker(
                id: id,
                runId: raw["runId"]?.stringValue ?? raw["run_id"]?.stringValue,
                organizationId: targetOrganizationId,
                // A Tracker legacy host is known to be its execution Workspace.
                workspaceId: targetWorkspaceId ?? targetLegacyHostId,
                projectId: targetProjectId
            )
        case "agentspace-app", "extension":
            let artifact = dictionary(raw["artifactRef"]) ?? dictionary(raw["artifact_ref"])
            return .app(
                id: id,
                resourceId: artifactResourceId(artifact),
                title: nil,
                route: raw["route"]?.stringValue,
                organizationId: targetOrganizationId,
                workspaceId: targetWorkspaceId,
                projectId: targetProjectId,
                legacyHostId: targetLegacyHostId
            )
        case "resource-shared":
            guard let resourceType = raw["resourceType"]?.stringValue ?? raw["resource_type"]?.stringValue else {
                return nil
            }
            return .sharedResource(
                id: id,
                resourceType: resourceType,
                title: raw["resourceTitle"]?.stringValue ?? raw["resource_title"]?.stringValue,
                organizationId: targetOrganizationId,
                workspaceId: targetWorkspaceId,
                projectId: targetProjectId,
                legacyHostId: targetLegacyHostId
            )
        case "settings": return .profileSettings
        // 通知中心内点击 notification-panel 没有新的页面可打开，按信息通知反馈。
        case "notification-panel": return .unsupported
        default: return .unsupported
        }
    }

    private static func artifactResourceId(_ raw: [String: AnyCodable]?) -> String? {
        guard let raw else { return nil }
        for key in ["artifactId", "memoId", "docId", "slideId", "tableId", "codePath"] {
            if let value = raw[key]?.stringValue, !value.isEmpty { return value }
        }
        return nil
    }

    private static func artifactAppId(from skillKey: String?) -> String? {
        guard let skillKey else { return nil }
        let normalized = skillKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }
        let candidate = normalized.split(separator: ".", maxSplits: 1).first
            .map(String.init)?
            .split(separator: "-", maxSplits: 1).first
            .map(String.init)
            ?? normalized
        let supported = Set(["tabdoc", "tabdata", "tabslide", "tabmemo", "tabsite", "tabfiles"])
        return supported.contains(candidate) ? candidate : nil
    }

    private static func string(_ source: [String: AnyCodable], _ keys: String...) -> String? {
        for key in keys {
            if let value = source[key]?.stringValue, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return value
            }
        }
        return nil
    }

    private static func dictionary(_ value: AnyCodable?) -> [String: AnyCodable]? {
        guard let raw = value?.dictValue else { return nil }
        return raw.mapValues(AnyCodable.init)
    }

    private static func emptyToNil(_ value: String) -> String? {
        value.isEmpty ? nil : value
    }
}

/// 通知是历史快照，早期 Agent 通知可能没有执行 Workspace。会话详情才是已有
/// 会话冻结执行范围的事实来源；仅在通知缺失 Workspace 时用它补齐跳转目标。
enum MobileNotificationChatSessionTargetResolver {
    static func resolve(
        _ target: MobileNotificationTarget,
        session: ChatSession
    ) -> MobileNotificationTarget? {
        guard case let .chatSession(id, messageId, organizationId, _, projectId) = target,
              let workspaceId = nonEmpty(session.workspaceId) else {
            return nil
        }
        return .chatSession(
            id: id,
            messageId: messageId,
            organizationId: nonEmpty(session.organizationId) ?? organizationId,
            workspaceId: workspaceId,
            projectId: nonEmpty(session.projectId) ?? projectId
        )
    }

    static func requiresSessionScope(_ target: MobileNotificationTarget) -> Bool {
        guard case let .chatSession(_, _, _, workspaceId, _) = target else { return false }
        return nonEmpty(workspaceId) == nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

@MainActor @Observable
final class NotificationStore {
    static let shared = NotificationStore()

    private(set) var notifications: [MobileNotification] = []
    private(set) var unreadCount = 0
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var currentOrganizationId: String?

    private var isRealtimeStarted = false
    private var requestSequence = 0
    private var localMutationRevision = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "NotificationStore")

    private init() {
        AuthService.shared.registerLogoutHook { [weak self] in self?.clear() }
    }

    func activate(organizationId: String?) async {
        startRealtimeIfNeeded()
        if currentOrganizationId != organizationId {
            currentOrganizationId = organizationId
            notifications = []
            unreadCount = 0
            requestSequence += 1
        }
        async let list: Void = reload()
        async let count: Void = reloadUnreadCount()
        _ = await (list, count)
    }

    func reload() async {
        guard AuthService.shared.isAuthenticated else { return }
        requestSequence += 1
        let sequence = requestSequence
        let mutationRevision = localMutationRevision
        let organizationId = currentOrganizationId
        isLoading = notifications.isEmpty
        errorMessage = nil
        do {
            var query = ["page": "1", "limit": "50"]
            if let organizationId {
                query["organization_id"] = organizationId
                query["include_personal_invitations"] = "true"
            }
            let response: MobileNotificationListResponse = try await APIClient.shared.get(
                path: Endpoints.Notifications.list,
                query: query
            )
            guard sequence == requestSequence, organizationId == currentOrganizationId else { return }
            let serverItems = response.items.sorted { $0.createdAt > $1.createdAt }
            notifications = mutationRevision == localMutationRevision
                ? serverItems
                : mergeServerItems(serverItems, with: notifications)
        } catch {
            guard sequence == requestSequence else { return }
            if !error.isCancellation {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                logger.error("notification list reload failed: \(error.localizedDescription)")
            }
        }
        if sequence == requestSequence { isLoading = false }
    }

    func reloadUnreadCount() async {
        guard AuthService.shared.isAuthenticated else { return }
        let organizationId = currentOrganizationId
        let mutationRevision = localMutationRevision
        var query: [String: String]? = nil
        if let organizationId {
            query = [
                "organization_id": organizationId,
                "include_personal_invitations": "true",
            ]
        }
        do {
            let response: NotificationUnreadCountResponse = try await APIClient.shared.get(
                path: Endpoints.Notifications.unreadCount,
                query: query
            )
            guard organizationId == currentOrganizationId,
                  mutationRevision == localMutationRevision else { return }
            unreadCount = max(0, response.count)
        } catch {
            logger.debug("notification unread reload failed: \(error.localizedDescription)")
        }
    }

    func markRead(_ notification: MobileNotification) {
        let current = notifications.first(where: { $0.id == notification.id })
        guard !(current?.isRead ?? notification.isRead) else { return }
        localMutationRevision += 1
        notifications = notifications.map { item in
            guard item.id == notification.id else { return item }
            var updated = item
            updated.isRead = true
            return updated
        }
        unreadCount = max(0, unreadCount - 1)
        Task {
            do {
                let _: ApiEnvelope<String?> = try await APIClient.shared.post(
                    path: Endpoints.Notifications.markRead(notification.id)
                )
            } catch {
                logger.debug("mark notification read failed id=\(notification.id): \(error.localizedDescription)")
                await reload()
                await reloadUnreadCount()
            }
        }
    }

    func markAllRead() async {
        let organizationId = currentOrganizationId
        localMutationRevision += 1
        let unreadIds = Set(notifications.filter { !$0.isRead }.map(\.id))
        notifications = notifications.map { item in
            guard unreadIds.contains(item.id) else { return item }
            var updated = item
            updated.isRead = true
            return updated
        }
        unreadCount = 0
        do {
            var path = Endpoints.Notifications.markAllRead
            if let organizationId,
               let encoded = organizationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                path += "?organization_id=\(encoded)&include_personal_invitations=true"
            }
            let _: NotificationMarkAllResponse = try await APIClient.shared.post(path: path)
            await reload()
            await reloadUnreadCount()
        } catch {
            logger.error("mark all notifications read failed: \(error.localizedDescription)")
            await reload()
            await reloadUnreadCount()
        }
    }

    /// 用户进入 Agent 会话即视为读到该会话最新终态。先本地清蓝点，再由后端推送多端收敛。
    func acknowledgeAgentSession(_ sessionId: String) {
        let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else { return }
        let terminalTypes = Set([
            "agent.task.completed",
            "agent.task.error",
            "agent.task.interrupted",
        ])
        let unreadIds = Set(notifications.compactMap { item -> String? in
            guard !item.isRead,
                  terminalTypes.contains(item.type),
                  item.metadata["session_id"]?.stringValue == sid else { return nil }
            return item.id
        })
        if !unreadIds.isEmpty {
            localMutationRevision += 1
            notifications = notifications.map { item in
                guard unreadIds.contains(item.id) else { return item }
                var updated = item
                updated.isRead = true
                return updated
            }
            unreadCount = max(0, unreadCount - unreadIds.count)
        }

        Task {
            do {
                let _: NotificationAgentSessionAcknowledgeResponse = try await APIClient.shared.post(
                    path: Endpoints.Notifications.acknowledgeAgentSession(sid)
                )
            } catch {
                logger.debug("acknowledge agent session failed session=\(String(sid.prefix(8))): \(error.localizedDescription)")
                await reload()
                await reloadUnreadCount()
            }
        }
    }

    private func startRealtimeIfNeeded() {
        guard !isRealtimeStarted else { return }
        isRealtimeStarted = true
        RealtimeGateway.shared.addEnvelopeListener(key: "notification-store") { [weak self] envelope in
            self?.handleEnvelope(envelope)
        }
        RealtimeGateway.shared.addReconnectListener(key: "notification-store") { [weak self] in
            guard let self else { return }
            Task { @MainActor in await self.activate(organizationId: self.currentOrganizationId) }
        }
    }

    private func handleEnvelope(_ envelope: WSEnvelope) {
        guard envelope.type == "agent.user.notification.new",
              let item = MobileNotification(payload: envelope.payloadDict) else { return }
        guard !item.isDesktopOnly else { return }
        guard Self.isVisible(item, in: currentOrganizationId) else {
            return
        }
        localMutationRevision += 1
        if let index = notifications.firstIndex(where: { $0.id == item.id }) {
            let previous = notifications[index]
            notifications[index] = item
            unreadCount = max(0, unreadCount + (item.isRead ? 0 : 1) - (previous.isRead ? 0 : 1))
        } else {
            notifications.insert(item, at: 0)
            if !item.isRead { unreadCount += 1 }
        }
    }

    private func mergeServerItems(
        _ serverItems: [MobileNotification],
        with localItems: [MobileNotification]
    ) -> [MobileNotification] {
        var merged = Dictionary(uniqueKeysWithValues: serverItems.map { ($0.id, $0) })
        for item in localItems {
            merged[item.id] = item
        }
        return Array(merged.values)
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(50)
            .map { $0 }
    }

    private func clear() {
        requestSequence += 1
        notifications = []
        unreadCount = 0
        isLoading = false
        errorMessage = nil
        currentOrganizationId = nil
    }

    /// 铃铛仍按当前组织收口；仅组织邀请是账号级收件，目标组织尚未加入时也必须显示。
    nonisolated static func isVisible(_ item: MobileNotification, in organizationId: String?) -> Bool {
        guard let organizationId,
              !item.organizationId.isEmpty,
              item.organizationId != organizationId else {
            return true
        }
        return item.type.hasPrefix("organization.invitation")
    }
}

struct NotificationBellButton: View {
    let unreadCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // iPadOS 26 会裁掉 toolbar label 边界之外的 overlay；用完整的 32pt
            // 按钮布局承载图标和徽标。1～99 保持原布局；99+ 用两位数占位
            // 稳定测量宽度，真实徽标只覆盖显示，避免把图标挤离原位置。
            ZStack(alignment: .topTrailing) {
                ActivityRailNotificationIcon()
                    .frame(width: 21, height: 21)

                if unreadCount > 99 {
                    unreadBadge("99")
                        .hidden()
                        .overlay { unreadBadge("99+").fixedSize() }
                        .offset(x: 8, y: -7)
                } else if unreadCount > 0 {
                    unreadBadge(String(unreadCount))
                        .offset(x: 8, y: -7)
                }
            }
            .frame(width: 32, height: 32)
        }
        .accessibilityLabel(L10n.Notifications.title)
        .accessibilityValue(
            unreadCount > 0
                ? L10n.Notifications.unreadCount(unreadCount)
                : L10n.Notifications.noUnread
        )
    }

    private func unreadBadge(_ text: String) -> some View {
        Text(text)
            .font(.tt.iconCaption)
            .foregroundStyle(.white)
            .padding(.horizontal, text.count > 1 ? 3 : 4)
            .frame(minWidth: 15, minHeight: 15)
            .background(.tt.textCritical, in: Capsule())
    }
}

struct NotificationCenterScreen: View {
    let onOpenConversation: (ConversationTarget) -> Void
    var onOpenIMConversation: ((IMConversationTarget) -> Void)?

    @State private var store = NotificationStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var projectStore = ProjectStore.shared
    @State private var selectedFilter: MobileNotificationFilter = .all
    @State private var navigationNotice: NotificationOpenNotice?
    @State private var navigationNoticeDismissTask: Task<Void, Never>?
    @State private var resourceAccessRequest: MobileResourceAccessRequest?
    @State private var approvingResourceAccessRequestId: String?
    private let imService = IMConversationService()

    var body: some View {
        Group {
            if store.isLoading && store.notifications.isEmpty {
                ProgressView(L10n.Notifications.loading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.errorMessage, store.notifications.isEmpty {
                errorState(error)
            } else if store.notifications.isEmpty {
                ContentUnavailableView(
                    L10n.Notifications.empty,
                    systemImage: "bell",
                    description: Text(L10n.Notifications.emptyDescription)
                )
            } else {
                notificationList
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(L10n.Notifications.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.unreadCount > 0 {
                    Button(L10n.Notifications.markAllRead) { Task { await store.markAllRead() } }
                }
            }
        }
        .task { await store.activate(organizationId: workspace.selectedOrganizationId) }
        .sheet(item: $resourceAccessRequest) { request in
            ResourceAccessRequestConfirmSheet(
                request: request,
                isApproving: approvingResourceAccessRequestId == request.requestId,
                onCancel: {
                    guard approvingResourceAccessRequestId == nil else { return }
                    resourceAccessRequest = nil
                },
                onApprove: {
                    approveResourceAccessRequest(request)
                }
            )
            .presentationDetents([.height(260)])
            .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .top) {
            if let notice = navigationNotice {
                NotificationOpenToast(message: notice.message)
                    .padding(.horizontal, TTSpacing.lg)
                    .padding(.top, TTSpacing.lg)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: navigationNotice?.id)
        .onChange(of: navigationNotice?.id) { _, noticeId in
            navigationNoticeDismissTask?.cancel()
            guard let noticeId else { return }
            navigationNoticeDismissTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2.4))
                guard !Task.isCancelled, navigationNotice?.id == noticeId else { return }
                withAnimation(.easeInOut(duration: 0.2)) { navigationNotice = nil }
            }
        }
        .onDisappear {
            navigationNoticeDismissTask?.cancel()
            navigationNoticeDismissTask = nil
        }
        .onChange(of: resourceAccessRequestStillPending) { _, stillPending in
            guard !stillPending, resourceAccessRequest != nil else { return }
            resourceAccessRequest = nil
            approvingResourceAccessRequestId = nil
        }
    }

    private var notificationList: some View {
        VStack(spacing: 0) {
            NotificationFilterBar(
                notifications: store.notifications,
                selection: $selectedFilter
            )

            if visibleNotifications.isEmpty {
                GeometryReader { geometry in
                    ScrollView {
                        ContentUnavailableView(
                            L10n.Notifications.filteredEmpty,
                            systemImage: "line.3.horizontal.decrease.circle",
                            description: Text(L10n.Notifications.filteredEmptyDescription)
                        )
                        .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                    }
                    .refreshable { await refreshNotifications() }
                }
            } else {
                List(visibleNotifications) { notification in
                    Button { handle(notification) } label: {
                        NotificationRow(
                            notification: notification,
                            contextName: contextName(for: notification)
                        )
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
                .refreshable { await refreshNotifications() }
            }
        }
    }

    private func refreshNotifications() async {
        await store.reload()
        await store.reloadUnreadCount()
    }

    private var visibleNotifications: [MobileNotification] {
        MobileNotificationPresentationPolicy.filtered(store.notifications, by: selectedFilter)
    }

    private var resourceAccessRequestStillPending: Bool {
        guard let requestId = resourceAccessRequest?.requestId else { return false }
        return MobileNotificationPresentationPolicy.hasPendingResourceAccessRequest(
            in: store.notifications,
            requestId: requestId
        )
    }

    private func contextName(for notification: MobileNotification) -> String? {
        if let name = MobileNotificationPresentationPolicy.contextName(for: notification) {
            return name
        }
        if let projectId = notification.projectId,
           let name = projectStore.project(id: projectId)?.name,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return name
        }
        if let workspaceId = notification.workspaceId,
           let name = workspace.spaces.first(where: { $0.id == workspaceId })?.name,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return name
        }
        return nil
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message, prominence: .inline) {
            Task { await store.activate(organizationId: workspace.selectedOrganizationId) }
        }
        .padding(TTSpacing.xl)
    }

    private func handle(_ notification: MobileNotification) {
        store.markRead(notification)
        guard let target = MobileNotificationTargetResolver.resolve(notification) else {
            presentNavigationNotice(L10n.Notifications.informationalNotice)
            return
        }
        Task { @MainActor in
            guard let resolved = await navigationTarget(target) else {
                presentNavigationNotice(L10n.Notifications.chatScopeMissing)
                return
            }
            let target = resolved.target
            guard await selectOrganizationIfNeeded(target) else {
                if workspace.organizationAccessRevokedNotice == nil {
                    presentNavigationNotice(L10n.Notifications.organizationUnavailable)
                }
                return
            }
            guard await targetIsAccessible(
                notification,
                target,
                knownChatSession: resolved.chatSession
            ) else {
                presentNavigationNotice(L10n.Notifications.informationalNotice)
                return
            }
            switch target {
            case let .chatSession(id, messageId, organizationId, workspaceId, projectId):
                guard let workspaceId else {
                    presentNavigationNotice(L10n.Notifications.chatScopeMissing)
                    return
                }
                let target = ConversationTarget(
                    title: notification.conversationTitle,
                    workspaceId: workspaceId,
                    organizationId: organizationId ?? workspace.selectedOrganizationId ?? "",
                    projectId: projectId,
                    sessionId: id,
                    messageId: messageId
                )
                onOpenConversation(target)
            case let .imConversation(id, title, _, _):
                guard let onOpenIMConversation else {
                    presentNavigationNotice(L10n.Notifications.informationalNotice)
                    return
                }
                let imTarget = IMConversationTarget(
                    conversationId: id,
                    title: title ?? notification.title
                )
                onOpenIMConversation(imTarget)
            case let .tracker(id, runId, organizationId, workspaceId, _):
                guard let organizationId = organizationId ?? workspace.selectedOrganizationId,
                      let workspaceId else {
                    presentNavigationNotice(L10n.Notifications.trackerScopeMissing)
                    return
                }
                MainRouter.shared.openAutomation(AutomationDeepLinkTarget(
                    organizationId: organizationId,
                    // Legacy deep-link adapter: AutomationDeepLinkTarget still calls Workspace `spaceId`.
                    spaceId: workspaceId,
                    trackerId: id,
                    runId: runId
                ))
            case let .app(
                id, resourceId, title, route, organizationId, workspaceId, projectId, legacyHostId
            ):
                guard let organizationId = organizationId ?? workspace.selectedOrganizationId else {
                    presentNavigationNotice(L10n.Notifications.artifactScopeMissing)
                    return
                }
                guard let resourceId else {
                    presentNavigationNotice(L10n.Notifications.desktopOnlyArtifact)
                    return
                }
                MainRouter.shared.openResource(ResourceDeepLinkTarget(
                    resourceType: id,
                    resourceId: resourceId,
                    title: title ?? notification.title,
                    locationHint: route,
                    organizationId: organizationId,
                    // Legacy deep-link adapter: the resource router still calls its optional host `spaceId`.
                    spaceId: projectId ?? workspaceId ?? legacyHostId
                ))
            case let .sharedResource(
                id, resourceType, title, organizationId, workspaceId, projectId, legacyHostId
            ):
                guard let organizationId = organizationId ?? workspace.selectedOrganizationId else {
                    presentNavigationNotice(L10n.Notifications.sharedResourceUnavailable)
                    return
                }
                MainRouter.shared.openResource(ResourceDeepLinkTarget(
                    resourceType: resourceType,
                    resourceId: id,
                    title: title ?? notification.title,
                    locationHint: nil,
                    organizationId: organizationId,
                    // Legacy deep-link adapter: the resource router still calls its optional host `spaceId`.
                    spaceId: projectId ?? workspaceId ?? legacyHostId
                ))
            case let .resourceAccessRequest(request):
                resourceAccessRequest = request
            case .invitation:
                Task { await InvitationService.shared.loadMyPendingInvitations() }
                AccountDrawerCoordinator.shared.enqueueGlobalDestination(.organizationInvitation)
            case .profileSettings:
                AccountDrawerCoordinator.shared.enqueueGlobalDestination(.settings)
            case .notificationPanel:
                break
            case .unsupported:
                presentNavigationNotice(L10n.Notifications.informationalNotice)
            }
        }
    }

    private func presentNavigationNotice(_ message: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            navigationNotice = NotificationOpenNotice(message: message)
        }
    }

    private func approveResourceAccessRequest(_ request: MobileResourceAccessRequest) {
        guard approvingResourceAccessRequestId == nil else { return }
        approvingResourceAccessRequestId = request.requestId
        Task { @MainActor in
            do {
                _ = try await imService.approveResourceAccessRequest(id: request.requestId)
                resourceAccessRequest = nil
                presentNavigationNotice("已授予查看权限")
                await store.reload()
                await store.reloadUnreadCount()
            } catch {
                presentNavigationNotice(error.localizedDescription)
            }
            approvingResourceAccessRequestId = nil
        }
    }

    /// 正常通知已有 scope，保留原本的单次可达性校验。只有旧通知缺 scope 时才
    /// 预取会话详情并把服务端冻结 scope 带入后续路由。
    @MainActor
    private func navigationTarget(_ target: MobileNotificationTarget) async -> ResolvedNotificationTarget? {
        guard MobileNotificationChatSessionTargetResolver.requiresSessionScope(target) else {
            return ResolvedNotificationTarget(target: target, chatSession: nil)
        }
        do {
            let session: ChatSession = try await APIClient.shared.get(
                path: Endpoints.Chat.session(chatSessionId(from: target))
            )
            guard let target = MobileNotificationChatSessionTargetResolver.resolve(target, session: session) else {
                return nil
            }
            return ResolvedNotificationTarget(target: target, chatSession: session)
        } catch {
            return nil
        }
    }

    private func chatSessionId(from target: MobileNotificationTarget) -> String {
        guard case let .chatSession(id, _, _, _, _) = target else { return "" }
        return id
    }

    /// 通知中心保存的是历史事实；跳转前只校验会话、Tracker 和待处理审批这几类
    /// 容易失效的深链接。其余入口保留原有行为，避免把网络抖动放大成全局阻塞。
    @MainActor
    private func targetIsAccessible(
        _ notification: MobileNotification,
        _ target: MobileNotificationTarget,
        knownChatSession: ChatSession? = nil
    ) async -> Bool {
        do {
            switch target {
            case let .chatSession(id, _, _, _, _):
                if knownChatSession == nil {
                    let _: ChatSession = try await APIClient.shared.get(path: Endpoints.Chat.session(id))
                }
                guard notification.type == "agent.hitl.waiting" else { return true }
                let interactionId = notification.metadata["interaction_id"]?.stringValue
                    ?? notification.metadata["interactionId"]?.stringValue
                let requestKey = notification.metadata["request_key"]?.stringValue
                    ?? notification.metadata["requestKey"]?.stringValue
                guard interactionId != nil || requestKey != nil else { return true }
                switch await PendingInteractionStore.shared.refreshSession(id) {
                case let .success(interactions):
                    return interactions.contains { interaction in
                        interaction.id == interactionId || interaction.requestKey == requestKey
                    }
                case .failure:
                    // HITL 权威刷新失败：fail-closed，不假装「无待办」。
                    return false
                }
            case let .tracker(id, _, _, _, _):
                let _: Tracker = try await APIClient.shared.get(path: Endpoints.TabTracker.event(id))
                return true
            default:
                return true
            }
        } catch {
            return false
        }
    }

    private func selectOrganizationIfNeeded(_ target: MobileNotificationTarget) async -> Bool {
        let targetId: String?
        switch target {
        case let .chatSession(_, _, organizationId, _, _),
             let .imConversation(_, _, _, organizationId),
             let .tracker(_, _, organizationId, _, _),
             let .app(_, _, _, _, organizationId, _, _, _),
             let .sharedResource(_, _, _, organizationId, _, _, _):
            targetId = organizationId
        case let .resourceAccessRequest(request):
            targetId = request.organizationId
        default:
            return true
        }
        guard let targetId, targetId != workspace.selectedOrganizationId else { return true }
        guard await workspace.loadOrganizations() else { return false }
        guard let organization = workspace.organizations.first(where: { $0.id == targetId }) else {
            workspace.notifyOrganizationAccessRevoked(organizationId: targetId)
            return false
        }
        await workspace.selectOrganization(organization)
        return workspace.selectedOrganizationId == targetId
    }
}

private struct ResolvedNotificationTarget {
    let target: MobileNotificationTarget
    let chatSession: ChatSession?
}

private struct NotificationOpenNotice: Identifiable {
    let id = UUID()
    let message: String
}

private struct ResourceAccessRequestConfirmSheet: View {
    let request: MobileResourceAccessRequest
    let isApproving: Bool
    let onCancel: () -> Void
    let onApprove: () -> Void

    private var title: String {
        let trimmed = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "确认授予查看权限？" : trimmed
    }

    private var bodyText: String {
        let trimmed = request.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty
            ? "确认后对方将获得该资源的查看（viewer）权限。取消仅关闭弹窗，申请仍保持待处理。"
            : trimmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                Text(title)
                    .font(.tt.headingSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.tt.bodyMedium.weight(.semibold))
                        .foregroundStyle(.tt.textSecondary)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .disabled(isApproving)
            }

            Text(bodyText)
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(3)

            Spacer(minLength: 0)

            HStack(spacing: 12) {
                Spacer()
                Button("取消", action: onCancel)
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(isApproving)
                Button(isApproving ? "授权中…" : "确认授权", action: onApprove)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(.tt.bgAccent)
                    .disabled(isApproving)
            }
        }
        .padding(24)
        .presentationBackground(.tt.bgCanvasDefault)
    }
}

private struct NotificationOpenToast: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textWarning)
                .frame(width: 20, height: 20)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.bgWarning.opacity(0.25), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
    }
}

private struct NotificationFilterBar: View {
    let notifications: [MobileNotification]
    @Binding var selection: MobileNotificationFilter

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.sm) {
                ForEach(MobileNotificationFilter.allCases, id: \.self) { filter in
                    let isSelected = selection == filter
                    Button {
                        selection = filter
                    } label: {
                        HStack(spacing: TTSpacing.xs) {
                            Text(filter.localizedLabel)
                                .font(.tt.bodyMedium)
                            Text(String(MobileNotificationPresentationPolicy.count(
                                in: notifications,
                                for: filter
                            )))
                            .font(.tt.captionMedium)
                            .opacity(0.8)
                        }
                        .foregroundStyle(isSelected ? .tt.bgCanvasDefault : .tt.textSecondary)
                        .padding(.horizontal, TTSpacing.md)
                        .frame(minHeight: 44)
                        .background(
                            isSelected ? .tt.textPrimary : .tt.bgSubtle,
                            in: RoundedRectangle(
                                cornerRadius: TTRadius.interactive,
                                style: .continuous
                            )
                        )
                        .overlay {
                            RoundedRectangle(
                                cornerRadius: TTRadius.interactive,
                                style: .continuous
                            )
                            .strokeBorder(
                                isSelected ? Color.clear : .tt.borderLight,
                                lineWidth: 0.5
                            )
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.sm)
        }
        .background(.tt.bgCanvasDefault)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(.tt.borderLight)
                .frame(height: 0.5)
        }
    }
}

private struct NotificationRow: View {
    let notification: MobileNotification
    let contextName: String?

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.md) {
            ZStack {
                Circle()
                    .fill(iconColor.opacity(0.12))
                    .frame(width: 38, height: 38)
                Image(systemName: icon)
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(iconColor)
            }

            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(source.localizedLabel)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.horizontal, TTSpacing.xs)
                        .padding(.vertical, TTSpacing.xxs)
                        .background(
                            .tt.bgSubtle,
                            in: RoundedRectangle(cornerRadius: TTRadius.xs, style: .continuous)
                        )
                        .fixedSize(horizontal: true, vertical: false)
                    if let contextName {
                        Text("·")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                        Text(contextName)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(RelativeTime.format(notification.createdAt) ?? notification.createdAt)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .fixedSize(horizontal: true, vertical: false)
                }
                Text(displayTitle.isEmpty ? L10n.Notifications.unknown : displayTitle)
                    .font(notification.isRead ? .tt.body : .tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                if !displayBody.isEmpty {
                    Text(displayBody)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
            }

            if !notification.isRead {
                Circle()
                    .fill(.tt.bgAccent)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
            }
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(
            notification.isRead
                ? L10n.Notifications.readStatusRead
                : L10n.Notifications.readStatusUnread
        )
    }

    private var iconColor: Color {
        switch notification.priority {
        case "urgent": return .tt.textCritical
        case "high": return .tt.textWarning
        default: return .tt.iconAccent
        }
    }

    private var icon: String {
        switch source {
        case .tabAgent: return "sparkles"
        case .tabTracker: return "clock.badge.checkmark"
        case .tabChat: return "bubble.left.and.bubble.right"
        case .tabDoc: return "doc.text"
        case .tabData: return "tablecells"
        case .tabMail, .tabInbox: return "envelope"
        case .sharedResource: return "square.and.arrow.up"
        case .organization: return "person.2"
        case .extensionEvent: return "puzzlepiece.extension"
        case .system: return "bell"
        }
    }

    private var source: MobileNotificationSource {
        MobileNotificationPresentationPolicy.source(for: notification)
    }

    private var displayTitle: String {
        MobileNotificationPresentationPolicy.displayTitle(for: notification)
    }

    private var displayBody: String {
        MobileNotificationPresentationPolicy.displayBody(for: notification)
    }
}

private extension MobileNotificationFilter {
    var localizedLabel: String {
        switch self {
        case .all: return L10n.Notifications.filterAll
        case .pending: return L10n.Notifications.filterPending
        case .task: return L10n.Notifications.filterTask
        case .collaboration: return L10n.Notifications.filterCollaboration
        case .organization: return L10n.Notifications.filterOrganization
        case .system: return L10n.Notifications.filterSystem
        }
    }
}

private extension MobileNotificationSource {
    var localizedLabel: String {
        switch self {
        case .tabAgent: return L10n.Notifications.sourceTabAgent
        case .tabTracker: return L10n.Notifications.sourceTabTracker
        case .tabChat: return L10n.Notifications.sourceTabChat
        case .tabDoc: return L10n.Notifications.sourceTabDoc
        case .tabData: return L10n.Notifications.sourceTabData
        case .tabMail: return L10n.Notifications.sourceTabMail
        case .tabInbox: return L10n.Notifications.sourceTabInbox
        case .sharedResource: return L10n.Notifications.sourceSharedResource
        case .organization: return L10n.Notifications.sourceOrganization
        case .extensionEvent: return L10n.Notifications.sourceExtension
        case .system: return L10n.Notifications.sourceSystem
        }
    }
}
