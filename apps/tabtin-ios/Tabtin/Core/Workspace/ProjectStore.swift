import Foundation
import os

private struct ProjectFetchResult<Value: Sendable>: Sendable {
    let value: Value?
    let error: String?

    static func success(_ value: Value) -> Self { Self(value: value, error: nil) }
    static func failure(_ error: Error) -> Self {
        Self(value: nil, error: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
    }
}

/// Project 列表与待处理邀请。Project 是云端协作面，不在这里创建或绑定移动端执行环境。
@MainActor @Observable
final class ProjectStore {
    static let shared = ProjectStore()

    private(set) var projects: [Project] = []
    private(set) var pendingInvitations: [PendingProjectInvitation] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var invitationLoadError: String?

    private var requestSeq = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ProjectStore")

    private init() {
        AuthService.shared.registerLogoutHook { [weak self] in self?.clearAll() }
    }

    var projectIds: Set<String> { Set(projects.map(\.id)) }

    func project(id: String) -> Project? { projects.first { $0.id == id } }

    func load(organizationId: String?) async {
        guard AuthService.shared.isAuthenticated, let organizationId else {
            clearAll()
            return
        }

        requestSeq += 1
        let seq = requestSeq
        isLoading = projects.isEmpty
        loadError = nil
        invitationLoadError = nil

        async let projectResult = Self.fetchProjects(organizationId: organizationId)
        async let invitationResult = Self.fetchPendingInvitations()
        let (loadedProjects, loadedInvitations) = await (projectResult, invitationResult)

        guard seq == requestSeq,
              WorkspaceStore.shared.selectedOrganizationId == organizationId,
              AuthService.shared.isAuthenticated else { return }

        if let value = loadedProjects.value {
            projects = value.sorted { ($0.lastActivityAt ?? $0.updatedAt ?? "") > ($1.lastActivityAt ?? $1.updatedAt ?? "") }
        } else {
            loadError = loadedProjects.error
            logger.warning("Project list failed: \(loadedProjects.error ?? "unknown")")
        }

        if let value = loadedInvitations.value {
            pendingInvitations = value.filter { $0.organizationId == organizationId }
        } else {
            invitationLoadError = loadedInvitations.error
            logger.warning("Project invitations failed: \(loadedInvitations.error ?? "unknown")")
        }
        isLoading = false
    }

    func clearForOrganizationSwitch() {
        projects = []
        pendingInvitations = []
        isLoading = false
        loadError = nil
        invitationLoadError = nil
        requestSeq += 1
    }

    func clearAll() { clearForOrganizationSwitch() }

    private nonisolated static func fetchProjects(
        organizationId: String
    ) async -> ProjectFetchResult<[Project]> {
        do {
            let response: ProjectListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.projects,
                query: ["organization_id": organizationId]
            )
            return .success(response.projects)
        } catch {
            return .failure(error)
        }
    }

    private nonisolated static func fetchPendingInvitations(
    ) async -> ProjectFetchResult<[PendingProjectInvitation]> {
        do {
            let response: PendingProjectInvitationListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.pendingProjectInvitations
            )
            return .success(response.invitations)
        } catch {
            return .failure(error)
        }
    }
}

/// Project 详情的可注入只读快照。
/// 正式页面默认从网络加载；视觉验收和单测可注入同一组生产模型，避免为了截图伪造登录态。
struct ProjectDetailSnapshot: Sendable {
    let discussions: [ProjectDiscussion]
    let assets: [SpaceResource]
    let activities: [ProjectActivityEvent]
    let participants: [ProjectParticipant]
}

/// 单个 Project 的只读协作数据源：详情、讨论频道、资产、动态和正式成员 / Agent。
@MainActor @Observable
final class ProjectDetailStore {
    private(set) var project: Project
    private(set) var discussions: [ProjectDiscussion] = []
    private(set) var assets: [SpaceResource] = []
    private(set) var activities: [ProjectActivityEvent] = []
    private(set) var participants: [ProjectParticipant] = []
    private(set) var isLoading = false
    private(set) var isUpdatingPrimaryAgent = false
    private(set) var loadError: String?
    /// 详情（getProject，my_workspace 的唯一来源）本身是否加载失败。
    /// 与 loadError 区分：其它分段失败不应把「执行环境」误判为「未准备」。
    private(set) var detailFailed = false

    private var requestSeq = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ProjectDetailStore")

    init(project: Project, snapshot: ProjectDetailSnapshot? = nil) {
        self.project = project
        if let snapshot {
            discussions = snapshot.discussions
            assets = snapshot.assets
            activities = snapshot.activities
            participants = snapshot.participants
        }
    }

    func reload() async {
        requestSeq += 1
        let seq = requestSeq
        isLoading = discussions.isEmpty && assets.isEmpty && activities.isEmpty && participants.isEmpty
        loadError = nil

        async let detailResult = Self.fetchProject(id: project.id)
        async let discussionResult = Self.fetchDiscussions(
            organizationId: project.organizationId,
            projectId: project.id
        )
        async let assetResult = Self.fetchAssets(projectId: project.id)
        async let activityResult = Self.fetchActivities(projectId: project.id)
        async let membershipResult = Self.fetchMemberships(projectId: project.id)
        async let organizationMemberResult = Self.fetchOrganizationMembers(
            organizationId: project.organizationId
        )

        let (detail, discussion, asset, activity, membership, organizationMember) = await (
            detailResult,
            discussionResult,
            assetResult,
            activityResult,
            membershipResult,
            organizationMemberResult
        )
        guard seq == requestSeq else { return }

        detailFailed = detail.value == nil
        if let value = detail.value { project = value }
        if let value = discussion.value { discussions = value }
        if let value = asset.value { assets = value }
        if let value = activity.value { activities = value }

        if let memberships = membership.value {
            let agentIds = Array(Set(memberships.compactMap(\.agentId))).sorted()
            let agents = await Self.fetchAgentSummaries(ids: agentIds)
            guard seq == requestSeq else { return }
            participants = Self.makeParticipants(
                memberships: memberships,
                organizationMembers: organizationMember.value ?? [],
                agentsById: agents,
                currentUserId: AuthService.shared.currentUser?.id
            )
        }

        let errors = [
            detail.error,
            discussion.error,
            asset.error,
            activity.error,
            membership.error,
            organizationMember.error,
        ].compactMap { $0 }
        loadError = errors.isEmpty ? nil : errors.joined(separator: "\n")
        if !errors.isEmpty {
            logger.warning("Project detail partially failed: \(errors.joined(separator: " | "))")
        }
        isLoading = false
    }

    func setPrimaryAgent(_ agentId: String) async {
        guard project.canManage == true, !isUpdatingPrimaryAgent else { return }
        isUpdatingPrimaryAgent = true
        defer { isUpdatingPrimaryAgent = false }
        do {
            let _: ProjectPrimaryAgentResponse = try await APIClient.shared.put(
                path: Endpoints.Context.projectPrimaryAgent(project.id),
                body: ["agent_id": agentId]
            )
            await reload()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private nonisolated static func fetchProject(id: String) async -> ProjectFetchResult<Project> {
        do {
            let value: Project = try await APIClient.shared.get(path: Endpoints.Context.project(id))
            return .success(value)
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchDiscussions(
        organizationId: String,
        projectId: String
    ) async -> ProjectFetchResult<[ProjectDiscussion]> {
        do {
            let value: [ProjectDiscussion] = try await APIClient.shared.get(
                path: Endpoints.IM.conversations,
                query: ["organization_id": organizationId]
            )
            let order = ["#general": 0, "#agent-updates": 1]
            let filtered = value
                .filter { $0.spaceId == projectId && $0.isTeamSpaceChannel && !$0.isArchived }
                .sorted {
                    let lhs = order[$0.name] ?? 100
                    let rhs = order[$1.name] ?? 100
                    return lhs == rhs ? $0.name < $1.name : lhs < rhs
                }
            return .success(filtered)
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchAssets(
        projectId: String
    ) async -> ProjectFetchResult<[SpaceResource]> {
        do {
            let response: SpaceResourceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.contextItems(spaceId: projectId),
                query: ["is_archived": "false", "page_size": "100"]
            )
            return .success(
                response.items
                    .filter(isProjectAsset)
                    .sorted { $0.sortTimestamp > $1.sortTimestamp }
            )
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchActivities(
        projectId: String
    ) async -> ProjectFetchResult<[ProjectActivityEvent]> {
        do {
            let response: ProjectActivityListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.spaceActivities(projectId),
                query: ["page": "1", "limit": "50"]
            )
            return .success(response.items)
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchMemberships(
        projectId: String
    ) async -> ProjectFetchResult<[ProjectMembership]> {
        do {
            let response: ProjectMembershipListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.spaceMemberships(projectId)
            )
            return .success(response.memberships.filter(\.isActive))
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchOrganizationMembers(
        organizationId: String
    ) async -> ProjectFetchResult<[OrganizationMember]> {
        do {
            let response: OrganizationMemberListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationMembers(organizationId)
            )
            return .success(response.members)
        } catch { return .failure(error) }
    }

    private nonisolated static func fetchAgentSummaries(ids: [String]) async -> [String: AgentSummary] {
        await withTaskGroup(of: AgentSummary?.self) { group in
            for id in ids {
                group.addTask {
                    try? await APIClient.shared.get(path: Endpoints.Agent.detail(id))
                }
            }
            var result: [String: AgentSummary] = [:]
            for await agent in group {
                if let agent { result[agent.id] = agent }
            }
            return result
        }
    }

    private nonisolated static func makeParticipants(
        memberships: [ProjectMembership],
        organizationMembers: [OrganizationMember],
        agentsById: [String: AgentSummary],
        currentUserId: String?
    ) -> [ProjectParticipant] {
        let membersByUserId = Dictionary(uniqueKeysWithValues: organizationMembers.map { ($0.userId, $0) })
        return memberships.compactMap { membership in
            if let userId = membership.userId {
                return ProjectParticipant(
                    id: membership.id,
                    name: membersByUserId[userId]?.displayName ?? userId,
                    kind: .member,
                    role: membership.role,
                    roleLabel: membership.roleLabel,
                    responsibility: membership.responsibility,
                    userId: userId,
                    agentId: nil,
                    ownedByCurrentUser: false,
                    isPrimary: membership.isPrimary == true
                )
            }
            if let agentId = membership.agentId {
                return ProjectParticipant(
                    id: membership.id,
                    name: agentsById[agentId]?.displayName ?? "Agent",
                    kind: .agent,
                    role: membership.role,
                    roleLabel: membership.roleLabel,
                    responsibility: membership.responsibility,
                    userId: nil,
                    agentId: agentId,
                    ownedByCurrentUser: {
                        guard let currentUserId,
                              let agent = agentsById[agentId] else { return false }
                        return agent.userId == currentUserId || agent.ownerUserId == currentUserId
                    }(),
                    isPrimary: membership.isPrimary == true
                )
            }
            return nil
        }
        .sorted {
            if $0.kind != $1.kind { return $0.kind == .member }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private nonisolated static func isProjectAsset(_ item: SpaceResource) -> Bool {
        guard item.isArchived != true else { return false }
        let assetKind = item.metadata?["asset_kind"]?.stringValue ?? ""
        if item.itemType == "ai_final_answer" || assetKind == "ai_final_answer" { return false }
        let source = item.metadata?["asset_source"]?.dictValue?["kind"] as? String ?? ""
        return item.normalizedType == "tabfiles"
            || (item.normalizedType == "tabdoc" && assetKind == "tabdoc")
            || !assetKind.isEmpty
            || source == "member_upload"
            || source == "ai_deliverable"
    }
}
