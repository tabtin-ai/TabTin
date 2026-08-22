import SwiftUI

/// 一级 Root 顶栏统一菜单入口：打开全局账户侧栏（资料、组织、设置等）。
///
/// 侧栏不止「我的」，所以用三横杠而不是头像；保留系统 toolbar 按钮底，
/// 与右侧通知铃同一套控件语言。
struct AccountDrawerToolbarButton: View {
    @State private var coordinator = AccountDrawerCoordinator.shared

    var body: some View {
        Button {
            coordinator.openDrawer()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.tt.iconSubtitle)
                .frame(width: 32, height: 32)
        }
        .accessibilityLabel(L10n.AccountDrawer.openMenu)
    }
}

/// 顶栏 leading 位的侧栏菜单项；保留 iOS 26 toolbar 共享玻璃底。
struct AccountDrawerToolbarLeadingItem: ToolbarContent {
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            AccountDrawerToolbarButton()
        }
    }
}

@available(*, deprecated, renamed: "AccountDrawerToolbarButton")
typealias AccountAvatarToolbarButton = AccountDrawerToolbarButton

@available(*, deprecated, renamed: "AccountDrawerToolbarLeadingItem")
typealias AccountAvatarToolbarLeadingItem = AccountDrawerToolbarLeadingItem
