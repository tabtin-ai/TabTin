import SwiftUI
import UIKit

/// 重构后的 iOS 客户端入口（Phase 0 脚手架）。
///
/// 职责边界：只做 bootstrap —— 依赖装配 + 环境注入 + 根路由。
/// 业务（会话 / 各内嵌 App）落在 `Features/*`，核心能力落在 `Core/*`。
/// 详见 docs/planning/tabtin-ios-rebuild-2026-06.md。
@main
struct TabtinApp: App {
    /// UIKit 挂点：原生 APNs token 与通知点击回调需要真实 AppDelegate。
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var theme = ThemeManager.shared
    @State private var colorScheme = ColorSchemeStore.shared
    @State private var router = MainRouter.shared
    @State private var renderedColorScheme = ColorSchemeStore.shared.schemeId
    @State private var isAccountGlobalSheetVisuallyPresented = false
    @State private var isLaunchSplashVisible = true
    private let launchSplashStartedAt = Date()

    init() {
        let isMobileConceptReview = ProcessInfo.processInfo.arguments.contains("--mobile-concept-review")
        let isNativeCloudDocsReview = ProcessInfo.processInfo.arguments.contains("--native-cloud-docs-review")
        let isAgentRuntimeReview = ProcessInfo.processInfo.arguments.contains("--agent-runtime-composer-review")
            || ProcessInfo.processInfo.arguments.contains("--composer-reading-collapse-review")
        PerfTrace.markColdStart()
        SentryReporter.start()
        SentryContextProvider.shared.start()
        DiagnosticRecorder.captureApp(name: "application_started")
        IOSDiagnosticRuntime.start()
        // 确定性视觉夹具不展示 DebugSwift 悬浮球，避免截图被开发工具遮挡。
        if !isMobileConceptReview && !isNativeCloudDocsReview && !isAgentRuntimeReview {
            DebugTools.start()
        }
        configureSystemAppearance()
        PerfTrace.installMainThreadWatchdog()
        Task { @MainActor in
            await APIClient.shared.syncFromAppConfig()
            ChatMarkdownRendererWarmup.prewarm()
        }
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                Group {
                    #if DEBUG
                    if SessionRunAcceptanceHarness.isEnabled {
                        SessionRunAcceptanceHarnessRoot()
                    } else if ProcessInfo.processInfo.arguments.contains("--composer-reading-collapse-review") {
                        ComposerReadingCollapseReviewRoot()
                    } else if ProcessInfo.processInfo.arguments.contains("--agent-runtime-composer-review") {
                        AgentRuntimeComposerReviewRoot()
                    } else if ProcessInfo.processInfo.arguments.contains("--mobile-concept-review") {
                        MobileConceptReviewRoot()
                    } else if ProcessInfo.processInfo.arguments.contains("--native-cloud-docs-review") {
                        NativeCloudDocsReviewRoot()
                    } else {
                        RootView()
                    }
                    #else
                    RootView()
                    #endif
                }

                if isLaunchSplashVisible && shouldPresentLaunchSplash {
                    LaunchSplashView(startedAt: launchSplashStartedAt)
                        .zIndex(1_000)
                        .transition(.opacity)
                }
            }
            // 强调色随账号级 colorScheme 变化；`id` 参与身份，服务端改配色时强制整树重建，
            // 否则已上屏视图仍持有旧 scheme 解出的 `.tt.*` 常量。全局页面或任意 push
            // 子页展示期间保持主树身份稳定，避免即时换色把 NavigationStack / 表单状态重置。
            .id(renderedColorScheme)
            .tint(.tt.bgAccent)
            .preferredColorScheme(theme.resolvedColorScheme)
            .onChange(of: theme.mode) { _, _ in
                configureSystemAppearance()
            }
            .onChange(of: colorScheme.schemeId) { _, newScheme in
                configureSystemAppearance()
                renderedColorScheme = ColorSchemeRootRefreshPolicy.schemeForRoot(
                    current: renderedColorScheme,
                    selected: newScheme,
                    hasActiveGlobalPresentation: isAccountGlobalSheetVisuallyPresented,
                    hasPushedDestination: router.selectedTabHasPushedChild
                )
            }
            .onChange(of: router.selectedTabHasPushedChild) { _, hasPushedDestination in
                guard !hasPushedDestination, !isAccountGlobalSheetVisuallyPresented else { return }
                renderedColorScheme = colorScheme.schemeId
            }
            .onReceive(NotificationCenter.default.publisher(for: .ttAccountGlobalSheetDidPresent)) { _ in
                isAccountGlobalSheetVisuallyPresented = true
            }
            .onReceive(NotificationCenter.default.publisher(for: .ttAccountGlobalSheetDidFinishDismissing)) { _ in
                // `fullScreenCover` 的 onDismiss 在退场动画完成后触发；此时再刷新主页，
                // 既不会打断设置页，也能保证返回主页时已经使用最新主题。
                let hasReplacementSheet = AccountDrawerCoordinator.shared.presentedGlobalSheet != nil
                let resolution = ColorSchemeRootRefreshPolicy.resolveDismissal(
                    current: renderedColorScheme,
                    selected: colorScheme.schemeId,
                    hasReplacementPresentation: hasReplacementSheet,
                    hasPushedDestination: router.selectedTabHasPushedChild
                )
                isAccountGlobalSheetVisuallyPresented = resolution.keepsPresentationActive
                renderedColorScheme = resolution.renderedScheme
            }
            .onAppear {
                // `init` 时 Window 尚未创建；在首帧后再同步一次，确保保存的深色/浅色偏好
                // 也会落到 UIKit navigation / tab 外观上。
                configureSystemAppearance()
                colorScheme.bootstrap()
            }
            .task {
                guard isLaunchSplashVisible, shouldPresentLaunchSplash else {
                    isLaunchSplashVisible = false
                    return
                }
                try? await Task.sleep(for: .seconds(4.12))
                withAnimation(.easeOut(duration: 0.24)) {
                    isLaunchSplashVisible = false
                }
            }
            .onOpenURL(perform: handleDeepLink)
        }
    }

    private var shouldPresentLaunchSplash: Bool {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        return !SessionRunAcceptanceHarness.isEnabled
            && !arguments.contains("--composer-reading-collapse-review")
            && !arguments.contains("--agent-runtime-composer-review")
            && !arguments.contains("--mobile-concept-review")
            && !arguments.contains("--native-cloud-docs-review")
        #else
        return true
        #endif
    }

    /// SwiftUI 的 `preferredColorScheme` 管内容区，UIKit 的导航栏 / 弹窗按钮仍要同步
    /// window trait 与全局 appearance。否则主题自动切换后容易留下蓝色按钮或上一主题的标题色。
    @MainActor
    private func configureSystemAppearance() {
        let navigationAppearance = UINavigationBarAppearance()
        navigationAppearance.configureWithTransparentBackground()
        navigationAppearance.titleTextAttributes = [.foregroundColor: TTColors.textPrimaryUI]
        navigationAppearance.largeTitleTextAttributes = [.foregroundColor: TTColors.textPrimaryUI]

        let navigationBar = UINavigationBar.appearance()
        navigationBar.standardAppearance = navigationAppearance
        navigationBar.compactAppearance = navigationAppearance
        navigationBar.scrollEdgeAppearance = navigationAppearance
        navigationBar.tintColor = TTColors.bgAccentUI

        let tabBarAppearance = UITabBarAppearance()
        tabBarAppearance.configureWithOpaqueBackground()
        tabBarAppearance.backgroundColor = TTColors.bgCanvasDefaultUI
        tabBarAppearance.shadowColor = TTColors.borderLightUI
        for itemAppearance in [
            tabBarAppearance.stackedLayoutAppearance,
            tabBarAppearance.inlineLayoutAppearance,
            tabBarAppearance.compactInlineLayoutAppearance,
        ] {
            itemAppearance.normal.iconColor = TTColors.textSecondaryUI
            itemAppearance.normal.titleTextAttributes = [.foregroundColor: TTColors.textSecondaryUI]
            itemAppearance.selected.iconColor = TTColors.bgAccentUI
            itemAppearance.selected.titleTextAttributes = [.foregroundColor: TTColors.bgAccentUI]
        }
        let tabBar = UITabBar.appearance()
        tabBar.standardAppearance = tabBarAppearance
        tabBar.scrollEdgeAppearance = tabBarAppearance

        let style: UIUserInterfaceStyle
        switch ThemeManager.shared.mode {
        case .system: style = .unspecified
        case .light: style = .light
        case .dark: style = .dark
        }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            windowScene.windows.forEach { $0.overrideUserInterfaceStyle = style }
        }
    }

    private func handleDeepLink(_ url: URL) {
        if InviteDeepLinkCoordinator.shared.receive(url) { return }
        guard let result = ResourceDeepLinkParser.parse(url) else { return }
        Task { @MainActor in
            switch result {
            case let .target(target):
                MainRouter.shared.openResource(target)
            case .missingContext:
                MainRouter.shared.presentNavigationNotice(L10n.Common.resourceLinkMissingContext)
            }
        }
    }
}

/// 主题切换时的根视图身份策略。设置等全局页面自己观察配色并即时刷新；主壳的整树
/// 重建延后到全屏页面退场或 push 子页返回，避免丢失二级页导航、滚动位置和未提交输入。
enum ColorSchemeRootRefreshPolicy {
    struct DismissalResolution: Equatable {
        let renderedScheme: ColorSchemeId
        let keepsPresentationActive: Bool
    }

    static func schemeForRoot(
        current: ColorSchemeId,
        selected: ColorSchemeId,
        hasActiveGlobalPresentation: Bool,
        hasPushedDestination: Bool = false
    ) -> ColorSchemeId {
        hasActiveGlobalPresentation || hasPushedDestination ? current : selected
    }

    static func resolveDismissal(
        current: ColorSchemeId,
        selected: ColorSchemeId,
        hasReplacementPresentation: Bool,
        hasPushedDestination: Bool = false
    ) -> DismissalResolution {
        DismissalResolution(
            renderedScheme: schemeForRoot(
                current: current,
                selected: selected,
                hasActiveGlobalPresentation: hasReplacementPresentation,
                hasPushedDestination: hasPushedDestination
            ),
            keepsPresentationActive: hasReplacementPresentation
        )
    }
}

extension Notification.Name {
    static let tabtinResourceNavigation = Notification.Name("tabtin.resource.navigation")
    static let ttAccountGlobalSheetDidPresent = Notification.Name(
        "tt.account-global-sheet.did-present"
    )
    static let ttAccountGlobalSheetDidFinishDismissing = Notification.Name(
        "tt.account-global-sheet.did-finish-dismissing"
    )
}
