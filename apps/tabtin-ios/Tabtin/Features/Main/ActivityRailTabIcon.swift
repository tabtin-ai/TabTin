import SwiftUI

/// 顶栏通知复用 Electron `RailNotificationIcon` 形状资源，并以主题 accent 着色（不烘焙固定橙）。
struct ActivityRailNotificationIcon: View {
    var size: CGFloat = 21

    var body: some View {
        Image("RailNotificationSelected")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(.tt.iconAccent)
            .accessibilityHidden(true)
    }
}
