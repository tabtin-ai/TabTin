import SwiftUI

/// TabTin 间距令牌
///
/// 与 Android `TTSpacing` 完全对齐，数值相同、命名相同。
///
/// | 令牌   | 值   | 典型用途                   |
/// | ----- | ---- | ----------------------- |
/// | xxs   | 2    | 图标与徽标间微间距             |
/// | xs    | 4    | 行内元素间距、标签间间距         |
/// | sm    | 8    | 卡片内边距、元素间默认间距        |
/// | md    | 12   | 列表行垂直内边距、组间距         |
/// | lg    | 16   | 屏幕水平内边距、区域间距         |
/// | xl    | 20   | 大段落间距                  |
/// | xxl   | 24   | 节标题与内容间距              |
/// | xxxl  | 32   | 章节间距                   |
/// | huge  | 48   | 页面顶部留白、大装饰间距         |
public enum TTSpacing {
    public static let xxs: CGFloat = 2
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 20
    public static let xxl: CGFloat = 24
    public static let xxxl: CGFloat = 32
    public static let huge: CGFloat = 48

    /// 列表行内边距
    public enum ListRow {
        public static let horizontal: CGFloat = 16
        public static let vertical: CGFloat = 12
        public static let insets = EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
    }

    /// 屏幕级内边距
    public enum Screen {
        public static let horizontal: CGFloat = 16
        public static let vertical: CGFloat = 16
    }

    /// 交互控件尺寸。统一使用 HIG 建议的最小可点区域，避免各页面散落 44pt。
    public enum Control {
        public static let minimumTouchTarget: CGFloat = 44
    }
}

/// TabTin 圆角令牌。
///
/// 对齐 Electron：交互控件统一 8pt（`rounded-interactive`）；
/// 12 / 16 / 20 仅作结构面档位。详见 `apps/tabtin-ios/docs/design-system.md`。
public enum TTRadius {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    /// 按钮 / 输入 / 菜单 / Toast —— 与 Electron `rounded-interactive` 同值。
    public static let interactive: CGFloat = sm
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 20
    public static let full: CGFloat = 9999
}

/// 对话气泡专用形状令牌（非对称圆角）
///
/// 用户气泡右下角、AI 气泡左下角使用小圆角，其余三角为 `TTRadius.lg`。
/// 与 Android `TTBubbleShape` 对齐。
public enum TTBubbleShape {
    public static let outgoing = UnevenRoundedRectangle(cornerRadii: .init(
        topLeading: TTRadius.lg,
        bottomLeading: TTRadius.lg,
        bottomTrailing: TTRadius.xs,
        topTrailing: TTRadius.lg
    ))
    public static let incoming = UnevenRoundedRectangle(cornerRadii: .init(
        topLeading: TTRadius.lg,
        bottomLeading: TTRadius.xs,
        bottomTrailing: TTRadius.lg,
        topTrailing: TTRadius.lg
    ))
}
