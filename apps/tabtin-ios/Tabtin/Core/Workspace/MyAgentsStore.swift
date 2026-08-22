import Foundation
import OSLog

/// 工作 Tab「AI分身」数据：`GET /agents?organization_id=`，对齐 Electron MyAgentsPanel。
@MainActor @Observable
final class MyAgentsStore {
    static let shared = MyAgentsStore()

    private(set) var agents: [OrganizationAgent] = []
    private(set) var deactivatedAgents: [DeactivatedOrganizationAgent] = []
    private(set) var templates: [AgentTemplateSummary] = []
    private(set) var isLoading = false
    private(set) var isLoadingTemplates = false
    private(set) var isMutating = false
    private(set) var loadError: String?
    private(set) var templateLoadError: String?
    private(set) var reactivatingAgentIds: Set<String> = []
    /// 当前内存缓存所属组织；对话页据此判断能否秒显，避免错组织串数据。
    private(set) var loadedOrganizationId: String?
    /// 该组织是否已完成至少一次 settled 拉取（含空列表成功）。
    private(set) var hasSettledLoad = false
    private var loadSeq = 0
    private var loadTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "MyAgentsStore")

    private init() {}

    /// 同组织已有 settled 缓存则直接返回；否则拉一次并等待完成。
    /// 对齐 ChatModelStore.ensureLoaded：进对话秒显，不每次都打 /agents。
    func ensureLoaded(organizationId: String?) async {
        guard AuthService.shared.isAuthenticated,
              let organizationId,
              !organizationId.isEmpty
        else {
            await load(organizationId: nil)
            return
        }
        if loadedOrganizationId == organizationId, hasSettledLoad {
            return
        }
        if let loadTask {
            await loadTask.value
            if loadedOrganizationId == organizationId, hasSettledLoad {
                return
            }
        }
        let task = Task { await load(organizationId: organizationId) }
        loadTask = task
        await task.value
        if loadTask == task {
            loadTask = nil
        }
    }

    func loadTemplates() async {
        guard !isLoadingTemplates else { return }
        isLoadingTemplates = true
        templateLoadError = nil
        defer { isLoadingTemplates = false }
        do {
            let response: AgentTemplateListResponse = try await APIClient.shared.get(
                path: Endpoints.Agent.templates
            )
            templates = response.templates
        } catch {
            logger.warning("load agent templates failed: \(error.localizedDescription)")
            templateLoadError = error.localizedDescription
        }
    }

    @discardableResult
    func create(
        organizationId: String,
        name: String,
        templateId: String?,
        avatarPreset: AgentAvatarPreset
    ) async throws -> OrganizationAgent {
        isMutating = true
        defer { isMutating = false }
        var body: [String: Any] = [
            "organization_id": organizationId,
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "type": "bot",
        ]
        if let templateId { body["template_id"] = templateId }
        body["avatar_key"] = avatarPreset.rawValue
        let created: OrganizationAgent = try await APIClient.shared.post(
            path: Endpoints.Agent.create,
            body: body
        )
        upsert(created)
        return created
    }

    @discardableResult
    func update(
        agentId: String,
        name: String,
        customRules: String,
        avatarPreset: AgentAvatarPreset
    ) async throws -> OrganizationAgent {
        isMutating = true
        defer { isMutating = false }
        let updated: OrganizationAgent = try await APIClient.shared.put(
            path: Endpoints.Agent.detail(agentId),
            body: [
                "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                "custom_rules": customRules.trimmingCharacters(in: .whitespacesAndNewlines),
                "avatar_key": avatarPreset.rawValue,
            ]
        )
        upsert(updated)
        return updated
    }

    func deactivate(agentId: String) async throws {
        isMutating = true
        defer { isMutating = false }
        let deactivated = agents.first(where: { $0.id == agentId }).map(DeactivatedOrganizationAgent.init(agent:))
        let _: ApiEnvelope<String?> = try await APIClient.shared.delete(
            path: Endpoints.Agent.detail(agentId)
        )
        agents.removeAll { $0.id == agentId }
        if let deactivated {
            deactivatedAgents.removeAll { $0.id == agentId }
            deactivatedAgents.insert(deactivated, at: 0)
        }
    }

    func permanentlyDelete(agentId: String) async throws {
        isMutating = true
        defer { isMutating = false }
        let _: ApiEnvelope<String?> = try await APIClient.shared.delete(
            path: Endpoints.Agent.permanent(agentId)
        )
        deactivatedAgents.removeAll { $0.id == agentId }
    }

    @discardableResult
    func reactivate(agentId: String) async throws -> OrganizationAgent {
        guard reactivatingAgentIds.insert(agentId).inserted else {
            throw APIError.apiError(L10n.Project.myAgentsAlreadyReactivating)
        }
        defer { reactivatingAgentIds.remove(agentId) }
        let reactivated: OrganizationAgent = try await APIClient.shared.post(
            path: Endpoints.Agent.reactivate(agentId),
            body: [:]
        )
        deactivatedAgents.removeAll { $0.id == reactivated.id }
        upsert(reactivated)
        return reactivated
    }

    func load(organizationId: String?) async {
        loadSeq += 1
        let seq = loadSeq
        guard AuthService.shared.isAuthenticated, let organizationId, !organizationId.isEmpty else {
            if seq == loadSeq {
                agents = []
                deactivatedAgents = []
                loadError = nil
                isLoading = false
                loadedOrganizationId = nil
                hasSettledLoad = false
            }
            return
        }

        // Store 为跨页面单例。组织切换时不能短暂复用上一组织的 Agent，
        // 否则 Project 任务可能把不属于当前租户的 agent_id 传给后端。
        if loadedOrganizationId != organizationId {
            loadedOrganizationId = organizationId
            agents = []
            deactivatedAgents = []
            loadError = nil
            hasSettledLoad = false
        }
        isLoading = agents.isEmpty
        loadError = nil
        defer {
            if seq == loadSeq {
                isLoading = false
            }
        }

        do {
            async let deactivatedRequest: DeactivatedOrganizationAgentListResponse = APIClient.shared.get(
                path: Endpoints.Agent.deactivated(organizationId: organizationId)
            )
            let response: OrganizationAgentListResponse = try await APIClient.shared.get(
                path: Endpoints.Agent.list,
                query: [
                    "organization_id": organizationId,
                    "page_size": "100",
                ]
            )
            let loadedDeactivated: [DeactivatedOrganizationAgent]?
            do {
                let deactivatedResponse = try await deactivatedRequest
                loadedDeactivated = deactivatedResponse.items.sorted {
                    ($0.deactivatedAt ?? $0.createdAt ?? "") > ($1.deactivatedAt ?? $1.createdAt ?? "")
                }
            } catch {
                // 辅助列表不应因为老服务端不支持接口而阻断活跃 AI分身主列表。
                logger.warning("load deactivated AI avatars failed: \(error.localizedDescription)")
                loadedDeactivated = nil
            }
            guard seq == loadSeq else { return }
            agents = response.agents
                .filter { $0.isActive != false }
                .sorted {
                    let lhs = $0.updatedAt ?? $0.createdAt ?? ""
                    let rhs = $1.updatedAt ?? $1.createdAt ?? ""
                    return lhs > rhs
                }
            if let loadedDeactivated {
                deactivatedAgents = loadedDeactivated
            }
            loadError = nil
            hasSettledLoad = true
        } catch {
            guard seq == loadSeq else { return }
            logger.warning("load AI avatars failed: \(error.localizedDescription)")
            loadError = error.localizedDescription
            if agents.isEmpty {
                agents = []
            }
            // 有旧缓存时失败仍算「已 settled」，避免每次进对话都因瞬时错误重打接口。
            if !agents.isEmpty || !deactivatedAgents.isEmpty {
                hasSettledLoad = true
            }
        }
    }

    private func upsert(_ agent: OrganizationAgent) {
        deactivatedAgents.removeAll { $0.id == agent.id }
        if let index = agents.firstIndex(where: { $0.id == agent.id }) {
            agents[index] = agent
        } else {
            agents.insert(agent, at: 0)
        }
        agents.sort {
            ($0.updatedAt ?? $0.createdAt ?? "") > ($1.updatedAt ?? $1.createdAt ?? "")
        }
    }
}
