#if DEBUG
import Foundation
import UIKit

/// 真机 live：在已登录主壳进程里驱动 AccountDrawer / ME / Settings 主路径，结果写 Documents。
enum AccountDrawerLiveHarness {
    static let enabledArgument = "--account-drawer-live"
    private static let resultFile = "account-drawer-live-result.json"

    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains(enabledArgument)
    }

    struct Result: Codable {
        let passed: Bool
        let checks: [String]
        let failures: [String]
        let context: Context
    }

    struct Context: Codable {
        let userId: String?
        let displayName: String?
        let organizationId: String?
        let organizationName: String?
        let role: String?
        let visibleSettings: [String]
        let debugUnlocked: Bool
    }

    @MainActor
    static func run() async -> Result {
        var checks: [String] = []
        var failures: [String] = []

        func pass(_ name: String) { checks.append(name) }
        func fail(_ name: String, _ detail: String) {
            failures.append("\(name): \(detail)")
        }

        let auth = AuthService.shared
        let workspace = WorkspaceStore.shared
        let coordinator = AccountDrawerCoordinator.shared

        // 等待登录态 / 组织就绪
        for _ in 0..<40 {
            if auth.currentUser != nil, workspace.selectedOrganization != nil { break }
            if auth.accessToken != nil {
                try? await auth.fetchProfile()
                await workspace.loadOrganizations()
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        if auth.currentUser != nil {
            pass("authenticated")
        } else {
            fail("authenticated", "currentUser 为空；真机需先登录")
        }

        if let org = workspace.selectedOrganization {
            pass("organizationSelected:\(org.name)")
        } else {
            fail("organizationSelected", "无当前组织")
        }

        // 主壳应铺满窗口（回归：GeometryReader+clipped 曾裁掉状态栏/Home Indicator）
        probeMainShellFullBleed(pass: pass, fail: fail)

        // 快速开关：回归旧动画 completion 覆盖新状态，造成逻辑关态但灰罩 / 位移仍停在开态。
        coordinator.closeDrawer(animated: false)
        coordinator.openDrawer()
        try? await Task.sleep(for: .milliseconds(80))
        coordinator.closeDrawer()
        await waitForDrawerAnimationToSettle()
        if coordinator.isOpen {
            fail("drawerRapidReversalState", "快速开关后 isOpen=true")
        } else {
            pass("drawerRapidReversalState")
        }
        probeDrawerClosedPresentation(pass: pass, fail: fail)

        // 打开侧栏
        coordinator.openDrawer()
        if coordinator.isOpen {
            pass("drawerOpen")
        } else {
            fail("drawerOpen", "openDrawer 后 isOpen=false")
        }
        try? await Task.sleep(for: .milliseconds(700))
        probeDrawerPresentation(pass: pass, fail: fail)
        probeDrawerSafeArea(pass: pass, fail: fail)

        // ME
        coordinator.route(to: .me)
        if coordinator.presentedGlobalSheet == .me {
            pass("routeMe")
        } else {
            fail("routeMe", "presented=\(String(describing: coordinator.presentedGlobalSheet))")
        }
        coordinator.dismissGlobalSheet()

        // Settings
        coordinator.route(to: .settings)
        if coordinator.presentedGlobalSheet == .settings {
            pass("routeSettings")
        } else {
            fail("routeSettings", "presented=\(String(describing: coordinator.presentedGlobalSheet))")
        }
        try? await Task.sleep(for: .milliseconds(500))
        probeSettingsLargeTitle(pass: pass, fail: fail)

        let visible = SettingsHomeCapabilityResolver.visibleCapabilities()
        let ids = visible.map(\.id)
        let destinations = visible.compactMap(\.destination)
        let duplicateDestinations = Dictionary(grouping: destinations, by: { $0 })
            .filter { $0.value.count > 1 }
            .map(\.key.rawValue)
            .sorted()
        if duplicateDestinations.isEmpty {
            pass("settingsHomeDestinationsUnique")
        } else {
            fail(
                "settingsHomeDestinationsUnique",
                "多个 capability 指向同一 destination：\(duplicateDestinations.joined(separator: ","))"
            )
        }
        let missingPresentations = visible
            .compactMap(\.destination)
            .filter { !SettingsHomePresentation.supports($0) }
        if missingPresentations.isEmpty {
            pass("settingsHomePresentationCoverage")
        } else {
            fail(
                "settingsHomePresentationCoverage",
                "缺少首页展示元数据：\(missingPresentations.map(\.rawValue).joined(separator: ","))"
            )
        }
        if
            Set(SettingsHomePresentation.homeOrder).count == SettingsHomePresentation.homeOrder.count,
            SettingsHomePresentation.hasConsistentOrder
        {
            pass("settingsHomePresentationOrderConsistent")
        } else {
            fail("settingsHomePresentationOrderConsistent", "首页 destination 排序重复或与视觉分组不一致")
        }
        let required = [
            "settings.personal.accountInfo",
            "settings.personal.appearance.ios",
            "settings.personal.systemPermissions",
            "settings.personal.voiceHabits",
            "settings.personal.privacyAndData",
            "settings.organization.summary",
            "settings.organization.settingsEntry",
            "settings.device.info",
            "settings.device.about",
            "settings.device.logout",
        ]
        for id in required {
            if ids.contains(id) {
                pass("capability:\(id)")
            } else {
                fail("capability:\(id)", "未出现在 iOS settings home")
            }
        }
        let debugCapability = "settings.device.debugEnvironment"
        if ids.contains(debugCapability) {
            pass("debugEnvironmentVisibility")
        } else {
            fail(
                "debugEnvironmentVisibility",
                "Debug Environment 未直接展示"
            )
        }
        if ids.contains(where: { $0.contains("accountDeletion") || $0.contains("notificationCategories") }) {
            fail("excludedFake", "设置首页出现注销/通知分类")
        } else {
            pass("excludedFake")
        }
        if !ids.contains(where: { $0.hasPrefix("me.") }) {
            pass("settingsHomeNoMeOwnership")
        } else {
            fail("settingsHomeNoMeOwnership", "settings home 混入 me.*")
        }

        // owner-only
        if OrganizationRole.owner.canManage, !OrganizationRole.admin.canManage {
            pass("canManageOwnerOnly")
        } else {
            fail("canManageOwnerOnly", "owner=\(OrganizationRole.owner.canManage) admin=\(OrganizationRole.admin.canManage)")
        }

        // 组织邀请不连带开侧栏：先关侧栏再 route
        coordinator.closeDrawer()
        coordinator.route(to: .organizationInvitation)
        if !coordinator.isOpen, coordinator.presentedGlobalSheet == .organizationInvitations {
            pass("organizationInvitationNoDrawer")
        } else {
            fail(
                "organizationInvitationNoDrawer",
                "isOpen=\(coordinator.isOpen) sheet=\(String(describing: coordinator.presentedGlobalSheet))"
            )
        }

        // 组织切换 readiness API 存在
        if let orgId = workspace.selectedOrganization?.id {
            let readiness = workspace.organizationContextReadiness(for: orgId)
            switch readiness {
            case .ready:
                pass("organizationReadinessReady")
            case .loading:
                fail("organizationReadinessReady", "当前组织上下文仍在加载")
            case .failed(let message):
                fail("organizationReadinessReady", message)
            }
        } else {
            fail("organizationReadinessReady", "无当前组织")
        }

        coordinator.dismissGlobalSheet()
        coordinator.closeDrawer()

        let context = Context(
            userId: auth.currentUser?.id,
            displayName: auth.currentUser?.displayName,
            organizationId: workspace.selectedOrganization?.id,
            organizationName: workspace.selectedOrganization?.name,
            role: workspace.currentUserRole?.rawValue,
            visibleSettings: ids,
            debugUnlocked: true
        )
        let result = Result(passed: failures.isEmpty, checks: checks, failures: failures, context: context)
        write(result)
        return result
    }

    private static func write(_ result: Result) {
        guard let data = try? JSONEncoder().encode(result) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(resultFile)
        try? data.write(to: url, options: .atomic)
    }

    /// 检测 AccountDrawerHost / TabView 是否仍被安全区高度锁死（典型白条：顶 ~100、底 ~180）。
    @MainActor
    private static func probeMainShellFullBleed(
        pass: (String) -> Void,
        fail: (String, String) -> Void
    ) {
        guard
            let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first
        else {
            fail("mainShellFullBleed", "找不到 key window")
            return
        }

        window.layoutIfNeeded()
        let screen = window.bounds
        let insets = window.safeAreaInsets
        // 旧 bug：内容高度 ≈ screen - topInset - bottomInset，且竖直被裁切。
        let legacyClippedHeight = screen.height - insets.top - insets.bottom
        let tolerance: CGFloat = 2

        guard let tabBar = findTabBarController(from: window.rootViewController) else {
            fail(
                "mainShellFullBleed",
                "无 UITabBarController；window=\(Int(screen.width))x\(Int(screen.height)) insets=\(insets)"
            )
            return
        }

        tabBar.view.layoutIfNeeded()
        let tabFrame = tabBar.view.convert(tabBar.view.bounds, to: window)
        let fillsWidth = abs(tabFrame.width - screen.width) <= tolerance
        let fillsHeight = abs(tabFrame.height - screen.height) <= tolerance
        let looksLikeLegacyClip =
            abs(tabFrame.height - legacyClippedHeight) <= 4
            && tabFrame.height + 40 < screen.height

        if fillsWidth, fillsHeight, !looksLikeLegacyClip {
            pass(
                "mainShellFullBleed:\(Int(tabFrame.width))x\(Int(tabFrame.height))/screen\(Int(screen.width))x\(Int(screen.height))"
            )
        } else {
            fail(
                "mainShellFullBleed",
                "tabFrame=\(tabFrame.integral) screen=\(screen.integral) insets.top=\(insets.top) insets.bottom=\(insets.bottom) legacyH=\(legacyClippedHeight)"
            )
        }
    }

    @MainActor
    private static func findTabBarController(from root: UIViewController?) -> UITabBarController? {
        guard let root else { return nil }
        if let tab = root as? UITabBarController { return tab }
        if let tab = root.children.compactMap({ $0 as? UITabBarController }).first { return tab }
        for child in root.children {
            if let tab = findTabBarController(from: child) { return tab }
        }
        if let presented = root.presentedViewController {
            return findTabBarController(from: presented)
        }
        return nil
    }

    /// 检测逻辑开态与 UIKit 位移/蒙层是否一致，并确认被推开的左侧区域能露出且点击到底层侧栏。
    @MainActor
    private static func probeDrawerPresentation(
        pass: (String) -> Void,
        fail: (String, String) -> Void
    ) {
        guard
            let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first,
            let controller = findSlideController(from: window.rootViewController)
        else {
            fail("drawerPresentation", "找不到 AccountDrawerSlideViewController")
            return
        }

        let snapshot = controller.debugSnapshot()
        let tolerance: CGFloat = 2
        let offsetMatches = abs(snapshot.currentOffset - snapshot.drawerWidth) <= tolerance
        let transformMatches = abs(snapshot.panelTranslationX - snapshot.drawerWidth) <= tolerance
        let presentationMatches = abs(snapshot.presentationOffset - snapshot.drawerWidth) <= tolerance
        let scrimMatches = snapshot.scrimAlpha >= 0.98
        let revealSurfaceWorks = snapshot.rootBackgroundAlpha <= 0.01
            && snapshot.revealPointPassesThrough

        if offsetMatches, transformMatches, presentationMatches, scrimMatches, snapshot.desiredOpen, !snapshot.isAnimating {
            pass(
                "drawerPresentation:offset=\(Int(snapshot.currentOffset))/width=\(Int(snapshot.drawerWidth))/scrim=\(snapshot.scrimAlpha)"
            )
        } else {
            fail(
                "drawerPresentation",
                "offset=\(snapshot.currentOffset) transform=\(snapshot.panelTranslationX) presentation=\(snapshot.presentationOffset) width=\(snapshot.drawerWidth) scrim=\(snapshot.scrimAlpha) desiredOpen=\(snapshot.desiredOpen) animating=\(snapshot.isAnimating)"
            )
        }

        if revealSurfaceWorks {
            pass("drawerRevealSurface")
        } else {
            fail(
                "drawerRevealSurface",
                "rootAlpha=\(snapshot.rootBackgroundAlpha) passThrough=\(snapshot.revealPointPassesThrough) hit=\(snapshot.revealHitView) panelFrame=\(snapshot.panelFrameInRoot.integral)"
            )
        }
    }

    /// 动画被反向打断后，逻辑状态、模型层、显示层和蒙层必须一起回到关闭态。
    @MainActor
    private static func probeDrawerClosedPresentation(
        pass: (String) -> Void,
        fail: (String, String) -> Void
    ) {
        guard
            let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first,
            let controller = findSlideController(from: window.rootViewController)
        else {
            fail("drawerRapidReversalPresentation", "找不到 AccountDrawerSlideViewController")
            return
        }

        let snapshot = controller.debugSnapshot()
        let tolerance: CGFloat = 2
        let isClosed = abs(snapshot.currentOffset) <= tolerance
            && abs(snapshot.panelTranslationX) <= tolerance
            && abs(snapshot.presentationOffset) <= tolerance
            && snapshot.scrimAlpha <= 0.01
            && !snapshot.desiredOpen
            && !snapshot.isAnimating

        if isClosed {
            pass("drawerRapidReversalPresentation")
        } else {
            fail(
                "drawerRapidReversalPresentation",
                "offset=\(snapshot.currentOffset) transform=\(snapshot.panelTranslationX) presentation=\(snapshot.presentationOffset) scrim=\(snapshot.scrimAlpha) desiredOpen=\(snapshot.desiredOpen) animating=\(snapshot.isAnimating)"
            )
        }
    }

    @MainActor
    private static func findSlideController(from root: UIViewController?) -> AccountDrawerSlideViewController? {
        guard let root else { return nil }
        if let slide = root as? AccountDrawerSlideViewController { return slide }
        for child in root.children {
            if let slide = findSlideController(from: child) { return slide }
        }
        if let presented = root.presentedViewController {
            return findSlideController(from: presented)
        }
        return nil
    }

    /// 冷启动时主线程还可能在铺首屏；给动画 completion 最多一秒的确定性收敛窗口。
    @MainActor
    private static func waitForDrawerAnimationToSettle() async {
        for _ in 0..<20 {
            guard
                let scene = UIApplication.shared.connectedScenes
                    .compactMap({ $0 as? UIWindowScene })
                    .first(where: { $0.activationState == .foregroundActive })
                    ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
                let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first,
                let controller = findSlideController(from: window.rootViewController)
            else {
                try? await Task.sleep(for: .milliseconds(50))
                continue
            }

            let snapshot = controller.debugSnapshot()
            let isVisuallyClosed = abs(snapshot.presentationOffset) <= 2
                && snapshot.scrimAlpha <= 0.01
            if isVisuallyClosed, !snapshot.isAnimating { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// 侧栏背景可以 full-bleed，但标题和版本信息必须留在物理安全区内。
    @MainActor
    private static func probeDrawerSafeArea(
        pass: (String) -> Void,
        fail: (String, String) -> Void
    ) {
        guard
            let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first,
            let titleFrame = AccountDrawerLayoutDebugProbe.titleFrame,
            let versionFrame = AccountDrawerLayoutDebugProbe.versionFrame
        else {
            fail("drawerSafeArea", "未采集到账户标题或版本号布局")
            return
        }

        let tolerance: CGFloat = 1
        let safeTop = window.safeAreaInsets.top
        let safeBottomY = window.bounds.height - window.safeAreaInsets.bottom
        let titleIsSafe = titleFrame.minY >= safeTop - tolerance
        let versionIsSafe = versionFrame.maxY <= safeBottomY + tolerance

        if titleIsSafe, versionIsSafe {
            pass(
                "drawerSafeArea:titleY=\(Int(titleFrame.minY))/safeTop=\(Int(safeTop))/versionMaxY=\(Int(versionFrame.maxY))/safeBottomY=\(Int(safeBottomY))"
            )
        } else {
            fail(
                "drawerSafeArea",
                "title=\(titleFrame.integral) safeTop=\(safeTop) version=\(versionFrame.integral) safeBottomY=\(safeBottomY)"
            )
        }
    }

    /// 回归设置首页曾因强制 toolbar 背景而丢失 large title 的问题。
    @MainActor
    private static func probeSettingsLargeTitle(
        pass: (String) -> Void,
        fail: (String, String) -> Void
    ) {
        guard
            let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let window = scene.keyWindow ?? scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first
        else {
            fail("settingsLargeTitle", "找不到 key window")
            return
        }

        window.layoutIfNeeded()
        writeTopChromeSnapshot(window: window, fileName: "account-drawer-settings-nav.png")
        writeWindowSnapshot(window: window, fileName: "account-drawer-settings-full.png")
        let expectedTitle = L10n.Common.settings
        let visibleNavigationControllers = findNavigationControllers(from: window.rootViewController)
            .filter { $0.navigationBar.window != nil }

        if let navigationController = visibleNavigationControllers.first(where: { navigationController in
            let hasExpectedTitle = descendantLabels(in: navigationController.navigationBar)
                .contains(where: { $0.text == expectedTitle })
            return hasExpectedTitle
                && navigationController.navigationBar.prefersLargeTitles
                && navigationController.topViewController?.navigationItem.largeTitleDisplayMode == .always
                && navigationController.navigationBar.bounds.height >= 80
        }) {
            pass("settingsLargeTitle:barH=\(Int(navigationController.navigationBar.bounds.height))")
            return
        }

        let diagnostics = visibleNavigationControllers.map { navigationController in
            let labels = descendantLabels(in: navigationController.navigationBar)
                .compactMap(\.text)
                .filter { !$0.isEmpty }
                .joined(separator: ",")
            return "prefers=\(navigationController.navigationBar.prefersLargeTitles) mode=\(navigationController.topViewController?.navigationItem.largeTitleDisplayMode.rawValue ?? -1) barH=\(Int(navigationController.navigationBar.bounds.height)) labels=[\(labels)]"
        }
        .joined(separator: " | ")
        fail("settingsLargeTitle", diagnostics.isEmpty ? "无可见 NavigationBar" : diagnostics)
    }

    @MainActor
    private static func findNavigationControllers(from root: UIViewController?) -> [UINavigationController] {
        var result: [UINavigationController] = []
        var visited: Set<ObjectIdentifier> = []
        collectNavigationControllers(from: root, visited: &visited, result: &result)
        return result
    }

    @MainActor
    private static func collectNavigationControllers(
        from root: UIViewController?,
        visited: inout Set<ObjectIdentifier>,
        result: inout [UINavigationController]
    ) {
        guard let root, visited.insert(ObjectIdentifier(root)).inserted else { return }
        if let navigation = root as? UINavigationController {
            result.append(navigation)
        }
        for child in root.children {
            collectNavigationControllers(from: child, visited: &visited, result: &result)
        }
        collectNavigationControllers(from: root.presentedViewController, visited: &visited, result: &result)
    }

    @MainActor
    private static func descendantLabels(in view: UIView) -> [UILabel] {
        var labels = (view as? UILabel).map { [$0] } ?? []
        for subview in view.subviews {
            labels.append(contentsOf: descendantLabels(in: subview))
        }
        return labels
    }

    @MainActor
    private static func writeTopChromeSnapshot(window: UIWindow, fileName: String) {
        let height = min(window.bounds.height, 200)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: window.bounds.width, height: height))
        let image = renderer.image { context in
            context.cgContext.clip(to: CGRect(x: 0, y: 0, width: window.bounds.width, height: height))
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let data = image.pngData() else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(fileName)
        try? data.write(to: url, options: .atomic)
    }

    @MainActor
    private static func writeWindowSnapshot(window: UIWindow, fileName: String) {
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let data = image.pngData() else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(fileName)
        try? data.write(to: url, options: .atomic)
    }
}
#endif
