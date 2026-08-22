import Foundation
import SwiftUI

/// 主壳级账户侧栏与全局目的地状态（compact 推挤式侧栏 + iPad sheet）。
@MainActor @Observable
final class AccountDrawerCoordinator {
    static let shared = AccountDrawerCoordinator { hook in
        AuthService.shared.registerLogoutHook(hook)
    }

    private(set) var isOpen = false
    private(set) var showsOrganizationPicker = false
    private(set) var switchingOrganizationId: String?
    private(set) var organizationSwitchError: String?
    private(set) var presentationMode: AccountDrawerPresentationMode = .compact

    /// 冷启动 / 通知深链等一次性全局目的地；主壳 ready 后消费。
    private(set) var pendingGlobalDestination: AccountGlobalDestination?

    /// 侧栏关闭后由主壳承载的全屏目的地（不压进 Tab 局部栈）。
    var presentedGlobalSheet: AccountGlobalSheet?

    /// 由主壳 NavigationStack 承载的 push 目的地；抽屉入口走这里，保持移动端 push 语义。
    private(set) var pendingGlobalPushDestination: AccountGlobalPushDestination?

    /// regular 宽度下，必须等系统 drawer sheet 完全消失后再弹全屏目的地。
    private(set) var pendingGlobalSheetAfterDrawerDismissal: AccountGlobalSheet?
    private(set) var isRegularDrawerPresented = false

    /// 使登出时仍在 await 的组织切换结果失效，禁止旧账号状态回写到新会话。
    private var lifecycleGeneration = 0

    init(registerLogoutHook: (@escaping @MainActor () -> Void) -> Void) {
        registerLogoutHook { [weak self] in
            self?.resetForLogout()
        }
    }

    func setPresentationMode(_ mode: AccountDrawerPresentationMode) {
        presentationMode = mode
    }

    func regularDrawerDidPresent() {
        isRegularDrawerPresented = true
    }

    func openDrawer(focusOrganizationPicker: Bool = false, animated: Bool = true) {
        showsOrganizationPicker = focusOrganizationPicker
        organizationSwitchError = nil
        if animated {
            withAnimation(AccountDrawerMotion.open) {
                isOpen = true
            }
        } else {
            // UIKit 手势已经负责 settle 动画；这里只同步业务状态，避免 SwiftUI 再启动一段动画。
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                isOpen = true
            }
        }
    }

    func closeDrawer(animated: Bool = true) {
        guard isOpen else { return }
        if animated {
            withAnimation(AccountDrawerMotion.close) {
                isOpen = false
                showsOrganizationPicker = false
                organizationSwitchError = nil
            }
        } else {
            // UIKit 跟手关闭已把主壳移回原位，这里只同步状态，避免再播一段 spring。
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                isOpen = false
                showsOrganizationPicker = false
                organizationSwitchError = nil
            }
        }
    }

    func toggleDrawer() {
        if isOpen {
            closeDrawer()
        } else {
            openDrawer()
        }
    }

    func setOrganizationPickerVisible(_ visible: Bool) {
        showsOrganizationPicker = visible
        if visible {
            organizationSwitchError = nil
        }
    }

    /// 排队全局目的地；若主壳已挂载则立即消费。
    func enqueueGlobalDestination(_ destination: AccountGlobalDestination) {
        pendingGlobalDestination = destination
        consumePendingGlobalDestinationIfReady()
    }

    func consumePendingGlobalDestinationIfReady() {
        guard let destination = pendingGlobalDestination else { return }
        pendingGlobalDestination = nil
        route(to: destination)
    }

    func route(to destination: AccountGlobalDestination) {
        switch destination {
        case .me:
            requestGlobalPush(.me)
        case .settings:
            requestGlobalPush(.settings)
        case .accountDrawerOrganizationSwitcher:
            openDrawer(focusOrganizationPicker: true)
        case .organizationInvitation:
            requestGlobalPush(.organizationInvitations)
        case .projectInvitationPassthrough:
            // Project 邀请仍由协作域处理；此处仅保留 resolver 契约。
            break
        }
    }

    func requestGlobalPush(_ destination: AccountGlobalPushDestination) {
        pendingGlobalSheetAfterDrawerDismissal = nil
        presentedGlobalSheet = nil
        pendingGlobalPushDestination = destination
    }

    /// 由主壳在成功压栈后调用：先 push，再收起抽屉。
    func completeGlobalPushNavigation(_ destination: AccountGlobalPushDestination) {
        if pendingGlobalPushDestination == destination {
            pendingGlobalPushDestination = nil
        }
        closeDrawer()
    }

    func presentGlobalSheet(_ sheet: AccountGlobalSheet) {
        if presentationMode == .regular, isOpen || isRegularDrawerPresented {
            pendingGlobalSheetAfterDrawerDismissal = sheet
            closeDrawer()
            return
        }

        pendingGlobalSheetAfterDrawerDismissal = nil
        closeDrawer()
        presentedGlobalSheet = sheet
    }

    /// 仅由 regular drawer 的系统 sheet onDismiss 调用，避免 UIKit 呈现竞态。
    func completeDrawerDismissal() {
        isRegularDrawerPresented = false
        guard let pending = pendingGlobalSheetAfterDrawerDismissal else { return }
        pendingGlobalSheetAfterDrawerDismissal = nil
        presentedGlobalSheet = pending
    }

    func dismissGlobalSheet() {
        presentedGlobalSheet = nil
    }

    func resetForLogout() {
        lifecycleGeneration += 1
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            isOpen = false
            showsOrganizationPicker = false
            switchingOrganizationId = nil
            organizationSwitchError = nil
            pendingGlobalDestination = nil
            pendingGlobalPushDestination = nil
            pendingGlobalSheetAfterDrawerDismissal = nil
            isRegularDrawerPresented = false
            presentedGlobalSheet = nil
        }
    }

    @discardableResult
    func switchOrganization(_ organization: Organization, workspace: WorkspaceStore) async -> Bool {
        guard switchingOrganizationId == nil else { return false }

        let generation = lifecycleGeneration
        let targetId = organization.id
        switchingOrganizationId = targetId
        organizationSwitchError = nil
        defer {
            if lifecycleGeneration == generation, switchingOrganizationId == targetId {
                switchingOrganizationId = nil
            }
        }

        if targetId == workspace.selectedOrganizationId {
            if case .ready = workspace.organizationContextReadiness(for: targetId) {
                organizationSwitchError = nil
                showsOrganizationPicker = false
                return true
            }
            await workspace.reloadSelectedOrganizationContext()
        } else {
            await workspace.selectOrganization(organization)
        }

        guard lifecycleGeneration == generation else { return false }
        let readiness = await waitForOrganizationContextReady(
            organizationId: targetId,
            workspace: workspace
        )
        guard lifecycleGeneration == generation else { return false }
        return applyOrganizationSwitchReadiness(readiness)
    }

    @discardableResult
    func retrySelectedOrganizationContext(workspace: WorkspaceStore) async -> Bool {
        guard switchingOrganizationId == nil,
              let organizationId = workspace.selectedOrganizationId else { return false }

        let generation = lifecycleGeneration
        switchingOrganizationId = organizationId
        organizationSwitchError = nil
        defer {
            if lifecycleGeneration == generation, switchingOrganizationId == organizationId {
                switchingOrganizationId = nil
            }
        }

        await workspace.reloadSelectedOrganizationContext()
        guard lifecycleGeneration == generation else { return false }
        let readiness = await waitForOrganizationContextReady(
            organizationId: organizationId,
            workspace: workspace
        )
        guard lifecycleGeneration == generation else { return false }
        return applyOrganizationSwitchReadiness(readiness)
    }

    private func applyOrganizationSwitchReadiness(
        _ readiness: OrganizationContextReadiness
    ) -> Bool {
        switch readiness {
        case .ready:
            organizationSwitchError = nil
            showsOrganizationPicker = false
            return true
        case .loading:
            organizationSwitchError = L10n.AccountDrawer.organizationSwitchInProgress
            return false
        case .failed(let message):
            organizationSwitchError = message
            // 保持选择层：selectedOrganizationId 已是实际上下文（可能部分切换成功）。
            return false
        }
    }

    private func waitForOrganizationContextReady(
        organizationId: String,
        workspace: WorkspaceStore,
        timeout: Duration = .seconds(30)
    ) async -> OrganizationContextReadiness {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if Task.isCancelled {
                return workspace.organizationContextReadiness(for: organizationId)
            }
            let readiness = workspace.organizationContextReadiness(for: organizationId)
            switch readiness {
            case .ready, .failed:
                return readiness
            case .loading:
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        return workspace.organizationContextReadiness(for: organizationId)
    }
}

enum AccountDrawerPresentationMode {
    case compact
    case regular
}

enum AccountGlobalSheet: Identifiable, Hashable {
    case me
    case settings
    case notifications
    case organizationInvitations

    var id: String {
        switch self {
        case .me: return "me"
        case .settings: return "settings"
        case .notifications: return "notifications"
        case .organizationInvitations: return "organizationInvitations"
        }
    }
}

enum AccountGlobalPushDestination: Identifiable, Hashable {
    case me
    case settings
    case notifications
    case organizationInvitations

    var id: String {
        switch self {
        case .me: return "me"
        case .settings: return "settings"
        case .notifications: return "notifications"
        case .organizationInvitations: return "organizationInvitations"
        }
    }
}

enum AccountDrawerMotion {
    static var open: Animation? {
        guard !UIAccessibility.isReduceMotionEnabled else { return nil }
        return .spring(response: 0.36, dampingFraction: 0.86)
    }

    static var close: Animation? {
        guard !UIAccessibility.isReduceMotionEnabled else { return nil }
        return .spring(response: 0.32, dampingFraction: 0.92)
    }
}
