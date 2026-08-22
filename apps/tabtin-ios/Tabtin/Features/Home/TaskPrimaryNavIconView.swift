import SwiftUI

/// Electron 同源 Lucide 图标：新建 SquarePen；技能入口对齐市场页眉 Blocks；自动化 Activity。
enum TaskPrimaryNavIcon {
    case newTask
    case skills
    case automation
    case archived

    var assetName: String {
        switch self {
        case .newTask: return "LucideSquarePen"
        case .skills: return "LucideBlocks"
        case .automation: return "LucideActivity"
        case .archived: return "LucideArchive"
        }
    }
}

struct TaskPrimaryNavIconView: View {
    let icon: TaskPrimaryNavIcon
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
