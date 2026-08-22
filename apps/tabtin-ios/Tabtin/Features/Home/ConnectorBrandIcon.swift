import SwiftUI
import UIKit

/// 连接器品牌标：匹配规则来自 `@tabtin/connector-brand-icons` 的 manifest（打包进 Bundle）。
/// 新增品牌只改 packages 侧并同步资源，不要在市场行硬编码 slug。
enum ConnectorBrandIconResolver {
    struct RecommendedCatalogEntry: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let descriptionKey: String
    }

    struct Query: Equatable {
        var brandKey: String? = nil
        var catalogId: String? = nil
        var name: String? = nil
        var endpointUrl: String? = nil
    }

    struct Result: Equatable {
        let brandKey: String
        let assetName: String
    }

    private struct Manifest: Decodable {
        let brands: [String: Brand]
    }

    private struct Brand: Decodable {
        let status: String
        let title: String?
        let file: String?
        let match: Match
    }

    private struct Match: Decodable {
        let ids: [String]?
        let hosts: [String]?
        let names: [String]?
        let npm: [String]?
    }

    private static let manifest: Manifest? = {
        guard let url = Bundle.main.url(forResource: "connector-brand-manifest", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(Manifest.self, from: data)
        else { return nil }
        return decoded
    }()

    /// Electron `RECOMMENDED_CONNECTOR_CATALOG` 的移动展示顺序。实际是否上架仍由
    /// 同源品牌 manifest 的 `approved` + 可用资源共同裁决，`deferred` 不出现。
    private static let recommendedCatalogOrder = [
        "vercel", "github", "stripe", "notion", "canva", "supabase", "neon",
        "cloudflare", "tianyancha", "hithink-a-share", "dingtalk",
    ]
    private static let recommendedDescriptionKeys = [
        "vercel": "vercel",
        "github": "github",
        "stripe": "stripe",
        "notion": "notion",
        "canva": "canva",
        "supabase": "supabase",
        "neon": "neon",
        "cloudflare": "cloudflare",
        "tianyancha": "tianyancha",
        "hithink-a-share": "hithinkAShare",
        "dingtalk": "dingtalk",
    ]

    static func recommendedCatalog() -> [RecommendedCatalogEntry] {
        guard let url = Bundle.main.url(
            forResource: "connector-brand-manifest",
            withExtension: "json"
        ), let data = try? Data(contentsOf: url) else { return [] }
        return recommendedCatalog(manifestData: data)
    }

    static func recommendedCatalog(manifestData: Data) -> [RecommendedCatalogEntry] {
        guard let decoded = try? JSONDecoder().decode(Manifest.self, from: manifestData) else {
            return []
        }
        return recommendedCatalogOrder.compactMap { id in
            guard let brand = decoded.brands[id], isApproved(brand) else { return nil }
            let title = brand.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            return RecommendedCatalogEntry(
                id: id,
                title: title?.isEmpty == false ? title! : id,
                descriptionKey: recommendedDescriptionKeys[id] ?? id
            )
        }
    }

    static func resolve(_ query: Query) -> Result? {
        guard let manifest else { return nil }
        let brands = manifest.brands

        if let key = normalize(query.brandKey), let brand = brands[key], isApproved(brand) {
            return Result(brandKey: key, assetName: assetName(for: key))
        }

        if let catalogId = normalize(query.catalogId) {
            for (key, brand) in brands where isApproved(brand) {
                if (brand.match.ids ?? []).compactMap(normalize).contains(catalogId) {
                    return Result(brandKey: key, assetName: assetName(for: key))
                }
            }
        }

        if let host = host(from: query.endpointUrl) {
            for (key, brand) in brands where isApproved(brand) {
                if (brand.match.hosts ?? []).contains(where: { hostMatches(host, pattern: $0) }) {
                    return Result(brandKey: key, assetName: assetName(for: key))
                }
            }
        }

        if let name = normalize(query.name) {
            for (key, brand) in brands where isApproved(brand) {
                let names = (brand.match.names ?? []).compactMap(normalize)
                if names.contains(where: {
                    name == $0
                        || name.hasPrefix("\($0) ")
                        || name.hasPrefix("\($0)·")
                        || name.hasPrefix("\($0)-")
                }) {
                    return Result(brandKey: key, assetName: assetName(for: key))
                }
            }
        }

        return nil
    }

    private static func isApproved(_ brand: Brand) -> Bool {
        brand.status == "approved" && !(brand.file ?? "").isEmpty
    }

    private static func assetName(for brandKey: String) -> String {
        let parts = brandKey.split(separator: "-").map { part -> String in
            guard let first = part.first else { return "" }
            return String(first).uppercased() + part.dropFirst()
        }
        return "ConnectorBrand" + parts.joined()
    }

    private static func normalize(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func host(from value: String?) -> String? {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let withScheme = raw.contains("://") ? raw : "https://\(raw)"
        return URL(string: withScheme)?.host?.lowercased()
    }

    private static func hostMatches(_ host: String, pattern: String) -> Bool {
        let p = pattern.lowercased()
        return host == p || host.hasSuffix(".\(p)")
    }
}

struct ConnectorBrandGlyphView: View {
    let query: ConnectorBrandIconResolver.Query
    var size: CGFloat = 30
    var cornerRadius: CGFloat = TTRadius.xs

    private var glyphSize: CGFloat { max(12, size * 0.55) }

    var body: some View {
        let resolved = ConnectorBrandIconResolver.resolve(query)
        let hasBrand = resolved.flatMap { UIImage(named: $0.assetName) } != nil
        Group {
            if let resolved, hasBrand {
                Image(resolved.assetName)
                    .resizable()
                    .scaledToFit()
                    .frame(width: glyphSize, height: glyphSize)
            } else {
                Image(CapabilityGlyphKind.connector.assetName)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: glyphSize, height: glyphSize)
                    .foregroundStyle(.tt.iconAccent)
            }
        }
        .frame(width: size, height: size)
        // 单层芯片：与 Plug 同底同圆角。
        .background(Color.tt.bgSubtle, in: RoundedRectangle(cornerRadius: cornerRadius))
        .accessibilityHidden(true)
    }
}
