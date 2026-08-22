import SwiftUI

// MARK: - Color Token Access

public extension Color {
    static let tt = TTColors()
}

public extension ShapeStyle where Self == Color {
    static var tt: TTColors { Self.tt }
}

/// TabTin 语义化颜色令牌。
/// 强调色 / 画布中性色随账号 `colorScheme` 走（见 `ColorSchemePalette`）；
/// 状态色保持跨 scheme 稳定。
///
/// W5：标 `Sendable`——色值经 `ColorSchemeCurrent` 读取，字段为计算属性。
public struct TTColors: Sendable {

    private var tokens: ColorSchemeTokens {
        ColorSchemePalette.tokens(for: ColorSchemeCurrent.id)
    }

    private func adaptive(_ pair: (light: UInt, dark: UInt)) -> Color {
        Color(lightMode: Color(hex: pair.light), darkMode: Color(hex: pair.dark))
    }

    // MARK: - Background

    var bgCanvasDefault: Color { adaptive(tokens.bgCanvasDefault) }
    var bgSubtle: Color { adaptive(tokens.bgSubtle) }
    var bgSubtleSecondary: Color { adaptive(tokens.bgSubtleSecondary) }
    /// 侧栏 / 任务域标题区实色底。对齐 Electron `--sidebar-fill`（浅色 #f9f9f9），不随 accent 方案变色。
    let bgSidebar = Color(lightMode: Color(hex: 0xF9F9F9), darkMode: Color(hex: 0x141414))

    // MARK: - Brand

    var bgAccent: Color { adaptive(tokens.bgAccent) }
    var bgAccentPressed: Color { adaptive(tokens.bgAccentPressed) }
    var bgAccentDisabled: Color { adaptive(tokens.bgAccentDisabled) }

    // MARK: - Resource Type

    /// 云文档列表的类型底座。颜色表达资源类型，字形本身仍保留品牌渐变。
    let bgCloudDocIcon = Color(
        lightMode: Color(hex: 0xE3F2FD),
        darkMode: Color(hex: 0x0D2744)
    )
    let bgCloudTableIcon = Color(
        lightMode: Color(hex: 0xE8F5E9),
        darkMode: Color(hex: 0x1B3A1E)
    )

    // MARK: - Status（跨 scheme 稳定）

    let bgCritical = Color(lightMode: Color(hex: 0xC93B3B), darkMode: Color(hex: 0xD95555))
    let bgSuccess = Color(lightMode: Color(hex: 0x2F9461), darkMode: Color(hex: 0x45AD78))
    let bgWarning = Color(lightMode: Color(hex: 0xD4870A), darkMode: Color(hex: 0xD4A030))
    /// 运行中。刻意不复用 accent —— accent 随用户配色方案变化（orange 方案下会和
    /// bgWarning 撞色），状态色必须跨 scheme 稳定才能保持区分度。
    let bgRunning = Color(lightMode: Color(hex: 0x3577F0), darkMode: Color(hex: 0x6098F5))

    // MARK: - Bubble / Reasoning

    var bgBubbleOutgoing: Color { adaptive(tokens.bgBubbleOutgoing) }
    let bgBubbleIncoming = Color(lightMode: Color(hex: 0xFDFDFC), darkMode: Color(hex: 0x201F1D))
    var bgReasoning: Color { adaptive(tokens.bgReasoning) }

    // MARK: - Overlay

    let overlayBackground = Color(lightMode: Color(hex: 0x000000, opacity: 0.4), darkMode: Color(hex: 0x000000, opacity: 0.6))
    let overlayBackgroundLight = Color(lightMode: Color(hex: 0x000000, opacity: 0.15), darkMode: Color(hex: 0x000000, opacity: 0.3))
    let textOnOverlay = Color.white

    // MARK: - Fullscreen（固定色，不随主题切换）

    let fullscreenBackground = Color.black
    let fullscreenForeground = Color.white
    let fullscreenForegroundDim = Color.white.opacity(0.6)
    let fullscreenButtonBackground = Color.white.opacity(0.2)
    let fullscreenSuccessBanner = Color(hex: 0x34C759, opacity: 0.85)
    let fullscreenErrorBanner = Color(hex: 0xFF3B30, opacity: 0.85)

    // MARK: - Text

    var textPrimary: Color { adaptive(tokens.textPrimary) }
    var textSecondary: Color { adaptive(tokens.textSecondary) }
    var textTertiary: Color { adaptive(tokens.textTertiary) }
    let textOnAccent = Color.white
    var textAccent: Color { adaptive(tokens.textAccent) }
    let textCritical = Color(lightMode: Color(hex: 0xC93B3B), darkMode: Color(hex: 0xD95555))
    var textDisabled: Color { adaptive(tokens.textDisabled) }
    let textSuccess = Color(lightMode: Color(hex: 0x2F9461), darkMode: Color(hex: 0x45AD78))
    let textWarning = Color(lightMode: Color(hex: 0xD4870A), darkMode: Color(hex: 0xD4A030))
    let textRunning = Color(lightMode: Color(hex: 0x3577F0), darkMode: Color(hex: 0x6098F5))

    // MARK: - Icon

    var iconPrimary: Color { adaptive(tokens.textPrimary) }
    var iconSecondary: Color { adaptive(tokens.textSecondary) }
    var iconAccent: Color { adaptive(tokens.iconAccent) }
    let iconWarning = Color(lightMode: Color(hex: 0xD4870A), darkMode: Color(hex: 0xD4A030))
    let iconSuccess = Color(lightMode: Color(hex: 0x2F9461), darkMode: Color(hex: 0x45AD78))
    let iconRunning = Color(lightMode: Color(hex: 0x3577F0), darkMode: Color(hex: 0x6098F5))

    // MARK: - Border

    var borderLight: Color { adaptive(tokens.borderLight) }
    var borderInteractive: Color { adaptive(tokens.borderInteractive) }
    var borderFocused: Color { adaptive(tokens.borderFocused) }

    // MARK: - Decorative（头像/用户名色，跨 scheme 稳定）

    let decorativeColors: [DecorativeColor] = [
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xE8F5E9), darkMode: Color(hex: 0x1B3A1E)),
            text: Color(lightMode: Color(hex: 0x2E7D32), darkMode: Color(hex: 0x81C784))
        ),
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xE3F2FD), darkMode: Color(hex: 0x0D2744)),
            text: Color(lightMode: Color(hex: 0x1565C0), darkMode: Color(hex: 0x64B5F6))
        ),
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xFFF3E0), darkMode: Color(hex: 0x3E2700)),
            text: Color(lightMode: Color(hex: 0xE65100), darkMode: Color(hex: 0xFFB74D))
        ),
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xF3E5F5), darkMode: Color(hex: 0x2A1230)),
            text: Color(lightMode: Color(hex: 0x7B1FA2), darkMode: Color(hex: 0xCE93D8))
        ),
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xFCE4EC), darkMode: Color(hex: 0x3E1018)),
            text: Color(lightMode: Color(hex: 0xC62828), darkMode: Color(hex: 0xEF9A9A))
        ),
        DecorativeColor(
            background: Color(lightMode: Color(hex: 0xE0F7FA), darkMode: Color(hex: 0x003038)),
            text: Color(lightMode: Color(hex: 0x00838F), darkMode: Color(hex: 0x4DD0E1))
        ),
    ]

    func decorativeColor(for id: String) -> DecorativeColor {
        let hash = id.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return decorativeColors[hash % decorativeColors.count]
    }
}

public struct DecorativeColor: Equatable, Sendable {
    public let background: Color
    public let text: Color
}

// MARK: - Color Helpers

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: opacity
        )
    }

    /// Parse "#RRGGBB" or "#RRGGBBAA" string into Color.
    init(hex string: String) {
        let cleaned = string.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")

        var rgb: UInt64 = 0
        Scanner(string: String(cleaned.prefix(6))).scanHexInt64(&rgb)

        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >> 8) & 0xFF) / 255.0
        let b = Double(rgb & 0xFF) / 255.0

        var opacity = 1.0
        if cleaned.count == 8 {
            var alpha: UInt64 = 0
            Scanner(string: String(cleaned.suffix(2))).scanHexInt64(&alpha)
            opacity = Double(alpha) / 255.0
        }

        self.init(red: r, green: g, blue: b, opacity: opacity)
    }

    init(lightMode: Color, darkMode: Color) {
        self.init(UIColor { traits in
            traits.userInterfaceStyle == .light ? UIColor(lightMode) : UIColor(darkMode)
        })
    }

    /// 将服务端下发的 hex 颜色适配当前主题：
    /// 浅色模式直接使用，暗色模式降低亮度以避免在深色背景上过于刺眼
    static func adaptiveHex(_ hex: UInt) -> Color {
        let light = Color(hex: hex)
        let dark = Color(UIColor(light).adjustedForDarkMode())
        return Color(lightMode: light, darkMode: dark)
    }
}

// MARK: - UIKit Colors (UINavigationBar / UITabBar appearance 直接使用)
// 绕过 SwiftUI Color ↔ UIColor 回转，确保 App 级 preferredColorScheme 覆盖时
// UIKit 外观配置能拿到与 SwiftUI 完全一致的动态颜色。

extension TTColors {
    static func dynamicUIColor(light: UInt, dark: UInt) -> UIColor {
        UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255.0,
                green: CGFloat((hex >> 8) & 0xFF) / 255.0,
                blue: CGFloat(hex & 0xFF) / 255.0,
                alpha: 1.0
            )
        }
    }

    /// 随当前账号 scheme 变化的 UIKit 色（appearance 刷新时再取一次）。
    private static func schemePair(_ keyPath: KeyPath<ColorSchemeTokens, (light: UInt, dark: UInt)>) -> (UInt, UInt) {
        let pair = ColorSchemePalette.tokens(for: ColorSchemeCurrent.id)[keyPath: keyPath]
        return (pair.light, pair.dark)
    }

    static var bgCanvasDefaultUI: UIColor {
        let pair = schemePair(\.bgCanvasDefault)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }

    static var bgSubtleUI: UIColor {
        let pair = schemePair(\.bgSubtle)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }

    static var borderLightUI: UIColor {
        let pair = schemePair(\.borderLight)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }

    static var textPrimaryUI: UIColor {
        let pair = schemePair(\.textPrimary)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }

    static var bgAccentUI: UIColor {
        let pair = schemePair(\.bgAccent)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }

    static var textSecondaryUI: UIColor {
        let pair = schemePair(\.textSecondary)
        return dynamicUIColor(light: pair.0, dark: pair.1)
    }
}

extension UIColor {
    func adjustedForDarkMode() -> UIColor {
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        return UIColor(hue: h, saturation: min(s, 0.6), brightness: min(b, 0.7), alpha: a)
    }
}
