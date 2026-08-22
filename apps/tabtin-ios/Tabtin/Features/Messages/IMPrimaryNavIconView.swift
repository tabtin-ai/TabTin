import SwiftUI

/// Electron 消息域侧栏同源 Lucide 图标（`SidebarIMPrimaryNav` → UsersRound / Contact）。
enum IMPrimaryNavIcon {
    case createGroup
    case contacts

    var assetName: String {
        switch self {
        case .createGroup: return "LucideUsersRound"
        case .contacts: return "LucideContact"
        }
    }
}

struct IMPrimaryNavIconView: View {
    let icon: IMPrimaryNavIcon
    var size: CGFloat = 17
    var color: Color = .tt.textTertiary

    var body: some View {
        Image(icon.assetName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color)
            .accessibilityHidden(true)
    }
}
