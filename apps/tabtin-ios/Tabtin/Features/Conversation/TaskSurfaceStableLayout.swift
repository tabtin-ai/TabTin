import CoreGraphics
import Foundation

/// iPad 三态下对话 / 工作台的稳定几何：两实例始终各占一个 placement，
/// 只改 width / opacity / hitTesting；右缘固定、左缘伸缩。
enum TaskSurfaceStableLayout {
    struct PaneGeometry: Equatable, Sendable {
        var conversationWidth: CGFloat
        var workbenchWidth: CGFloat
        var conversationOpacity: Double
        var workbenchOpacity: Double
        var conversationAllowsHitTesting: Bool
        var workbenchAllowsHitTesting: Bool
        var showsDivider: Bool
        /// 工作台贴右；恒为 0，表达「右缘固定」。
        var workbenchTrailingInset: CGFloat
        /// 对话贴左；恒为 0。
        var conversationLeadingInset: CGFloat
    }

    /// - Parameters:
    ///   - mode: chat-focus / split / app-focus
    ///   - availableWidth: 工作区总宽
    ///   - workbenchFraction: 分屏时工作台目标比例（经 ``TaskSurfaceSplitMetrics`` 夹取）
    static func geometry(
        mode: TaskViewMode,
        availableWidth: CGFloat,
        workbenchFraction: Double
    ) -> PaneGeometry {
        let width = max(0, availableWidth)
        switch mode {
        case .chatFocus:
            return PaneGeometry(
                conversationWidth: width,
                workbenchWidth: 0,
                conversationOpacity: 1,
                workbenchOpacity: 0,
                conversationAllowsHitTesting: true,
                workbenchAllowsHitTesting: false,
                showsDivider: false,
                workbenchTrailingInset: 0,
                conversationLeadingInset: 0
            )
        case .appFocus:
            return PaneGeometry(
                conversationWidth: 0,
                workbenchWidth: width,
                conversationOpacity: 0,
                workbenchOpacity: 1,
                conversationAllowsHitTesting: false,
                workbenchAllowsHitTesting: true,
                showsDivider: false,
                workbenchTrailingInset: 0,
                conversationLeadingInset: 0
            )
        case .split:
            let workbenchWidth = TaskSurfaceSplitMetrics.workbenchWidth(
                availableWidth: width,
                fraction: workbenchFraction
            )
            let divider = TaskSurfaceSplitMetrics.dividerHitWidth
            let conversationWidth = max(0, width - workbenchWidth - divider)
            return PaneGeometry(
                conversationWidth: conversationWidth,
                workbenchWidth: workbenchWidth,
                conversationOpacity: 1,
                workbenchOpacity: 1,
                conversationAllowsHitTesting: true,
                workbenchAllowsHitTesting: true,
                showsDivider: true,
                workbenchTrailingInset: 0,
                conversationLeadingInset: 0
            )
        }
    }

    /// 分屏对话栏在容器坐标系中的目标 rect（供 to-rail morph 的 finalRect）。
    static func splitConversationTargetRect(
        container: CGRect,
        workbenchFraction: Double
    ) -> CGRect {
        let geo = geometry(
            mode: .split,
            availableWidth: container.width,
            workbenchFraction: workbenchFraction
        )
        return CGRect(
            x: container.minX + geo.conversationLeadingInset,
            y: container.minY,
            width: geo.conversationWidth,
            height: container.height
        )
    }
}
