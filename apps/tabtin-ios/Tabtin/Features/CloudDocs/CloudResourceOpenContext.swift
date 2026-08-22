import Foundation

/// 打开一个云端资源所需的完整上下文。
///
/// 云文档一级入口的导航路由用它承载「打开哪个资源、在哪个组织 / Space 下打开」，
/// 由 `SpaceAppRouteScreen` 消费。独立成文件是因为它跨页面共用，不属于任何单一页面。
struct CloudResourceOpenContext: Identifiable, Hashable {
    let id: String
    let organizationId: String
    let spaceId: String?
    let spaceName: String?
    let route: SpaceAppRoute
}

/// 深链只允许打开当前组织的资源。资源属于另一个仍可访问的组织时，也不能替用户
/// 静默切换租户上下文；用户需要先明确切回该组织，再重新打开链接。
enum CloudResourceDeepLinkPolicy {
    enum Decision: Equatable {
        case open
        case wrongCurrentOrganization
        case organizationUnavailable
        case organizationListUnavailable
    }

    struct Snapshot {
        let currentOrganizationId: String?
        let availableOrganizationIds: Set<String>
        let hasAuthoritativeOrganizationList: Bool
    }

    static func decision(
        snapshot: Snapshot,
        targetOrganizationId: String,
        organizationLoadFailed: Bool = false
    ) -> Decision {
        guard snapshot.hasAuthoritativeOrganizationList, !organizationLoadFailed else {
            return .organizationListUnavailable
        }
        guard snapshot.availableOrganizationIds.contains(targetOrganizationId) else {
            return .organizationUnavailable
        }
        guard snapshot.currentOrganizationId == targetOrganizationId else {
            return .wrongCurrentOrganization
        }
        return .open
    }

    static func shouldRefreshOrganizations(
        snapshot: Snapshot,
        targetOrganizationId: String
    ) -> Bool {
        !snapshot.hasAuthoritativeOrganizationList
            || !snapshot.availableOrganizationIds.contains(targetOrganizationId)
    }

    static func consumesPendingResource(for decision: Decision) -> Bool {
        switch decision {
        case .wrongCurrentOrganization, .organizationUnavailable:
            return true
        case .open, .organizationListUnavailable:
            return false
        }
    }

    static func notice(for decision: Decision) -> String? {
        switch decision {
        case .open:
            return nil
        case .wrongCurrentOrganization:
            return L10n.Common.resourceLinkWrongCurrentOrganization
        case .organizationUnavailable:
            return L10n.Common.resourceLinkOrganizationUnavailable
        case .organizationListUnavailable:
            return L10n.Common.resourceLinkOrganizationLoadFailed
        }
    }
}

/// 把组织列表刷新、资源加载和加载后的租户二次校验收在同一编排点，避免任一入口
/// 在异步等待后直接写导航栈。临时加载失败保留 pending，用户重开同一链接即可重试。
@MainActor
enum CloudResourceDeepLinkCoordinator {
    static func open(
        targetOrganizationId: String,
        snapshot: () -> CloudResourceDeepLinkPolicy.Snapshot,
        refreshOrganizations: () async -> Bool,
        loadResources: () async -> Void,
        isCurrent: () -> Bool,
        consume: () -> Void,
        notify: (String) -> Void,
        openResource: () -> Void
    ) async {
        let initialSnapshot = snapshot()
        let needsOrganizationRefresh = CloudResourceDeepLinkPolicy.shouldRefreshOrganizations(
            snapshot: initialSnapshot,
            targetOrganizationId: targetOrganizationId
        )
        let organizationRefreshSucceeded = needsOrganizationRefresh
            ? await refreshOrganizations()
            : true
        guard !Task.isCancelled, isCurrent() else { return }

        let initialDecision = CloudResourceDeepLinkPolicy.decision(
            snapshot: snapshot(),
            targetOrganizationId: targetOrganizationId,
            organizationLoadFailed: !organizationRefreshSucceeded
        )
        guard proceed(
            after: initialDecision,
            consume: consume,
            notify: notify
        ) else { return }

        await loadResources()
        guard !Task.isCancelled, isCurrent() else { return }

        // 加载期间用户仍可能主动切换组织。这里到 `openResource()` 之间没有挂起点，
        // 因而二次判断一旦通过，写入的一定还是同一组织的导航上下文。
        let postLoadDecision = CloudResourceDeepLinkPolicy.decision(
            snapshot: snapshot(),
            targetOrganizationId: targetOrganizationId
        )
        guard proceed(
            after: postLoadDecision,
            consume: consume,
            notify: notify
        ) else { return }

        openResource()
    }

    private static func proceed(
        after decision: CloudResourceDeepLinkPolicy.Decision,
        consume: () -> Void,
        notify: (String) -> Void
    ) -> Bool {
        guard decision != .open else { return true }
        if CloudResourceDeepLinkPolicy.consumesPendingResource(for: decision) {
            consume()
        }
        if let notice = CloudResourceDeepLinkPolicy.notice(for: decision) {
            notify(notice)
        }
        return false
    }
}
