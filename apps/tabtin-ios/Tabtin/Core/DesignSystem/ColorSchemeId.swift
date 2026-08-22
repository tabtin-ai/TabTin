import Foundation

/// 与 Electron `ColorSchemeId` / 后端 `ui_settings.colorScheme` 值域对齐。
enum ColorSchemeId: String, CaseIterable, Identifiable, Codable, Sendable {
    case blue
    case teal
    case orange
    case rose
    case slate
    case violet
    case sky

    var id: String { rawValue }

    /// iOS 在未保存用户配色时使用的默认方案。
    static let `default`: ColorSchemeId = .orange

    static func resolve(_ raw: String?) -> ColorSchemeId {
        guard let raw, let id = ColorSchemeId(rawValue: raw) else {
            return .default
        }
        return id
    }
}
