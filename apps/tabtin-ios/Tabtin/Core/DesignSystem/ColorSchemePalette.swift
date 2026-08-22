import os
import SwiftUI

/// 单套 scheme 的语义色值（light / dark）。
/// 色值移植自 Electron `globals.css` 的 `[data-color-scheme]` 块 + `color-schemes.ts` accent。
struct ColorSchemeTokens: Sendable {
    let bgCanvasDefault: (light: UInt, dark: UInt)
    let bgSubtle: (light: UInt, dark: UInt)
    let bgSubtleSecondary: (light: UInt, dark: UInt)
    let bgAccent: (light: UInt, dark: UInt)
    let bgAccentPressed: (light: UInt, dark: UInt)
    let bgAccentDisabled: (light: UInt, dark: UInt)
    let bgBubbleOutgoing: (light: UInt, dark: UInt)
    let bgReasoning: (light: UInt, dark: UInt)
    let textPrimary: (light: UInt, dark: UInt)
    let textSecondary: (light: UInt, dark: UInt)
    let textTertiary: (light: UInt, dark: UInt)
    let textAccent: (light: UInt, dark: UInt)
    let textDisabled: (light: UInt, dark: UInt)
    let iconAccent: (light: UInt, dark: UInt)
    let borderLight: (light: UInt, dark: UInt)
    let borderInteractive: (light: UInt, dark: UInt)
    let borderFocused: (light: UInt, dark: UInt)
}

enum ColorSchemePalette {
    static func tokens(for id: ColorSchemeId) -> ColorSchemeTokens {
        switch id {
        case .blue: return blue
        case .teal: return teal
        case .orange: return orange
        case .rose: return rose
        case .slate: return slate
        case .violet: return violet
        case .sky: return sky
        }
    }

    // MARK: - blue（DEFAULT）

    private static let blue = ColorSchemeTokens(
        bgCanvasDefault: (0xF6F7F8, 0x131416),
        bgSubtle: (0xEEEFF2, 0x26282B),
        bgSubtleSecondary: (0xF1F2F4, 0x222427),
        bgAccent: (0x3577D4, 0x5F94DD),
        bgAccentPressed: (0x2969C2, 0x4683D8),
        bgAccentDisabled: (0xE8EEF7, 0x202C3C),
        bgBubbleOutgoing: (0xE2EAF6, 0x24303C),
        bgReasoning: (0xE8EEF7, 0x202C3C),
        textPrimary: (0x22262A, 0xE3E5E8),
        textSecondary: (0x6B6F76, 0x94989E),
        textTertiary: (0x9A9EA6, 0x5C6066),
        textAccent: (0x3577D4, 0x5F94DD),
        textDisabled: (0xB0B6C0, 0x6A7280),
        iconAccent: (0x3577D4, 0x5F94DD),
        borderLight: (0xE1E3E5, 0x303236),
        borderInteractive: (0xC5D0E0, 0x3A4A5E),
        borderFocused: (0x3577D4, 0x5F94DD)
    )

    // MARK: - teal

    private static let teal = ColorSchemeTokens(
        bgCanvasDefault: (0xF6F8F8, 0x131615),
        bgSubtle: (0xEEF1F1, 0x272B2B),
        bgSubtleSecondary: (0xF1F4F4, 0x222626),
        bgAccent: (0x30A6A2, 0x4DCBC7),
        bgAccentPressed: (0x2A928F, 0x38C2BD),
        bgAccentDisabled: (0xE9F7F6, 0x1F3332),
        bgBubbleOutgoing: (0xE0F2F1, 0x243835),
        bgReasoning: (0xE9F7F6, 0x1F3332),
        textPrimary: (0x232929, 0xE3E8E7),
        textSecondary: (0x6B7675, 0x959D9C),
        textTertiary: (0x9AA6A5, 0x5A6463),
        textAccent: (0x30A6A2, 0x4DCBC7),
        textDisabled: (0xA8C0BE, 0x6A8280),
        iconAccent: (0x30A6A2, 0x4DCBC7),
        borderLight: (0xE1E5E4, 0x303635),
        borderInteractive: (0xBFD4D3, 0x3A5554),
        borderFocused: (0x30A6A2, 0x4DCBC7)
    )

    // MARK: - orange（历史 iOS 硬编码基线）

    private static let orange = ColorSchemeTokens(
        bgCanvasDefault: (0xFDFDFC, 0x201F1D),
        bgSubtle: (0xF2F0EE, 0x322F2B),
        bgSubtleSecondary: (0xF4F3F1, 0x2B2926),
        bgAccent: (0xE07E29, 0xE6944C),
        bgAccentPressed: (0xCD6F1D, 0xE28432),
        bgAccentDisabled: (0xF7E4D4, 0x4A3A2E),
        bgBubbleOutgoing: (0xF4DFCC, 0x3C3128),
        bgReasoning: (0xFAEFE6, 0x33251C),
        textPrimary: (0x2A2622, 0xE9E6E2),
        textSecondary: (0x878078, 0x938C85),
        textTertiary: (0xB7AEA6, 0x5F5750),
        textAccent: (0xE07E29, 0xE6944C),
        textDisabled: (0xC6B2A0, 0x8E7B6C),
        iconAccent: (0xE07E29, 0xE6944C),
        borderLight: (0xE6E3E0, 0x363330),
        borderInteractive: (0xD8C8BB, 0x5B4A3C),
        borderFocused: (0xE07E29, 0xE6944C)
    )

    // MARK: - rose

    private static let rose = ColorSchemeTokens(
        bgCanvasDefault: (0xF8F6F7, 0x161314),
        bgSubtle: (0xF1EEEF, 0x2B2727),
        bgSubtleSecondary: (0xF4F1F2, 0x262323),
        bgAccent: (0xC84158, 0xD3697B),
        bgAccentPressed: (0xB6354A, 0xCD5166),
        bgAccentDisabled: (0xF7E9EB, 0x331F22),
        bgBubbleOutgoing: (0xF2DFE3, 0x332225),
        bgReasoning: (0xF7E9EB, 0x331F22),
        textPrimary: (0x292425, 0xE8E3E4),
        textSecondary: (0x756C6D, 0x9D9596),
        textTertiary: (0xA69A9C, 0x635A5C),
        textAccent: (0xC84158, 0xD3697B),
        textDisabled: (0xC4A8AE, 0x8A6A70),
        iconAccent: (0xC84158, 0xD3697B),
        borderLight: (0xE5E1E2, 0x363031),
        borderInteractive: (0xE0C5CB, 0x5A3A40),
        borderFocused: (0xC84158, 0xD3697B)
    )

    // MARK: - slate

    private static let slate = ColorSchemeTokens(
        bgCanvasDefault: (0xF7F7F8, 0x131415),
        bgSubtle: (0xEFEFF1, 0x27282A),
        bgSubtleSecondary: (0xF2F2F4, 0x222325),
        bgAccent: (0x606876, 0x8F96A3),
        bgAccentPressed: (0x555B68, 0x7E8695),
        bgAccentDisabled: (0xEEEFF1, 0x26282C),
        bgBubbleOutgoing: (0xE6E7EA, 0x2A2C31),
        bgReasoning: (0xEEEFF1, 0x26282C),
        textPrimary: (0x242529, 0xE4E5E7),
        textSecondary: (0x6C6F75, 0x95989D),
        textTertiary: (0x9A9DA3, 0x5C5F65),
        textAccent: (0x606876, 0x8F96A3),
        textDisabled: (0xB0B4BA, 0x6A6E74),
        iconAccent: (0x606876, 0x8F96A3),
        borderLight: (0xE2E3E4, 0x313235),
        borderInteractive: (0xC8CCD2, 0x454A52),
        borderFocused: (0x606876, 0x8F96A3)
    )

    // MARK: - violet

    private static let violet = ColorSchemeTokens(
        bgCanvasDefault: (0xF7F7F8, 0x141316),
        bgSubtle: (0xF0EEF1, 0x29272B),
        bgSubtleSecondary: (0xF3F1F4, 0x242227),
        bgAccent: (0x615170, 0x8C7A9F),
        bgAccentPressed: (0x544762, 0x7D6991),
        bgAccentDisabled: (0xF0EEF2, 0x29242E),
        bgBubbleOutgoing: (0xE8E4ED, 0x2C2631),
        bgReasoning: (0xF0EEF2, 0x29242E),
        textPrimary: (0x262429, 0xE6E3E8),
        textSecondary: (0x706C75, 0x99959D),
        textTertiary: (0xA09AA6, 0x605A66),
        textAccent: (0x615170, 0x8C7A9F),
        textDisabled: (0xB4A8C0, 0x6E6478),
        iconAccent: (0x615170, 0x8C7A9F),
        borderLight: (0xE3E2E4, 0x333036),
        borderInteractive: (0xCDC5D4, 0x4A4056),
        borderFocused: (0x615170, 0x8C7A9F)
    )

    // MARK: - sky

    private static let sky = ColorSchemeTokens(
        bgCanvasDefault: (0xFAFAFA, 0x111213),
        bgSubtle: (0xF1F3F3, 0x242628),
        bgSubtleSecondary: (0xF5F6F6, 0x1F2123),
        bgAccent: (0x1FB3E0, 0x49BCDF),
        bgAccentPressed: (0x1B9EC5, 0x2FB2DA),
        bgAccentDisabled: (0xE7F4F8, 0x1D2F35),
        bgBubbleOutgoing: (0xDFF0F5, 0x24343A),
        bgReasoning: (0xE7F4F8, 0x1D2F35),
        textPrimary: (0x1C1F21, 0xE9EBEC),
        textSecondary: (0x676B6F, 0x95999D),
        textTertiary: (0x969A9E, 0x5A5E62),
        textAccent: (0x1FB3E0, 0x49BCDF),
        textDisabled: (0xA0C0CC, 0x5A7880),
        iconAccent: (0x1FB3E0, 0x49BCDF),
        borderLight: (0xE4E6E7, 0x2E3033),
        borderInteractive: (0xB8D4DE, 0x3A5560),
        borderFocused: (0x1FB3E0, 0x49BCDF)
    )
}

/// 跨线程可读的当前 scheme（供 `TTColors` 计算属性使用，避免依赖 MainActor）。
enum ColorSchemeCurrent {
    private static let storageKey = "tt_color_scheme_id"

    private static let lock = OSAllocatedUnfairLock(initialState: loadInitial())
    private static let warmed = OSAllocatedUnfairLock(initialState: false)

    private static func loadInitial() -> ColorSchemeId {
        if let raw = UserDefaults.standard.string(forKey: storageKey) {
            return ColorSchemeId.resolve(raw)
        }
        return .default
    }

    /// 首次读色板时拉起 `ColorSchemeStore`（挂登出钩子 / 已登录则 GET 同步）。
    private static func warmStoreIfNeeded() {
        let shouldWarm = warmed.withLock { flag -> Bool in
            if flag { return false }
            flag = true
            return true
        }
        guard shouldWarm else { return }
        Task { @MainActor in
            ColorSchemeStore.shared.bootstrap()
        }
    }

    static var id: ColorSchemeId {
        get {
            warmStoreIfNeeded()
            return lock.withLock { $0 }
        }
        set { lock.withLock { $0 = newValue } }
    }
}
