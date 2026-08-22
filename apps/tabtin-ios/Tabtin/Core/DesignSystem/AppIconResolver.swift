import SwiftUI
import UIKit

/// App 图标解析：优先 Asset Catalog 中的品牌 SVG 光栅资产，SF Symbol 仅作 fallback。
/// 资产命名：`AppIcon` + appId 首字母大写，例如 `tabdoc` → `AppIconTabdoc`。
enum AppIconResolver {
    /// 已编入 Asset Catalog 的 builtin app（来自 `packages/apps/*/assets/icon.svg`）。
    static let bundledAssetAppIds: [String] = [
        "tabcode",
        "terminal",
        "tabwhiteboard",
        "tabweb",
        "tabtracker",
        "tabslide",
        "tabmemo",
        "tabfolder",
        "tabdoc",
        "tabdata",
        // 产品入口「云盘」：资产来自 app-shell `cloud-resources.svg`，挂在 tabfiles 上。
        "tabfiles",
    ]

    static func assetName(for appId: String) -> String {
        let trimmed = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "AppIcon" }
        return "AppIcon" + String(first).uppercased() + trimmed.dropFirst()
    }

    /// 资产存在时返回 asset 名，否则 nil。
    static func resolveAssetName(appId: String) -> String? {
        let name = assetName(for: appId)
        return UIImage(named: name) != nil ? name : nil
    }

    /// 优先品牌资产，否则 SF Symbol fallback。
    static func resolve(appId: String, manifestIcon: String) -> AppIconReference {
        if let asset = resolveAssetName(appId: appId) {
            return .asset(asset)
        }
        return .system(systemImageFallback(manifestIcon: manifestIcon, appId: appId))
    }

    /// 资源列表使用的去外框内容图标；与完整 App icon 分开，避免在浅色底座里重复套框。
    static func resolveContentGlyph(appId: String, manifestIcon: String) -> AppIconReference {
        let normalized = appId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        switch normalized {
        case "tabdoc":
            return .asset("AppGlyphTabdoc")
        case "tabdata":
            return .asset("AppGlyphTabdata")
        case "tabweb":
            return .asset("AppGlyphTabweb")
        default:
            break
        }
        return resolve(appId: normalized, manifestIcon: manifestIcon)
    }

    static func systemImageFallback(manifestIcon: String, appId: String) -> String {
        switch manifestIcon.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "activity": return "waveform.path.ecg"
        case "bot": return "cpu"
        case "code": return "chevron.left.forwardslash.chevron.right"
        case "file", "file-text": return "doc.text"
        case "folder-tree": return "folder.badge.gearshape"
        case "globe", "globe-2": return "safari"
        case "lightbulb": return "lightbulb"
        case "mail": return "envelope"
        case "palette": return "paintpalette"
        case "presentation": return "rectangle.on.rectangle"
        case "route": return "point.topleft.down.to.point.bottomright.curvepath"
        case "sticky-note": return "note.text"
        case "table": return "tablecells"
        case "terminal": return "terminal"
        case "video": return "video"
        case "smartphone": return "iphone"
        case "monitor": return "desktopcomputer"
        default:
            switch appId {
            case "tabdesktop": return "desktopcomputer"
            case "tabphone": return "iphone"
            case "tabvideo": return "video"
            case "tabmail": return "envelope"
            case "tabinbox": return "tray.full"
            case "tabsite": return "globe"
            case "tabfiles": return "folder"
            case "orchestration": return "cpu"
            default:
                return "square.grid.2x2"
            }
        }
    }
}

enum AppIconReference: Hashable, Sendable {
    case asset(String)
    case system(String)

    var systemImageName: String? {
        if case .system(let name) = self { return name }
        return nil
    }

    var assetName: String? {
        if case .asset(let name) = self { return name }
        return nil
    }
}

/// 工作台 / 资源列表用的 App 图标视图（彩色 selfContained 资产，非 template）。
struct AppIconImage: View {
    let reference: AppIconReference
    var size: CGFloat = 24

    init(appId: String, manifestIcon: String, size: CGFloat = 24) {
        self.reference = AppIconResolver.resolve(appId: appId, manifestIcon: manifestIcon)
        self.size = size
    }

    init(reference: AppIconReference, size: CGFloat = 24) {
        self.reference = reference
        self.size = size
    }

    var body: some View {
        switch reference {
        case .asset(let name):
            Image(name)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        case .system(let name):
            Image(systemName: name)
                .font(.system(size: size * 0.72, weight: .medium))
                .foregroundStyle(Color.tt.iconAccent)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}
