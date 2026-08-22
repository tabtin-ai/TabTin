import SwiftUI

/// 对齐 `@tabtin/shared` `identity-avatar.ts`：默认头像色只由稳定身份 ID 决定。
/// AI Agent 也可复用同一套哈希色（产品口径）。
enum IdentityAvatar {
    /// `identityAvatarHue`
    static func hue(_ identity: String?) -> Int {
        let value = (identity?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "?"
        var hash: Int32 = 0
        for scalar in value.unicodeScalars {
            // 对齐 JS：`hash = ((hash << 5) - hash + charCode) | 0`（32-bit）
            hash = hash &<< 5 &- hash &+ Int32(scalar.value)
        }
        let absHash = hash == Int32.min ? Int32.max : abs(hash)
        return Int(absHash % 360)
    }

    /// `identityAvatarColor` → SwiftUI `Color`（HSL 55% / 55%）
    static func color(_ identity: String?) -> Color {
        Color(hue: Double(hue(identity)) / 360.0, saturation: 0.55, brightness: 0.55)
    }

    /// 有稳定 ID 就用 ID；否则才用显示名。名称变化不能改颜色。
    static func colorSeed(_ identity: String?, fallbackName: String?) -> String {
        let id = identity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !id.isEmpty { return id }
        let name = fallbackName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "?" : name
    }

    /// 中文名取最后两个字；英文名取首词与末词的首字母并保留原始大小写，最多显示两个字符。
    static func initials(_ name: String?) -> String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return "?" }

        let visibleCharacters = trimmed.filter { !$0.isWhitespace }
        if visibleCharacters.contains(where: { $0.isHanCharacter }) {
            return String(visibleCharacters.suffix(2))
        }

        let words = trimmed.split(whereSeparator: { $0.isWhitespace })
        guard let first = words.first?.first else { return "?" }
        guard words.count > 1, let last = words.last?.first else {
            return String(first)
        }
        return "\(first)\(last)"
    }

    static func initial(_ name: String?) -> String { initials(name) }
}

private extension Character {
    var isHanCharacter: Bool {
        unicodeScalars.contains { scalar in
            (0x3400 ... 0x4DBF).contains(scalar.value)
                || (0x4E00 ... 0x9FFF).contains(scalar.value)
                || (0xF900 ... 0xFAFF).contains(scalar.value)
        }
    }
}
