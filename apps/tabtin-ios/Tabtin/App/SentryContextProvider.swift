import Foundation
import Observation
import Sentry

/// Sentry scope 的唯一写入点。
///
/// 契约「每端一个 context provider」：字段随状态变化统一写入 scope，业务代码
/// （catch 块 / View）不直接 `setTag`。用 Swift `Observation` 框架被动订阅
/// `AuthService` / `WorkspaceStore`（两者都是 `@Observable`），不需要改动它们
/// 的源码、不引入反向依赖。
@MainActor
final class SentryContextProvider {
    static let shared = SentryContextProvider()

    private var started = false
    private var clientInstallId: String?
    private var organizationId: String?
    private var activeSpaceId: String?

    private init() {}

    /// 在 `SentryReporter.start()` 之后调用一次。
    func start() {
        guard !started else { return }
        started = true

        clientInstallId = ObservabilityInstallId.current()
        applyTabtinContext()

        observeAuth()
        observeOrganization()
    }

    /// 进入会话所属 Space 时调用（`ConversationViewModel.startSession()`）。
    func setActiveSpace(_ spaceId: String?) {
        activeSpaceId = spaceId?.isEmpty == false ? spaceId : nil
        applyTabtinContext()
    }

    /// 离开会话时调用（`ConversationViewModel.stopSession()`）。
    func clearActiveSpace() {
        setActiveSpace(nil)
    }

    // MARK: - 被动订阅（Observation）

    private func observeAuth() {
        withObservationTracking {
            _ = AuthService.shared.isAuthenticated
            _ = AuthService.shared.currentUser?.id
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.applyAuthContext()
                self?.observeAuth()
            }
        }
        applyAuthContext()
    }

    private func observeOrganization() {
        withObservationTracking {
            _ = WorkspaceStore.shared.selectedOrganization?.id
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.applyOrganizationContext()
                self?.observeOrganization()
            }
        }
        applyOrganizationContext()
    }

    private func applyAuthContext() {
        guard AuthService.shared.isAuthenticated, let user = AuthService.shared.currentUser else {
            SentrySDK.setUser(nil)
            return
        }
        // V1 只放内部 ID，不上传昵称、phone、email 或明文 username。
        let sentryUser = User()
        sentryUser.userId = user.id
        SentrySDK.setUser(sentryUser)
    }

    private func applyOrganizationContext() {
        organizationId = WorkspaceStore.shared.selectedOrganization?.id
        IOSDiagnosticRuntime.updateOrganization(organizationId)
        applyTabtinContext()
    }

    private func applyTabtinContext() {
        var context: [String: Any] = [:]
        if let clientInstallId { context["client_install_id"] = clientInstallId }
        if let organizationId { context["organization_id"] = organizationId }
        if let activeSpaceId { context["space_id"] = activeSpaceId }
        context["app_version"] = ObservabilityBuildMetadata.appVersion
        context["build_number"] = ObservabilityBuildMetadata.buildNumber
        context["platform"] = "ios"
        if let gitSha = ObservabilityBuildMetadata.gitSha { context["git_sha"] = gitSha }
        SentrySDK.configureScope { scope in
            scope.setContext(value: context, key: "tabtin")
        }
    }
}
