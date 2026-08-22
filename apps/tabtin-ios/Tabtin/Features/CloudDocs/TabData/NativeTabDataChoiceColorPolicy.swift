import SwiftUI

/// 多维表单选 / 多选胶囊色。必须与 Web `resolveSelectChipColors` 使用同一套
/// 选项语义色、预设色板、djb2 变体 hash 和亮度阈值。
///
/// 同一条记录会在 Electron、iOS、Android 上同时打开。如果 hash 或映射不一致，
/// 没有保存颜色的历史选项会在各端落到不同预设色，用户会以为数据变了。
enum NativeTabDataChoiceColorPolicy {
    /// 与 Web `CHOICE_COLOR_HEX_MAP` 逐条对齐。
    static let choiceColorHexMap: [String: String] = [
        "blueLight2": "#CCE5FF",
        "blueLight1": "#99CCFF",
        "blueBright": "#007BFF",
        "blue": "#0066CC",
        "blueDark1": "#003F87",
        "cyanLight2": "#CCF4F8",
        "cyanLight1": "#99E4EC",
        "cyanBright": "#00BCD4",
        "cyan": "#0097A7",
        "cyanDark1": "#006064",
        "grayLight2": "#F5F5F5",
        "grayLight1": "#DCDCDC",
        "grayBright": "#A0A0A0",
        "gray": "#808080",
        "grayDark1": "#505050",
        "greenLight2": "#CCFFCC",
        "greenLight1": "#90EE90",
        "greenBright": "#28A745",
        "green": "#1E824C",
        "greenDark1": "#145323",
        "orangeLight2": "#FFE5CC",
        "orangeLight1": "#FFCC99",
        "orangeBright": "#FF9F00",
        "orange": "#FA8000",
        "orangeDark1": "#CC5500",
        "pinkLight2": "#FFE0E6",
        "pinkLight1": "#FFB6C1",
        "pinkBright": "#FF407B",
        "pink": "#FF1493",
        "pinkDark1": "#C2185B",
        "purpleLight2": "#E5CCFF",
        "purpleLight1": "#CC99FF",
        "purpleBright": "#9B59B6",
        "purple": "#800080",
        "purpleDark1": "#663399",
        "redLight2": "#FFD6D6",
        "redLight1": "#FFA3A3",
        "redBright": "#F15646",
        "red": "#D90A19",
        "redDark1": "#A30A0A",
        "tealLight2": "#B2EBF2",
        "tealLight1": "#80CBC4",
        "tealBright": "#009688",
        "teal": "#00796B",
        "tealDark1": "#004B44",
        "yellowLight2": "#FFF3BF",
        "yellowLight1": "#FFEC99",
        "yellowBright": "#FFD43B",
        "yellow": "#FCC419",
        "yellowDark1": "#FAB005",
    ]

    /// 与 Web `SELECT_CHOICE_PRESET_COLORS` 逐条对齐。
    static let presetColors: [String] = [
        "#0066CC", "#007BFF", "#99CCFF",
        "#0097A7", "#00BCD4", "#99E4EC",
        "#1E824C", "#28A745", "#90EE90",
        "#FA8000", "#FF9F00", "#FFCC99",
        "#FF1493", "#FF407B", "#FFB6C1",
        "#800080", "#9B59B6", "#CC99FF",
        "#D90A19", "#F15646", "#FFA3A3",
        "#00796B", "#009688", "#80CBC4",
        "#FCC419", "#FFD43B", "#FFEC99",
        "#808080", "#A0A0A0", "#DCDCDC",
    ]

    /// 与 Web `resolveSelectChipColors` 逐条对齐。
    static func resolve(color: String?, value: String) -> (background: Color, foreground: Color) {
        let hex = resolveHex(color: color, value: value)
        return (Color(hex: hex.background), Color(hex: hex.foreground))
    }

    /// 测试与跨端对照用的 HEX 口径，避免 SwiftUI `Color` 比较不稳定。
    static func resolveHex(color: String?, value: String) -> (background: String, foreground: String) {
        let rawColor = color?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let mapped = choiceColorHexMap[rawColor] {
            return (mapped, foregroundHex(for: mapped))
        }
        if let hex = normalizeHexColor(rawColor) {
            return (hex, foregroundHex(for: hex))
        }
        let background = presetColors[presetIndex(for: value)]
        return (background, foregroundHex(for: background))
    }

    /// 与 Web `normalizeHexColor` 对齐：3 位简写展开，输出大写 `#RRGGBB`。
    static func normalizeHexColor(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.range(of: #"^#([0-9a-fA-F]{3})$"#, options: .regularExpression) != nil {
            let rgb = Array(trimmed.dropFirst())
            return "#\(rgb[0])\(rgb[0])\(rgb[1])\(rgb[1])\(rgb[2])\(rgb[2])".uppercased()
        }
        if let match = trimmed.range(of: #"^#([0-9a-fA-F]{6})$"#, options: .regularExpression) {
            return String(trimmed[match]).uppercased()
        }
        return nil
    }

    /// 与 Web `stableHash` 对齐：UTF-16 code unit + 32 位 djb2 变体，再 `Math.abs`。
    static func stableHash(_ value: String) -> Int {
        var hash: Int32 = 0
        for unit in value.utf16 {
            hash = hash &* 31 &+ Int32(unit)
        }
        if hash == .min {
            return 2_147_483_648
        }
        return Int(abs(hash))
    }

    static func isLightHexColor(_ hex: String) -> Bool {
        guard let normalized = normalizeHexColor(hex) else { return false }
        let digits = Array(normalized.dropFirst())
        let red = Int(String(digits[0...1]), radix: 16) ?? 0
        let green = Int(String(digits[2...3]), radix: 16) ?? 0
        let blue = Int(String(digits[4...5]), radix: 16) ?? 0
        let brightness = (red * 299 + green * 587 + blue * 114) / 1000
        return brightness >= 155
    }

    private static func presetIndex(for value: String) -> Int {
        stableHash(value) % presetColors.count
    }

    private static func foregroundHex(for background: String) -> String {
        isLightHexColor(background) ? "#000000" : "#FFFFFF"
    }
}
