import XCTest
@testable import Tabtin

final class SkillMarketFiltersTests: XCTestCase {
    private let user = "user-1"

    private func skill(
        source: String = "app",
        visibility: String = "",
        appId: String? = nil,
        distribution: String? = nil,
        category: String? = nil,
        ownerUserId: String? = nil,
        organizationId: String? = nil,
        acquired: Bool = false
    ) -> SkillMarketFilterInput {
        SkillMarketFilterInput(
            source: source,
            visibility: visibility,
            appId: appId,
            distribution: distribution,
            category: category,
            ownerUserId: ownerUserId,
            organizationId: organizationId,
            acquired: acquired
        )
    }

    func testResolveSkillMarketCategory() {
        XCTAssertEqual(SkillMarketFilters.resolveSkillMarketCategory("writing"), .writing)
        XCTAssertEqual(SkillMarketFilters.resolveSkillMarketCategory(" Writing "), .writing)
        XCTAssertNil(SkillMarketFilters.resolveSkillMarketCategory("developer"))
        XCTAssertNil(SkillMarketFilters.resolveSkillMarketCategory(nil))
        XCTAssertNil(SkillMarketFilters.resolveSkillMarketCategory(""))
    }

    func testRecommendedPackIdsMatchElectron() {
        XCTAssertEqual(SkillMarketFilters.recommendedMarketPackIds.count, 6)
        XCTAssertTrue(SkillMarketFilters.recommendedMarketPackIds.contains("tabtin-writing-tools-pack"))
        XCTAssertFalse(SkillMarketFilters.recommendedMarketPackIds.contains("tabtin-office-skills-pack"))
    }

    func testIsRecommendedMarketCatalogSkill() {
        let zip = skill(
            appId: "tabtin-writing-tools-pack",
            distribution: "marketplace",
            category: "writing"
        )
        XCTAssertTrue(SkillMarketFilters.isRecommendedMarketCatalogSkill(zip, currentUserId: user))

        let acquired = skill(
            appId: "tabtin-writing-tools-pack",
            distribution: "marketplace",
            category: "writing",
            acquired: true
        )
        XCTAssertTrue(SkillMarketFilters.isMarketplaceMineSkill(acquired, currentUserId: user))
        XCTAssertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(acquired, currentUserId: user))

        let builtinApp = skill(appId: "tabdata", distribution: "builtin")
        XCTAssertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(builtinApp, currentUserId: user))

        let otherPack = skill(appId: "tabtin-office-skills-pack", distribution: "marketplace")
        XCTAssertFalse(SkillMarketFilters.isRecommendedMarketCatalogSkill(otherPack, currentUserId: user))
    }

    func testOrganizationAndMine() {
        let orgShared = skill(
            source: "user",
            visibility: "organization",
            ownerUserId: "other",
            organizationId: "org-a"
        )
        XCTAssertTrue(SkillMarketFilters.isOrganizationSharedUserSkill(
            orgShared,
            currentOrganizationId: "org-a"
        ))
        XCTAssertFalse(SkillMarketFilters.isOrganizationSharedUserSkill(
            orgShared,
            currentOrganizationId: "org-b"
        ))
        XCTAssertTrue(
            SkillMarketFilters.matchesMarketplaceSourceFilter(
                orgShared,
                filter: .organization,
                currentUserId: user,
                currentOrganizationId: "org-a"
            )
        )

        let minePrivate = skill(source: "user", visibility: "private", ownerUserId: user)
        XCTAssertTrue(SkillMarketFilters.isMarketplaceMineSkill(minePrivate, currentUserId: user))
        XCTAssertTrue(
            SkillMarketFilters.matchesMarketplaceSourceFilter(
                minePrivate,
                filter: .mine,
                currentUserId: user,
                currentOrganizationId: "org-a"
            )
        )
        // 我共享到组织：mine 与 organization 双出现
        let mineOrg = skill(
            source: "user",
            visibility: "organization",
            ownerUserId: user,
            organizationId: "org-a"
        )
        XCTAssertTrue(SkillMarketFilters.isMarketplaceMineSkill(mineOrg, currentUserId: user))
        XCTAssertTrue(SkillMarketFilters.isOrganizationSharedUserSkill(
            mineOrg,
            currentOrganizationId: "org-a"
        ))

        let installedOnly = skill(source: "platform", acquired: false)
        XCTAssertFalse(SkillMarketFilters.isMarketplaceMineSkill(installedOnly, currentUserId: user))
    }

    func testCategoryFilter() {
        let writing = skill(category: "writing")
        XCTAssertTrue(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, filter: .all))
        XCTAssertTrue(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, filter: .writing))
        XCTAssertFalse(SkillMarketFilters.matchesMarketplaceCategoryFilter(writing, filter: .data))
    }

    func testVisibleSearchMatchesOnlyCardText() {
        let visibleFields = ["文档润色", "改进中文表达", "平台技能", "1.2.0", "写作"]

        XCTAssertTrue(SkillMarketFilters.matchesVisibleSearch(
            query: " 中文 ",
            visibleFields: visibleFields
        ))
        XCTAssertTrue(SkillMarketFilters.matchesVisibleSearch(
            query: "平台",
            visibleFields: visibleFields
        ))
        XCTAssertTrue(SkillMarketFilters.matchesVisibleSearch(
            query: "   ",
            visibleFields: visibleFields
        ))
        XCTAssertFalse(SkillMarketFilters.matchesVisibleSearch(
            query: "app:tabtin-hidden",
            visibleFields: visibleFields
        ))
        XCTAssertFalse(SkillMarketFilters.matchesVisibleSearch(
            query: "app",
            visibleFields: visibleFields
        ))
    }

    func testAcquiredFromUserGates() {
        let gates = ["app:tabtin-writing-tools-pack/humanizer-zh": true]
        XCTAssertTrue(SkillMarketFilters.isAcquired(
            canonicalKey: "app:tabtin-writing-tools-pack/humanizer-zh",
            userGates: gates
        ))
        XCTAssertFalse(SkillMarketFilters.isAcquired(canonicalKey: "user:other", userGates: gates))
        XCTAssertFalse(SkillMarketFilters.isAcquired(canonicalKey: "", userGates: gates))
    }

    func testRecommendedConnectorCatalogUsesApprovedManifestEntriesInDesktopOrder() throws {
        let manifest = """
        {
          "brands": {
            "github": {"status":"approved","title":"GitHub","file":"github.svg","match":{}},
            "canva": {"status":"deferred","title":"Canva","file":null,"match":{}},
            "vercel": {"status":"approved","title":"Vercel","file":"vercel.svg","match":{}},
            "stripe": {"status":"approved","title":"Stripe","file":"stripe.svg","match":{}},
            "unknown": {"status":"approved","title":"Unknown","file":"unknown.svg","match":{}}
          }
        }
        """

        let entries = ConnectorBrandIconResolver.recommendedCatalog(
            manifestData: try XCTUnwrap(manifest.data(using: .utf8))
        )

        XCTAssertEqual(entries.map(\.id), ["vercel", "github", "stripe"])
        XCTAssertFalse(entries.contains { $0.id == "canva" })
        XCTAssertFalse(entries.contains { $0.id == "unknown" })
    }

    func testConnectorProjectionSearchesOnlyTheSelectedShelf() {
        let recommended = [
            MobileConnectorMarketItem(
                id: "recommended:github",
                catalogId: "github",
                name: "GitHub",
                description: "代码协作",
                transport: "",
                endpoint: "",
                deviceName: nil,
                source: .recommended
            ),
        ]
        let organization = [
            MobileConnectorMarketItem(
                id: "organization:notion",
                catalogId: nil,
                name: "Notion 团队知识库",
                description: "组织共享",
                transport: "http",
                endpoint: "https://mcp.notion.com/mcp",
                deviceName: nil,
                source: .organization
            ),
        ]

        XCTAssertEqual(
            MobileConnectorMarket.visibleItems(
                source: .recommended,
                query: "github",
                recommended: recommended,
                organization: organization,
                mine: []
            ).map(\.name),
            ["GitHub"]
        )
        XCTAssertTrue(MobileConnectorMarket.visibleItems(
            source: .organization,
            query: "github",
            recommended: recommended,
            organization: organization,
            mine: []
        ).isEmpty)
    }

    func testMineConnectorProjectionPreservesDeviceIdentity() {
        let connectionA = DeviceMcpConnection(
            id: "connection-a",
            name: "Local Tools",
            description: "",
            transport: "stdio",
            endpoint: "",
            enabled: true,
            deviceId: "device-a"
        )
        let connectionB = DeviceMcpConnection(
            id: "connection-b",
            name: "Local Tools",
            description: "",
            transport: "stdio",
            endpoint: "",
            enabled: true,
            deviceId: "device-b"
        )

        let items = MobileConnectorMarket.mineItems(from: [
            MobileConnectorDeviceBatch(
                deviceId: "device-a",
                deviceName: "MacBook Pro",
                connections: [connectionA]
            ),
            MobileConnectorDeviceBatch(
                deviceId: "device-b",
                deviceName: "Office Mac",
                connections: [connectionB]
            ),
        ])

        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(Set(items.map(\.deviceName)), ["MacBook Pro", "Office Mac"])
        XCTAssertEqual(Set(items.map(\.id)).count, 2)
    }

    func testChangingConnectorShelfClearsConnectorSearch() {
        XCTAssertEqual(
            MobileConnectorMarket.searchAfterSelecting(
                currentSource: .recommended,
                newSource: .organization,
                currentQuery: "GitHub"
            ),
            ""
        )
        XCTAssertEqual(
            MobileConnectorMarket.searchAfterSelecting(
                currentSource: .mine,
                newSource: .mine,
                currentQuery: "Local"
            ),
            "Local"
        )
    }

    func testMineConnectorReadFailureDistinguishesPartialAndTotalFailure() {
        XCTAssertNil(MobileConnectorMarket.mineReadFailure(
            failedDeviceCount: 0,
            totalDeviceCount: 2
        ))
        XCTAssertEqual(
            MobileConnectorMarket.mineReadFailure(
                failedDeviceCount: 1,
                totalDeviceCount: 2
            ),
            .partial
        )
        XCTAssertEqual(
            MobileConnectorMarket.mineReadFailure(
                failedDeviceCount: 2,
                totalDeviceCount: 2
            ),
            .all
        )
    }

    func testStableSkillCatalogProjectionKeepsOneItemPerCanonicalKey() {
        let entries = [
            (key: "user:owned", name: "我的技能"),
            (key: "user:owned", name: "我的技能副本"),
            (key: "", name: "无稳定标识"),
        ]

        let projected = StableSkillCatalogProjection.unique(entries) { $0.key }

        XCTAssertEqual(projected.map(\.name), ["我的技能"])
    }

    func testCapabilityMarketErrorPresentationHidesNetworkDetails() {
        let raw = URLError(
            .cannotFindHost,
            userInfo: [NSLocalizedDescriptionKey: "Unable to resolve host api-test.example.com"]
        )

        let message = CapabilityMarketErrorPresentation.message(
            for: APIError.networkError(raw),
            fallback: "技能库加载失败，请稍后重试。"
        )

        XCTAssertEqual(message, L10n.Messages.networkError)
        XCTAssertFalse(message.contains("api-test.example.com"))
    }

    func testCapabilityMarketErrorPresentationUsesProductFallbackForBusinessFailure() {
        let message = CapabilityMarketErrorPresentation.message(
            for: APIError.apiError("sensitive backend detail"),
            fallback: "连接器加载失败，请稍后重试。"
        )

        XCTAssertEqual(message, "连接器加载失败，请稍后重试。")
    }
}
