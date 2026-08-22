import Foundation
import UIKit
import UserNotifications
import os

enum APNsPushPayload {
    static func extensionJSON(from userInfo: [AnyHashable: Any]) -> String? {
        if let ext = userInfo["ext"] as? String, !ext.isEmpty {
            return ext
        }
        guard let ext = userInfo["ext"], JSONSerialization.isValidJSONObject(ext),
              let data = try? JSONSerialization.data(withJSONObject: ext),
              let encoded = String(data: data, encoding: .utf8) else {
            return nil
        }
        return encoded
    }
}

enum APNsEnvironment {
    static var current: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

enum PushTokenUploadRetryPolicy {
    private static let delays: [TimeInterval] = [2, 10, 30, 120]

    static func delay(afterFailure failure: Int) -> TimeInterval? {
        guard delays.indices.contains(failure) else { return nil }
        return delays[failure]
    }
}

struct IMPushPayload: Equatable, Sendable {
    private struct ExtensionWire: Encodable {
        let scene = "im_message"
        let organizationId: String
        let conversationId: String

        enum CodingKeys: String, CodingKey {
            case scene
            case organizationId = "organization_id"
            case conversationId = "conversation_id"
        }
    }

    let organizationId: String
    let conversationId: String

    var extensionJSON: String {
        let wire = ExtensionWire(
            organizationId: organizationId,
            conversationId: conversationId
        )
        guard let data = try? JSONEncoder().encode(wire),
              let encoded = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return encoded
    }
}

struct IMPushRouteIntent: Equatable, Sendable {
    /// 发送端视角的组织只能作为提示。外部会话双方的 ParticipantOrganization
    /// 可能不同，接收端必须按 conversationId 重新解析自己的参与组织。
    let organizationId: String
    let conversationId: String

    static func parse(_ ext: String) -> Self? {
        guard let data = ext.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (raw["scene"] as? String) == "im_message",
              let organizationId = nonEmpty(
                (raw["organization_id"] as? String) ?? (raw["organizationId"] as? String)
              ),
              let conversationId = nonEmpty(
                (raw["conversation_id"] as? String) ?? (raw["conversationId"] as? String)
              ) else {
            return nil
        }
        return Self(organizationId: organizationId, conversationId: conversationId)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

enum IMPushNavigationStep: Equatable, Sendable {
    case wait
    case selectOrganization(String)
    case openConversation(IMPushRouteIntent)
    case unavailable
}

enum IMPushNavigationPlanner {
    static func nextStep(
        for intent: IMPushRouteIntent,
        isSessionReady: Bool,
        hasLoadedOrganizations: Bool,
        resolvedOrganizationId: String?,
        selectedOrganizationId: String?
    ) -> IMPushNavigationStep {
        guard isSessionReady, hasLoadedOrganizations else { return .wait }
        guard let resolvedOrganizationId else { return .unavailable }
        guard selectedOrganizationId == resolvedOrganizationId else {
            return .selectOrganization(resolvedOrganizationId)
        }
        return .openConversation(intent)
    }

    static func organizationCandidates(
        for intent: IMPushRouteIntent,
        selectedOrganizationId: String?,
        availableOrganizationIds: [String]
    ) -> [String] {
        let available = Set(availableOrganizationIds)
        var seen: Set<String> = []
        return ([selectedOrganizationId, intent.organizationId].compactMap { $0 }
            + availableOrganizationIds).filter {
                available.contains($0) && seen.insert($0).inserted
            }
    }
}

struct AgentPushRouteIntent: Equatable, Sendable {
    let organizationId: String
    let workspaceId: String
    let projectId: String?
    let sessionId: String
    let messageId: String?

    static func parse(_ ext: String) -> Self? {
        guard let data = ext.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scene = nonEmpty(raw["scene"] as? String),
              scene == "interaction_requested" || scene == "agent_done",
              let organizationId = nonEmpty(
                (raw["organization_id"] as? String) ?? (raw["organizationId"] as? String)
              ),
              let workspaceId = nonEmpty(
                (raw["workspace_id"] as? String)
                    ?? (raw["workspaceId"] as? String)
                    ?? (raw["space_id"] as? String)
                    ?? (raw["spaceId"] as? String)
              ),
              let sessionId = nonEmpty(
                (raw["session_id"] as? String) ?? (raw["sessionId"] as? String)
              ) else {
            return nil
        }
        return Self(
            organizationId: organizationId,
            workspaceId: workspaceId,
            projectId: nonEmpty(
                (raw["project_id"] as? String) ?? (raw["projectId"] as? String)
            ),
            sessionId: sessionId,
            messageId: nonEmpty(
                (raw["message_id"] as? String) ?? (raw["messageId"] as? String)
            )
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

enum AgentPushNavigationStep: Equatable, Sendable {
    case wait
    case selectOrganization(String)
    case openConversation(AgentPushRouteIntent)
    case unavailable
}

enum AgentPushNavigationPlanner {
    static func nextStep(
        for intent: AgentPushRouteIntent,
        isSessionReady: Bool,
        hasLoadedOrganizations: Bool,
        availableOrganizationIds: [String],
        selectedOrganizationId: String?
    ) -> AgentPushNavigationStep {
        guard isSessionReady, hasLoadedOrganizations else { return .wait }
        guard availableOrganizationIds.contains(intent.organizationId) else { return .unavailable }
        guard selectedOrganizationId == intent.organizationId else {
            return .selectOrganization(intent.organizationId)
        }
        return .openConversation(intent)
    }
}

/// 远程推送服务（「Agent 干完活 / 要审批时叫醒我」）。
///
/// 生命周期：登录成功 → `start()`（请求通知权限 + 注册 APNs + device token
/// 上报后端）；登出 → `prepareForLogout()`（用登出前的 token 反注册后端）。
@MainActor @Observable
final class PushService {
    static let shared = PushService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "Push")
    private(set) var deviceToken: String?
    private var started = false
    private var navigationTask: Task<Void, Never>?
    private var navigationRevision: UInt64 = 0
    private var pendingIMRouteIntent: IMPushRouteIntent?
    private var pendingAgentRouteIntent: AgentPushRouteIntent?
    /// 已成功上报后端的 APNs token，避免重复 POST。
    private var uploadedDeviceToken: String?
    private var uploadTask: Task<Void, Never>?
    private var uploadGeneration: UInt64 = 0

    private var logoutHookRegistered = false

    private init() {}

    // MARK: - 生命周期

    /// 登录成功后调用。幂等：重复调用只在 APNs token 变化时重新上报。
    func start() {
        resumePendingNavigation()
        if !logoutHookRegistered {
            logoutHookRegistered = true
            // logout hook 在 Keychain 清空前触发，反注册请求还能带上有效 token
            AuthService.shared.registerLogoutHook { [weak self] in
                self?.prepareForLogout()
            }
        }
        guard !started else {
            retryPendingUpload()
            return
        }
        started = true

        #if targetEnvironment(simulator)
        logger.info("simulator: remote push disabled")
        #else
        Task { await requestNotificationAuthorization() }
        if let deviceToken { uploadDeviceToken(deviceToken) }
        #endif
    }

    /// 登出或重复 start 后可再次注册。
    func resetForRetry() {
        uploadGeneration &+= 1
        uploadTask?.cancel()
        uploadTask = nil
        started = false
        uploadedDeviceToken = nil
    }

    /// App 回到前台时为尚未成功上报的 token 重新开启一轮有界重试。
    func retryPendingUpload() {
        guard started, uploadTask == nil,
              let deviceToken, deviceToken != uploadedDeviceToken else { return }
        uploadDeviceToken(deviceToken)
    }

    /// 登出钩子（AuthService.logout 清 Keychain **之前**调用）：
    /// 用还有效的 access token 反注册后端。
    func prepareForLogout() {
        let tokenToRevoke = uploadedDeviceToken ?? deviceToken
        navigationRevision &+= 1
        navigationTask?.cancel()
        navigationTask = nil
        pendingIMRouteIntent = nil
        pendingAgentRouteIntent = nil
        resetForRetry()

        if let tokenToRevoke, let token = KeychainService.shared.getAccessToken() {
            Task.detached {
                do {
                    let _: [String: Bool] = try await APIClient.shared.post(
                        path: Endpoints.Context.devicePushTokenRevoke,
                        body: ["registration_id": tokenToRevoke, "provider": "apns"],
                        token: token
                    )
                } catch {
                    // 尽力而为：反注册失败时后端仍会在下次推送回执标记 token 失效
                }
            }
        }

    }

    // MARK: - 深链（通知点击）

    /// APNs 通知点击回调透传的 ext JSON。
    /// 解析出会话目标后经 MainRouter 跳转；解析失败只打开 App 不跳转。
    func handleNotificationExt(_ ext: String) {
        if let intent = IMPushRouteIntent.parse(ext) {
            pendingAgentRouteIntent = nil
            pendingIMRouteIntent = intent
            resumePendingNavigation()
            return
        }
        if let intent = AgentPushRouteIntent.parse(ext) {
            pendingIMRouteIntent = nil
            pendingAgentRouteIntent = intent
            resumePendingNavigation()
            return
        }
        guard let data = ext.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            logger.info("push ext unparsable, open app only")
            return
        }
        let workspaceId = (dict["workspace_id"] as? String)
            ?? (dict["space_id"] as? String)
            ?? ""
        let organizationId = dict["organization_id"] as? String ?? ""
        let projectId = dict["project_id"] as? String
        let sessionId = dict["session_id"] as? String
        guard !workspaceId.isEmpty, !organizationId.isEmpty else { return }

        MainRouter.shared.openConversation(ConversationTarget(
            title: "",
            workspaceId: workspaceId,
            organizationId: organizationId,
            projectId: (projectId?.isEmpty == false) ? projectId : nil,
            sessionId: (sessionId?.isEmpty == false) ? sessionId : nil
        ))
    }

    private func resumePendingNavigation() {
        guard pendingIMRouteIntent != nil || pendingAgentRouteIntent != nil else { return }
        navigationRevision &+= 1
        let revision = navigationRevision
        navigationTask?.cancel()
        navigationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if self.pendingAgentRouteIntent != nil {
                await self.routePendingAgentNotification(revision: revision)
            } else {
                await self.routePendingIMNotification(revision: revision)
            }
        }
    }

    private func routePendingIMNotification(revision: UInt64) async {
        defer {
            if navigationRevision == revision {
                navigationTask = nil
            }
        }
        guard navigationRevision == revision else { return }
        guard let intent = pendingIMRouteIntent else { return }

        let auth = AuthService.shared
        let isSessionReady = auth.isAuthenticated
            && auth.currentUser != nil
            && !auth.needsInviteCode
        guard isSessionReady else { return }

        let workspace = WorkspaceStore.shared
        if !workspace.hasLoadedOrganizations {
            guard await workspace.loadOrganizations(),
                  !Task.isCancelled,
                  navigationRevision == revision,
                  pendingIMRouteIntent == intent else { return }
        }

        let availableIds = workspace.organizations.map(\.id)
        let candidates = IMPushNavigationPlanner.organizationCandidates(
            for: intent,
            selectedOrganizationId: workspace.selectedOrganizationId,
            availableOrganizationIds: availableIds
        )
        let resolvedOrganizationId: String?
        do {
            resolvedOrganizationId = try await DjangoIMAdapter.shared.resolveParticipantOrganizationId(
                conversationId: intent.conversationId,
                candidateOrganizationIds: candidates
            )
        } catch {
            guard !Task.isCancelled, navigationRevision == revision else { return }
            logger.error("resolve IM push organization failed: \(error.localizedDescription)")
            pendingIMRouteIntent = nil
            MainRouter.shared.presentNavigationNotice(L10n.Messages.networkError)
            return
        }
        guard !Task.isCancelled,
              navigationRevision == revision,
              pendingIMRouteIntent == intent else { return }
        switch IMPushNavigationPlanner.nextStep(
            for: intent,
            isSessionReady: isSessionReady,
            hasLoadedOrganizations: workspace.hasLoadedOrganizations,
            resolvedOrganizationId: resolvedOrganizationId,
            selectedOrganizationId: workspace.selectedOrganizationId
        ) {
        case .wait:
            return
        case .unavailable:
            pendingIMRouteIntent = nil
            if !workspace.organizations.contains(where: { $0.id == intent.organizationId }) {
                workspace.notifyOrganizationAccessRevoked(organizationId: intent.organizationId)
            } else {
                MainRouter.shared.presentNavigationNotice(L10n.AccountDrawer.organizationScopeUnavailable)
            }
        case .selectOrganization(let organizationId):
            guard let organization = workspace.organizations.first(where: { $0.id == organizationId }) else {
                workspace.notifyOrganizationAccessRevoked(organizationId: organizationId)
                return
            }
            await workspace.selectOrganization(organization)
            guard !Task.isCancelled,
                  navigationRevision == revision,
                  pendingIMRouteIntent == intent,
                  workspace.selectedOrganizationId == organizationId else { return }
            await activateAndOpenIMConversation(
                intent,
                organizationId: organizationId,
                revision: revision
            )
        case .openConversation(let resolved):
            guard let organizationId = resolvedOrganizationId else { return }
            await activateAndOpenIMConversation(
                resolved,
                organizationId: organizationId,
                revision: revision
            )
        }
    }

    private func routePendingAgentNotification(revision: UInt64) async {
        defer {
            if navigationRevision == revision {
                navigationTask = nil
            }
        }
        guard navigationRevision == revision,
              let intent = pendingAgentRouteIntent else { return }

        let auth = AuthService.shared
        let isSessionReady = auth.isAuthenticated
            && auth.currentUser != nil
            && !auth.needsInviteCode
        guard isSessionReady else { return }

        let workspace = WorkspaceStore.shared
        if !workspace.hasLoadedOrganizations {
            guard await workspace.loadOrganizations(),
                  !Task.isCancelled,
                  navigationRevision == revision,
                  pendingAgentRouteIntent == intent else { return }
        }

        switch AgentPushNavigationPlanner.nextStep(
            for: intent,
            isSessionReady: isSessionReady,
            hasLoadedOrganizations: workspace.hasLoadedOrganizations,
            availableOrganizationIds: workspace.organizations.map(\.id),
            selectedOrganizationId: workspace.selectedOrganizationId
        ) {
        case .wait:
            return
        case .unavailable:
            pendingAgentRouteIntent = nil
            if !workspace.organizations.contains(where: { $0.id == intent.organizationId }) {
                workspace.notifyOrganizationAccessRevoked(organizationId: intent.organizationId)
            } else {
                MainRouter.shared.presentNavigationNotice(L10n.AccountDrawer.organizationScopeUnavailable)
            }
        case .selectOrganization(let organizationId):
            guard let organization = workspace.organizations.first(where: { $0.id == organizationId }) else {
                workspace.notifyOrganizationAccessRevoked(organizationId: organizationId)
                return
            }
            await workspace.selectOrganization(organization)
            guard !Task.isCancelled,
                  navigationRevision == revision,
                  pendingAgentRouteIntent == intent,
                  workspace.selectedOrganizationId == organizationId else { return }
            openAgentConversation(intent)
        case .openConversation(let resolved):
            openAgentConversation(resolved)
        }
    }

    private func openAgentConversation(_ intent: AgentPushRouteIntent) {
        guard WorkspaceStore.shared.selectedOrganizationId == intent.organizationId else { return }
        pendingAgentRouteIntent = nil
        MainRouter.shared.openConversation(ConversationTarget(
            title: "",
            workspaceId: intent.workspaceId,
            organizationId: intent.organizationId,
            projectId: intent.projectId,
            sessionId: intent.sessionId,
            messageId: intent.messageId
        ))
    }

    private func activateAndOpenIMConversation(
        _ intent: IMPushRouteIntent,
        organizationId: String,
        revision: UInt64
    ) async {
        guard !Task.isCancelled,
              navigationRevision == revision,
              pendingIMRouteIntent == intent,
              WorkspaceStore.shared.selectedOrganizationId == organizationId else { return }
        pendingIMRouteIntent = nil
        MainRouter.shared.openIMConversation(IMConversationTarget(
            conversationId: intent.conversationId,
            title: ""
        ))
    }

    // MARK: - 内部

    private func requestNotificationAuthorization() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            do {
                _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            } catch {
                logger.warning("notification authorization failed: \(error.localizedDescription)")
            }
        }
        await MainActor.run {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func handleAPNsDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard !token.isEmpty else { return }
        if deviceToken != token {
            uploadGeneration &+= 1
            uploadTask?.cancel()
            uploadTask = nil
        }
        deviceToken = token
        NSLog("[Push] APNs deviceToken len=%d prefix=%@", data.count, String(token.prefix(16)))
        guard started else { return }
        uploadDeviceToken(token)
    }

    private func uploadDeviceToken(_ token: String) {
        guard started, token != uploadedDeviceToken, uploadTask == nil else { return }
        uploadGeneration &+= 1
        let generation = uploadGeneration
        uploadTask = Task { @MainActor [weak self] in
            await self?.runDeviceTokenUpload(token, generation: generation)
        }
    }

    private func runDeviceTokenUpload(_ token: String, generation: UInt64) async {
        defer {
            if uploadGeneration == generation {
                uploadTask = nil
            }
        }
        var failure = 0
        while !Task.isCancelled,
              started,
              deviceToken == token,
              uploadedDeviceToken != token,
              uploadGeneration == generation {
            do {
                let _: [String: AnyCodable] = try await APIClient.shared.post(
                    path: Endpoints.Context.devicePushToken,
                    body: [
                        "registration_id": token,
                        "platform": "ios",
                        "provider": "apns",
                        "environment": APNsEnvironment.current,
                        "fingerprint": KeychainService.shared.getOrCreateDeviceId(),
                        "app_version": AppConfig.appVersion,
                    ]
                )
                guard !Task.isCancelled,
                      started,
                      deviceToken == token,
                      uploadGeneration == generation else { return }
                uploadedDeviceToken = token
                logger.info("APNs token uploaded")
                NSLog("[Push] APNs token uploaded to backend")
                return
            } catch {
                guard !Task.isCancelled,
                      started,
                      deviceToken == token,
                      uploadGeneration == generation else { return }
                logger.warning("APNs token upload failed: \(error.localizedDescription)")
                NSLog("[Push] APNs token upload failed: %@", error.localizedDescription)
                guard let delay = PushTokenUploadRetryPolicy.delay(afterFailure: failure) else {
                    logger.warning("APNs token upload retries exhausted; waiting for foreground retry")
                    return
                }
                failure += 1
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
            }
        }
    }
}
