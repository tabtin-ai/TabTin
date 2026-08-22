import Foundation

/// 市场筛选纯函数：对齐 Electron
/// - `apps/tabtin-electron/.../capability-marketplace/skillMarketTaxonomy.ts`
/// - `apps/tabtin-electron/.../skills/skillSourceGroups.ts`
/// - SkillPanel marketplaceMode：`builtin`→推荐 / `organization`→组织精选 / `mine`→我的

// MARK: - Market tabs（对齐 CapabilityMarketplacePage）

enum CapabilityMarketTab: String, CaseIterable, Identifiable, Sendable {
    case skills
    case connectors

    var id: String { rawValue }

    var title: String {
        switch self {
        case .skills: return "技能"
        case .connectors: return "连接器"
        }
    }
}

// MARK: - Chips

enum SkillMarketSourceChip: String, CaseIterable, Identifiable, Sendable {
    case recommended
    case organization
    case mine

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recommended: return "推荐"
        case .organization: return "组织精选"
        case .mine: return "我的"
        }
    }
}

/// 能力市场三个来源的共同语义。连接器与技能各自持有选择和搜索状态，
/// 只共享来源词汇，不共享页面状态。
enum ConnectorMarketSource: String, CaseIterable, Identifiable, Sendable {
    case recommended
    case organization
    case mine

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recommended: return L10n.CapabilityMarket.sourceRecommended
        case .organization: return L10n.CapabilityMarket.sourceOrganization
        case .mine: return L10n.CapabilityMarket.sourceMine
        }
    }
}

enum SkillMarketCategoryChip: String, CaseIterable, Identifiable, Sendable {
    case all
    case writing
    case collab
    case data
    case research
    case creative
    case engineering

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "全部"
        case .writing: return "文档写作"
        case .collab: return "协作效率"
        case .data: return "数据处理"
        case .research: return "研究分析"
        case .creative: return "创意设计"
        case .engineering: return "工程开发"
        }
    }

    /// Electron `SKILL_MARKET_CATEGORY_ORDER`（不含 all）
    static var categoryOrder: [SkillMarketCategoryChip] {
        [.writing, .collab, .data, .research, .creative, .engineering]
    }
}

// MARK: - Filter input

/// 筛选所需字段子集；与列表模型解耦，便于单测。
struct SkillMarketFilterInput: Equatable, Sendable {
    var source: String
    var visibility: String
    var appId: String?
    var distribution: String?
    var category: String?
    var ownerUserId: String?
    var organizationId: String?
    var acquired: Bool
}

enum SkillMarketFilters {
    /// Electron `RECOMMENDED_MARKET_PACK_IDS`
    static let recommendedMarketPackIds: Set<String> = [
        "tabtin-writing-tools-pack",
        "tabtin-collab-efficiency-pack",
        "tabtin-data-toolkit-pack",
        "tabtin-business-analysis-pack",
        "tabtin-creative-toolkit-pack",
        "tabtin-dev-toolkit-pack",
    ]

    private static let categoryKeys: Set<String> = Set(
        SkillMarketCategoryChip.categoryOrder.map(\.rawValue)
    )

    // MARK: Taxonomy (skillMarketTaxonomy.ts)

    static func resolveSkillMarketCategory(_ category: String?) -> SkillMarketCategoryChip? {
        let normalized = category?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalized.isEmpty, categoryKeys.contains(normalized) else { return nil }
        return SkillMarketCategoryChip(rawValue: normalized)
    }

    static func isRecommendedMarketPackSkill(_ skill: SkillMarketFilterInput) -> Bool {
        let appId = skill.appId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !appId.isEmpty, recommendedMarketPackIds.contains(appId) else { return false }
        return skill.distribution == "marketplace"
    }

    // MARK: Source groups (skillSourceGroups.ts)

    static func normalizeSkillSource(_ source: String) -> String {
        let s = source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch s {
        case "platform", "app", "device", "user", "workspace":
            return s
        default:
            return "user"
        }
    }

    private static func normalizeUserId(_ userId: String?) -> String {
        (userId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isSkillOwnedByCurrentUser(_ skill: SkillMarketFilterInput, currentUserId: String) -> Bool {
        let ownerId = normalizeUserId(skill.ownerUserId)
        let viewerId = normalizeUserId(currentUserId)
        return !ownerId.isEmpty && !viewerId.isEmpty && ownerId == viewerId
    }

    /// Electron `isOrganizationSharedUserSkill`
    static func isOrganizationSharedUserSkill(
        _ skill: SkillMarketFilterInput,
        currentOrganizationId: String
    ) -> Bool {
        let skillOrganizationId = skill.organizationId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        let organizationId = currentOrganizationId
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalizeSkillSource(skill.source) == "user"
            && skill.visibility == "organization"
            && !organizationId.isEmpty
            && skillOrganizationId == organizationId
    }

    /// Electron `isMarketplaceMineSkill`
    static func isMarketplaceMineSkill(_ skill: SkillMarketFilterInput, currentUserId: String) -> Bool {
        if skill.acquired { return true }
        return normalizeSkillSource(skill.source) == "user"
            && isSkillOwnedByCurrentUser(skill, currentUserId: currentUserId)
    }

    /// Electron `isRecommendedMarketCatalogSkill`
    static func isRecommendedMarketCatalogSkill(
        _ skill: SkillMarketFilterInput,
        currentUserId: String
    ) -> Bool {
        if isMarketplaceMineSkill(skill, currentUserId: currentUserId) { return false }
        if normalizeSkillSource(skill.source) != "app" { return false }
        return isRecommendedMarketPackSkill(skill)
    }

    /// SkillPanel marketplaceMode 顶层来源 chip。
    static func matchesMarketplaceSourceFilter(
        _ skill: SkillMarketFilterInput,
        filter: SkillMarketSourceChip,
        currentUserId: String,
        currentOrganizationId: String
    ) -> Bool {
        switch filter {
        case .recommended:
            return isRecommendedMarketCatalogSkill(skill, currentUserId: currentUserId)
        case .organization:
            return isOrganizationSharedUserSkill(
                skill,
                currentOrganizationId: currentOrganizationId
            )
        case .mine:
            return isMarketplaceMineSkill(skill, currentUserId: currentUserId)
        }
    }

    static func matchesMarketplaceCategoryFilter(
        _ skill: SkillMarketFilterInput,
        filter: SkillMarketCategoryChip
    ) -> Bool {
        if filter == .all { return true }
        return resolveSkillMarketCategory(skill.category) == filter
    }

    /// 搜索只匹配当前列表卡片真实展示的文字，避免 canonical key / 原始 source
    /// 等内部字段造成用户无法解释的命中。
    static func matchesVisibleSearch(query: String, visibleFields: [String]) -> Bool {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return true }
        return visibleFields
            .joined(separator: " ")
            .localizedCaseInsensitiveContains(normalizedQuery)
    }

    /// Electron：`user_gates` 含该 key → acquired。
    static func isAcquired(canonicalKey: String, userGates: [String: Bool]) -> Bool {
        let key = canonicalKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return false }
        return userGates.keys.contains(key)
    }
}

struct MobileConnectorMarketItem: Identifiable, Equatable, Sendable {
    let id: String
    let catalogId: String?
    let name: String
    let description: String
    let transport: String
    let endpoint: String
    let deviceName: String?
    let source: ConnectorMarketSource
}

struct MobileConnectorDeviceBatch: Equatable, Sendable {
    let deviceId: String
    let deviceName: String
    let connections: [DeviceMcpConnection]
}

enum MobileConnectorMineReadFailure: Equatable, Sendable {
    case partial
    case all
}

/// 连接器货架投影。视图只传来源与搜索，设备身份、跨设备保留和可见字段
/// 搜索都收敛在此，避免 SwiftUI 分支各写一套规则。
enum MobileConnectorMarket {
    static func mineReadFailure(
        failedDeviceCount: Int,
        totalDeviceCount: Int
    ) -> MobileConnectorMineReadFailure? {
        guard failedDeviceCount > 0 else { return nil }
        return totalDeviceCount > 0 && failedDeviceCount == totalDeviceCount ? .all : .partial
    }

    static func visibleItems(
        source: ConnectorMarketSource,
        query: String,
        recommended: [MobileConnectorMarketItem],
        organization: [MobileConnectorMarketItem],
        mine: [MobileConnectorMarketItem]
    ) -> [MobileConnectorMarketItem] {
        let items: [MobileConnectorMarketItem]
        switch source {
        case .recommended: items = recommended
        case .organization: items = organization
        case .mine: items = mine
        }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return items }
        return items.filter { item in
            [item.name, item.description, item.transport, item.deviceName ?? ""]
                .joined(separator: " ")
                .localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    static func organizationItems(
        from connections: [OrgMcpConnection]
    ) -> [MobileConnectorMarketItem] {
        connections.map { connection in
            MobileConnectorMarketItem(
                id: "organization:\(connection.id)",
                catalogId: nil,
                name: connection.name.isEmpty ? connection.id : connection.name,
                description: connection.description,
                transport: connection.transport,
                endpoint: connection.endpoint,
                deviceName: nil,
                source: .organization
            )
        }
    }

    static func mineItems(
        from batches: [MobileConnectorDeviceBatch]
    ) -> [MobileConnectorMarketItem] {
        batches.flatMap { batch in
            batch.connections.map { connection in
                MobileConnectorMarketItem(
                    id: "mine:\(batch.deviceId):\(connection.id)",
                    catalogId: nil,
                    name: connection.name.isEmpty ? connection.id : connection.name,
                    description: connection.description,
                    transport: connection.transport,
                    endpoint: connection.endpoint,
                    deviceName: batch.deviceName,
                    source: .mine
                )
            }
        }
    }

    static func searchAfterSelecting(
        currentSource: ConnectorMarketSource,
        newSource: ConnectorMarketSource,
        currentQuery: String
    ) -> String {
        currentSource == newSource ? currentQuery : ""
    }
}

extension ConnectorMarketSource {
    var emptyTitle: String {
        switch self {
        case .recommended: return L10n.CapabilityMarket.recommendedEmpty
        case .organization: return L10n.CapabilityMarket.organizationEmpty
        case .mine: return L10n.CapabilityMarket.mineEmpty
        }
    }

    var emptyDescription: String {
        switch self {
        case .recommended: return L10n.CapabilityMarket.recommendedEmptyDescription
        case .organization: return L10n.CapabilityMarket.organizationEmptyDescription
        case .mine: return L10n.CapabilityMarket.mineEmptyDescription
        }
    }
}
