import SwiftUI

/// 主壳级全局目的地承载：ME / Settings / 通知中心 / 组织邀请列表。
struct AccountGlobalPresentationHost: View {
    @Bindable private var coordinator = AccountDrawerCoordinator.shared
    @State private var router = MainRouter.shared
    @State private var colorScheme = ColorSchemeStore.shared

    var body: some View {
        let activeScheme = colorScheme.schemeId

        // 不能把 presenter 压成零尺寸。iOS 26 会把 fullScreenCover 的
        // safe-area/容器几何继承到这个零尺寸 host，导致设置页底部出现一块
        // 无法滚动到的空白区域；iOS 18 对此容错，所以旧系统不易复现。
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)
            // 挂在独立的全尺寸 presenter 上，避免继承侧栏宿主的布局/安全区副作用。
            .fullScreenCover(
                item: $coordinator.presentedGlobalSheet,
                onDismiss: {
                    NotificationCenter.default.post(
                        name: .ttAccountGlobalSheetDidFinishDismissing,
                        object: nil
                    )
                }
            ) { sheet in
                NavigationStack {
                    destination(for: sheet)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button(L10n.Common.close) {
                                    coordinator.dismissGlobalSheet()
                                }
                            }
                        }
                }
                // fullScreenCover 有独立的呈现树，显式订阅账号配色，避免必须退出设置才刷新。
                .tint(SettingsAppearancePresentation.accentColor(for: activeScheme))
                .onAppear {
                    NotificationCenter.default.post(
                        name: .ttAccountGlobalSheetDidPresent,
                        object: nil
                    )
                }
            }
    }

    @ViewBuilder
    private func destination(for sheet: AccountGlobalSheet) -> some View {
        switch sheet {
        case .me:
            MeScreen()
        case .settings:
            SettingsHomeScreen()
        case .notifications:
            NotificationCenterScreen(
                onOpenConversation: { target in
                    coordinator.dismissGlobalSheet()
                    router.openConversation(target)
                },
                onOpenIMConversation: { target in
                    coordinator.dismissGlobalSheet()
                    router.openIMConversation(target)
                }
            )
        case .organizationInvitations:
            OrganizationInvitationsScreen()
        }
    }
}

/// 抽屉入口的 push 目的地。由当前一级 Tab 的 NavigationStack 承载，
/// 这样既保持 push 手势/返回语义，也不会在 MainTabView 外层制造第二套顶栏。
struct AccountGlobalPushDestinationScreen: View {
    let destination: AccountGlobalPushDestination
    let onOpenConversation: (ConversationTarget) -> Void
    let onOpenIMConversation: (IMConversationTarget) -> Void

    var body: some View {
        switch destination {
        case .me:
            MeScreen()
        case .settings:
            SettingsHomeScreen()
        case .notifications:
            NotificationCenterScreen(
                onOpenConversation: onOpenConversation,
                onOpenIMConversation: onOpenIMConversation
            )
        case .organizationInvitations:
            OrganizationInvitationsScreen()
        }
    }
}
