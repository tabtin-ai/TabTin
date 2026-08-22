import Foundation
import os

struct OrganizationAccessRevokedNotice: Identifiable, Equatable {
    let id: String
    let organizationId: String
    let organizationName: String?
    let fallbackOrganization: Organization?
}

/// Organization + Space 列表状态。Phase 1 精简版「真单例」：
/// - 拉 organizations（自动选中：持久化 > 唯一 > 默认）；
/// - 拉选中 organization 的 spaces；
/// - 产出 RealtimeGateway 凭据并发起 WS 连接（登录态连通）。
///
/// 相比旧 OrganizationService/SpaceService 砍掉成员/邀请/设备注册/心跳/各 App 联动，
/// 那些随对应 Feature Phase 增量补回。logout 经 AuthService hook 清理。
@MainActor @Observable
final class WorkspaceStore {
    static let shared = WorkspaceStore()

    private(set) var organizations: [Organization] = []
    private(set) var selectedOrganization: Organization?
    private(set) var currentUserRole: OrganizationRole?
    private(set) var spaces: [Space] = []
    /// Space 只是工作现场；Agent 与 Device 作为独立对象按 ID 缓存，供卡片组合展示。
    private(set) var agentsById: [String: AgentSummary] = [:]
    private(set) var devicesById: [String: RuntimeDevice] = [:]
    private(set) var members: [OrganizationMember] = []
    private(set) var isLoadingOrganizations = false
    /// 与 `organizations.isEmpty` 分离：空组织列表也可能是服务端权威成功结果。
    /// 深链只能在该标记为 true 后把目标组织缺失解释为“已不可用”。
    private(set) var hasLoadedOrganizations = false
    private(set) var isLoadingSpaces = false
    private(set) var isLoadingSpaceMetadata = false
    private(set) var isLoadingMembers = false
    private(set) var isMutating = false
    /// 首次 organization 加载是否已「尝试过」（成功或失败都算）。
    /// RootView 用它决定何时从「加载中」切到主界面：只在首次加载完成前显示加载页，
    /// 之后恒挂 MainTabView（空/错误态由各 tab 自行展示），避免加载标志反复翻转导致主界面重挂闪烁。
    private(set) var didAttemptOrganizationLoad = false
    var errorMessage: String?
    private(set) var organizationAccessRevokedNotice: OrganizationAccessRevokedNotice?
    /// Agent/Space 列表专属错误，避免成员、邀请等共享操作错误污染 Agent 空态。
    private(set) var spacesLoadError: String?

    /// Organization 是登录后全局基础数据，加载任务由 Store 持有，不能绑定到某一个
    /// `.task` / `.refreshable` 宿主。多个调用者共同等待同一任务；页面消失不会取消
    /// 共享请求，登出才会由 clearAll() 显式取消。
    private var organizationsLoadTask: Task<Bool, Never>?
    /// Workspace 列表同样是 Organization 级共享基础数据。多个常驻 Tab 会同时响应
    /// Organization 切换；同一 Organization 的调用必须共同等待一条 Store 持有的请求，
    /// 不能让最后发出的重复请求决定前面成功结果是否可见。
    private var spacesLoadTask: Task<Void, Never>?
    private var spacesLoadOrganizationId: String?
    /// 最近一次成功取得权威 Workspace 列表的 Organization。
    /// 空数组同样是有效结果，不能再用 `spaces.isEmpty` 区分“尚未加载”和“确实为空”。
    private(set) var spacesLoadedOrganizationId: String?
    /// 登出代次 + 请求序号共同阻止旧账号/旧任务的迟到响应回填新会话。
    private var lifecycleGeneration = 0
    private var organizationsRequestSeq = 0
    /// loadSpaces「最新者胜」序号：切团队/并发刷新时丢弃过期响应，避免列表抖动。
    private var spacesRequestSeq = 0
    private var spaceMetadataRequestSeq = 0
    private var membersRequestSeq = 0

    /// mobile WS 能力白名单（D5：聊天/观测，不含 device.* / agent.action.*）。
    /// 必须是服务端 ROLE_CAPABILITY_WHITELIST['mobile'] 子集。
    private let realtimeCapabilities = ["agent.stream", "billing.events", "tracker.events", "table.events"]
    private static let selectedKey = "tabtin_selected_organization_id"
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "WorkspaceStore")

    var selectedOrganizationId: String? { selectedOrganization?.id }
    var hasLoadedSpacesForSelectedOrganization: Bool {
        guard let selectedOrganizationId else { return false }
        return spacesLoadedOrganizationId == selectedOrganizationId
    }

    /// 侧栏组织切换 readiness：以 Store 可观察状态为准，不用 `selectedOrganizationId` 单独冒充成功。
    func organizationContextReadiness(for organizationId: String) -> OrganizationContextReadiness {
        guard AuthService.shared.isAuthenticated else {
            return .failed(message: L10n.AccountDrawer.organizationSwitchFailed)
        }
        guard selectedOrganizationId == organizationId else {
            return .failed(message: L10n.AccountDrawer.organizationSwitchFailed)
        }
        if isLoadingSpaces || isLoadingMembers {
            return .loading
        }
        if let spacesLoadError {
            return .failed(message: spacesLoadError)
        }
        if !hasLoadedSpacesForSelectedOrganization {
            return .failed(message: L10n.AccountDrawer.organizationScopeUnavailable)
        }
        if currentUserRole == nil {
            return .failed(message: L10n.AccountDrawer.organizationRoleUnavailable)
        }
        return .ready
    }

    /// 在已选中组织下补齐 role + workspace scope（切换失败重试 / 同组织确认）。
    func reloadSelectedOrganizationContext() async {
        guard let organizationId = selectedOrganizationId else { return }
        await resolveCurrentRole(organizationId: organizationId)
        guard selectedOrganizationId == organizationId else { return }
        if !hasLoadedSpacesForSelectedOrganization || spacesLoadError != nil {
            await loadSpaces()
        }
    }

    /// 组织准入天花板：当前组织是否允许成员使用 YOLO / 宽松审批档。
    /// 前端据此在 Composer / 安全页对 YOLO 做置灰 gate；后端仍是最终裁决方。
    var allowMemberYolo: Bool { selectedOrganization?.settings?.allowMemberYolo == true }
    var canManage: Bool { currentUserRole?.canManage ?? false }
    var canEdit: Bool { currentUserRole?.canEdit ?? false }
    var isOwner: Bool { currentUserRole?.isOwner ?? false }

    private init() {
        // 登出即清数据 + 断 WS：连接生命周期跟登录态走，不跟单个会话页走。
        AuthService.shared.registerLogoutHook { [weak self] in
            self?.clearAll()
            RealtimeGateway.shared.disconnect()
            // 登出清空本地消息缓存（含他人会话历史），与连接生命周期一致跟登录态走。
            MessageCacheStore.shared.clearAll()
            // 同样清空会话列表缓存（最近 + 各 Space），避免跨账号串数据。
            SessionListCacheStore.shared.clearAll()
        }
    }

    // MARK: - Persistence

    private var persistedOrganizationId: String? {
        get { UserDefaults.standard.string(forKey: Self.selectedKey) }
        set {
            if let id = newValue { UserDefaults.standard.set(id, forKey: Self.selectedKey) }
            else { UserDefaults.standard.removeObject(forKey: Self.selectedKey) }
        }
    }

    // MARK: - Load

    /// 返回这一次共享组织请求是否取得了权威结果。调用者可以忽略返回值；需要区分
    /// “目标组织确实不存在”和“列表刷新暂时失败”的深链路径必须使用它，不能读取
    /// 会被其他 Workspace 请求覆盖的共享 `errorMessage`。
    @discardableResult
    func loadOrganizations() async -> Bool {
        guard AuthService.shared.isAuthenticated else { return false }

        if let task = organizationsLoadTask {
            return await task.value
        }

        organizationsRequestSeq += 1
        let generation = lifecycleGeneration
        let seq = organizationsRequestSeq
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            let succeeded = await self.performOrganizationsLoad(generation: generation, seq: seq)
            if self.lifecycleGeneration == generation,
               self.organizationsRequestSeq == seq {
                self.organizationsLoadTask = nil
            }
            return succeeded
        }
        organizationsLoadTask = task
        return await task.value
    }

    private func performOrganizationsLoad(generation: Int, seq: Int) async -> Bool {
        guard isCurrentOrganizationsLoad(generation: generation, seq: seq) else { return false }

        isLoadingOrganizations = organizations.isEmpty
        errorMessage = nil
        defer {
            if isCurrentOrganizationsLoad(generation: generation, seq: seq) {
                isLoadingOrganizations = false
                didAttemptOrganizationLoad = true
            }
        }

        do {
            let data: OrganizationListResponse = try await APIClient.shared.get(path: Endpoints.Context.organizations)
            guard isCurrentOrganizationsLoad(generation: generation, seq: seq),
                  !Task.isCancelled else { return false }

            let previousOrganization = selectedOrganization
            organizations = data.organizations
            hasLoadedOrganizations = true
            if let previousOrganization,
               !data.organizations.contains(where: { $0.id == previousOrganization.id }) {
                markOrganizationAccessRevoked(
                    organizationId: previousOrganization.id,
                    organizationName: previousOrganization.name,
                    availableOrganizations: data.organizations
                )
                logger.info("Current organization access revoked id=\(previousOrganization.id, privacy: .public)")
                return true
            }
            if previousOrganization == nil,
               let persistedOrganizationId,
               !data.organizations.contains(where: { $0.id == persistedOrganizationId }) {
                markOrganizationAccessRevoked(
                    organizationId: persistedOrganizationId,
                    availableOrganizations: data.organizations
                )
                logger.info("Persisted organization access revoked id=\(persistedOrganizationId, privacy: .public)")
                return true
            }
            if selectedOrganization == nil {
                let auto = data.organizations.first(where: { $0.id == persistedOrganizationId })
                    ?? (data.organizations.count == 1 ? data.organizations.first : nil)
                    ?? data.organizations.first(where: { $0.isDefault == true })
                if let auto { await selectOrganizationInternal(auto) }
            } else if let selected = selectedOrganization,
                      let updated = data.organizations.first(where: { $0.id == selected.id }) {
                selectedOrganization = updated
                resolveCurrentRoleFromLoadedMembers(organizationId: updated.id)
            }
            logger.info("Loaded \(data.organizations.count) organizations")
            return true
        } catch {
            guard isCurrentOrganizationsLoad(generation: generation, seq: seq) else { return false }
            if error.isCancellation || Task.isCancelled { return false }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("loadOrganizations failed: \(error.localizedDescription)")
            return false
        }
    }

    private func isCurrentOrganizationsLoad(generation: Int, seq: Int) -> Bool {
        lifecycleGeneration == generation
            && organizationsRequestSeq == seq
            && AuthService.shared.isAuthenticated
    }

    func selectOrganization(_ organization: Organization) async {
        // 深链或旧页面可能持有已失效的组织快照。先刷新成员范围，避免把被移出的组织
        // 写入当前上下文后再由 IM bootstrap 的 401 误触发整账号登出。
        let loaded = await loadOrganizations()
        guard loaded,
              let current = organizations.first(where: { $0.id == organization.id }) else {
            if loaded {
                notifyOrganizationAccessRevoked(
                    organizationId: organization.id,
                    organizationName: organization.name
                )
            }
            return
        }
        await selectOrganizationInternal(current)
    }

    private func selectOrganizationInternal(_ organization: Organization) async {
        if organization.id == selectedOrganization?.id {
            if !hasLoadedSpacesForSelectedOrganization {
                await loadSpaces()
            }
            return
        }
        cancelSpacesLoad()
        // 切换团队：先断旧连接，下面用新团队凭据重连（凭据含 organizationId）。
        let isSwitching = selectedOrganization != nil && selectedOrganization?.id != organization.id
        selectedOrganization = organization
        persistedOrganizationId = organization.id
        spaces = []
        spacesLoadedOrganizationId = nil
        // Organization 已切换、Workspace 尚未回填的窗口必须保持 loading。
        // 否则常驻的 Automation / Apps 根会把“等待 role + scope 初始化”误判为空态。
        isLoadingSpaces = true
        agentsById = [:]
        devicesById = [:]
        members = []
        currentUserRole = nil
        spacesLoadError = nil
        spacesRequestSeq += 1
        spaceMetadataRequestSeq += 1
        membersRequestSeq += 1
        if isSwitching {
            RealtimeGateway.shared.disconnect()
            ChatModelStore.shared.clearForOrganizationSwitch()
        }
        await resolveCurrentRole(organizationId: organization.id)
        guard !Task.isCancelled,
              AuthService.shared.isAuthenticated,
              selectedOrganization?.id == organization.id else { return }
        // 其他常驻根可能已在 role 请求期间加入共享 Workspace 加载；
        // 成功结果已经存在时不再紧接着发第二次相同请求。
        if !hasLoadedSpacesForSelectedOrganization {
            await loadSpaces()
        }
        guard !Task.isCancelled,
              AuthService.shared.isAuthenticated,
              selectedOrganization?.id == organization.id else { return }
        // 团队就绪即连通（登录态生命周期）。connect() 自身幂等：仅在断开态发起。
        connectRealtime()
        BillingEventHandler.shared.subscribeCurrentOrganization()
    }

    private func defaultOrganization(in organizations: [Organization]) -> Organization? {
        organizations.first(where: { $0.isDefault == true }) ?? organizations.first
    }

    private func invalidateSelectedOrganization() {
        cancelSpacesLoad()
        spacesRequestSeq += 1
        spaceMetadataRequestSeq += 1
        membersRequestSeq += 1
        selectedOrganization = nil
        persistedOrganizationId = nil
        spaces = []
        spacesLoadedOrganizationId = nil
        agentsById = [:]
        devicesById = [:]
        members = []
        currentUserRole = nil
        spacesLoadError = nil
        isLoadingSpaces = false
        RealtimeGateway.shared.disconnect()
    }

    private func markOrganizationAccessRevoked(
        organizationId: String,
        organizationName: String? = nil,
        availableOrganizations: [Organization]
    ) {
        if selectedOrganization?.id == organizationId || persistedOrganizationId == organizationId {
            invalidateSelectedOrganization()
        }
        organizations = availableOrganizations
        organizationAccessRevokedNotice = OrganizationAccessRevokedNotice(
            id: organizationId,
            organizationId: organizationId,
            organizationName: organizationName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? organizationName
                : nil,
            fallbackOrganization: defaultOrganization(in: availableOrganizations)
        )
    }

    /// 深链目标不在权威组织列表时调用，保持登录态并交给根视图展示移出提示。
    func notifyOrganizationAccessRevoked(organizationId: String, organizationName: String? = nil) {
        guard !organizationId.isEmpty else { return }
        markOrganizationAccessRevoked(
            organizationId: organizationId,
            organizationName: organizationName ?? organizations.first(where: { $0.id == organizationId })?.name,
            availableOrganizations: organizations
        )
    }

    @discardableResult
    func selectDefaultOrganization() async -> Bool {
        guard let fallback = organizationAccessRevokedNotice?.fallbackOrganization
            ?? defaultOrganization(in: organizations) else { return false }
        await selectOrganization(fallback)
        return selectedOrganizationId == fallback.id
    }

    func clearOrganizationAccessRevokedNotice() {
        organizationAccessRevokedNotice = nil
    }

    func loadSpaces() async {
        guard AuthService.shared.isAuthenticated, let organizationId = selectedOrganizationId else { return }

        if let task = spacesLoadTask,
           spacesLoadOrganizationId == organizationId {
            await task.value
            return
        }

        // 理论上跨 Organization 的任务已由 selectOrganization 取消；这里仍做防御，
        // 让任何未来直接改写选择态的调用也不能留下旧租户请求。
        cancelSpacesLoad()
        spacesRequestSeq += 1
        let seq = spacesRequestSeq
        let generation = lifecycleGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performSpacesLoad(
                organizationId: organizationId,
                generation: generation,
                seq: seq
            )
            if self.isCurrentSpacesLoad(
                organizationId: organizationId,
                generation: generation,
                seq: seq
            ) {
                self.spacesLoadTask = nil
                self.spacesLoadOrganizationId = nil
            }
        }
        spacesLoadOrganizationId = organizationId
        spacesLoadTask = task
        await task.value
    }

    private func performSpacesLoad(
        organizationId: String,
        generation: Int,
        seq: Int
    ) async {
        guard isCurrentSpacesLoad(
            organizationId: organizationId,
            generation: generation,
            seq: seq
        ) else { return }

        // 对深链解析而言，带缓存的刷新同样是“范围仍在确认”；如果目标 Workspace
        // 不在旧缓存中，必须等本次权威结果，不能提前判定它已被删除。
        isLoadingSpaces = true
        errorMessage = nil
        spacesLoadError = nil
        defer {
            if isCurrentSpacesLoad(
                organizationId: organizationId,
                generation: generation,
                seq: seq
            ) {
                isLoadingSpaces = false
            }
        }
        do {
            // ：`/context/spaces` 已退役（410 SPACE_RETIRED），个人执行现场走 workspaces。
            let data: WorkspaceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.workspaces,
                query: ["organization_id": organizationId]
            )
            // 过期响应（已被更新的请求取代，如切团队）直接丢弃，避免列表抖动。
            guard isCurrentSpacesLoad(
                organizationId: organizationId,
                generation: generation,
                seq: seq
            ) else { return }
            let loadedSpaces = data.workspaces.map { $0.asSpace() }
                .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
            spaces = loadedSpaces
            spacesLoadedOrganizationId = organizationId
            await loadSpaceMetadata(
                for: loadedSpaces,
                organizationId: organizationId,
                spacesSeq: seq
            )
        } catch {
            guard isCurrentSpacesLoad(
                organizationId: organizationId,
                generation: generation,
                seq: seq
            ) else { return }
            if !error.isCancellation {
                spacesLoadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                logger.error("loadSpaces failed: \(error.localizedDescription)")
            }
        }
    }

    private func isCurrentSpacesLoad(
        organizationId: String,
        generation: Int,
        seq: Int
    ) -> Bool {
        lifecycleGeneration == generation
            && spacesRequestSeq == seq
            && selectedOrganizationId == organizationId
            && spacesLoadOrganizationId == organizationId
            && AuthService.shared.isAuthenticated
    }

    private func cancelSpacesLoad() {
        spacesLoadTask?.cancel()
        spacesLoadTask = nil
        spacesLoadOrganizationId = nil
    }

    func agent(for space: Space) -> AgentSummary? {
        guard let id = space.primaryAgentId else { return nil }
        return agentsById[id]
    }

    func executionDevice(for space: Space) -> RuntimeDevice? {
        guard let id = space.executionDeviceId else { return nil }
        return devicesById[id]
    }

    /// Agent / Device 元信息是 Space 列表的增强信息。任一请求失败都只让对应行降级，
    /// 不覆盖已经成功加载的 Space 列表，也不把错误提升成页面级失败。
    private func loadSpaceMetadata(
        for loadedSpaces: [Space],
        organizationId: String,
        spacesSeq: Int
    ) async {
        spaceMetadataRequestSeq += 1
        let metadataSeq = spaceMetadataRequestSeq
        isLoadingSpaceMetadata = true
        defer {
            if metadataSeq == spaceMetadataRequestSeq {
                isLoadingSpaceMetadata = false
            }
        }

        let agentIds = Array(Set(loadedSpaces.compactMap(\.primaryAgentId))).sorted()
        async let loadedAgents = fetchAgentSummaries(ids: agentIds)
        async let loadedDevices = fetchRuntimeDevices(organizationId: organizationId)
        let (agentMap, deviceMap) = await (loadedAgents, loadedDevices)

        guard metadataSeq == spaceMetadataRequestSeq,
              spacesSeq == spacesRequestSeq,
              selectedOrganizationId == organizationId else { return }
        agentsById = agentMap
        devicesById = deviceMap
    }

    private func fetchAgentSummaries(ids: [String]) async -> [String: AgentSummary] {
        await withTaskGroup(of: AgentSummary?.self) { group in
            for id in ids {
                group.addTask {
                    do {
                        return try await APIClient.shared.get(path: Endpoints.Agent.detail(id))
                    } catch {
                        return nil
                    }
                }
            }

            var result: [String: AgentSummary] = [:]
            for await agent in group {
                if let agent { result[agent.id] = agent }
            }
            return result
        }
    }

    private func fetchRuntimeDevices(organizationId: String) async -> [String: RuntimeDevice] {
        do {
            let response: RuntimeDeviceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.devices,
                query: ["organization_id": organizationId]
            )
            return Dictionary(uniqueKeysWithValues: response.devices.map { ($0.id, $0) })
        } catch {
            logger.warning("load Space device metadata failed: \(error.localizedDescription)")
            return [:]
        }
    }

    @discardableResult
    func createOrganization(name: String, description: String? = nil, icon: String? = nil) async throws -> Organization {
        guard AuthService.shared.isAuthenticated else { throw APIError.unauthorized }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw APIError.apiError("组织名称不能为空") }

        let created: Organization = try await APIClient.shared.post(
            path: Endpoints.Context.organizations,
            body: Self.makeOrganizationBody(
                name: trimmed,
                description: description?.trimmingCharacters(in: .whitespacesAndNewlines),
                icon: icon?.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        )
        organizations.insert(created, at: 0)
        await selectOrganization(created)
        return created
    }

    @discardableResult
    func updateOrganization(
        id: String,
        name: String? = nil,
        description: String? = nil,
        icon: String? = nil
    ) async throws -> Organization {
        guard AuthService.shared.isAuthenticated else { throw APIError.unauthorized }
        let updated: Organization = try await APIClient.shared.put(
            path: Endpoints.Context.organization(id),
            body: Self.makeOrganizationUpdateBody(
                name: name,
                description: description,
                icon: icon
            )
        )
        if let idx = organizations.firstIndex(where: { $0.id == id }) {
            organizations[idx] = updated
        }
        if selectedOrganization?.id == id {
            selectedOrganization = updated
            await resolveCurrentRole(organizationId: id)
        }
        return updated
    }

    /// 更新团队工具开关。后端会整体替换 settings，因此必须携带当前已知字段，避免清空头像等配置。
    @discardableResult
    func updateOrganizationSettings(id: String, enableTools: Bool) async throws -> Organization {
        guard AuthService.shared.isAuthenticated else { throw APIError.unauthorized }
        var settings = organizationSettingsBody(id: id)
        settings["enable_tools"] = enableTools
        let updated: Organization = try await APIClient.shared.put(
            path: Endpoints.Context.organization(id),
            body: ["settings": settings]
        )
        applyUpdatedOrganization(updated)
        return updated
    }

    /// 更新组织头像。上传沿用 Electron 的公开 `tabtinspace/org-logos` 归属契约。
    @discardableResult
    func updateOrganizationLogo(id: String, logoURL: String) async throws -> Organization {
        guard AuthService.shared.isAuthenticated else { throw APIError.unauthorized }
        var settings = organizationSettingsBody(id: id)
        settings["logo_url"] = logoURL
        let updated: Organization = try await APIClient.shared.put(
            path: Endpoints.Context.organization(id),
            body: ["settings": settings]
        )
        applyUpdatedOrganization(updated)
        return updated
    }

    private func organizationSettingsBody(id: String) -> [String: Any] {
        let current = organizations.first(where: { $0.id == id }) ?? (selectedOrganization?.id == id ? selectedOrganization : nil)
        var body: [String: Any] = [:]
        if let value = current?.settings?.defaultModel { body["default_model"] = value }
        if let value = current?.settings?.enableTools { body["enable_tools"] = value }
        if let value = current?.settings?.allowMemberYolo { body["allow_member_yolo"] = value }
        if let value = current?.settings?.logoUrl { body["logo_url"] = value }
        return body
    }

    private func applyUpdatedOrganization(_ updated: Organization) {
        let id = updated.id
        if let idx = organizations.firstIndex(where: { $0.id == id }) {
            organizations[idx] = updated
        }
        if selectedOrganization?.id == id {
            selectedOrganization = updated
        }
    }

    func deleteOrganization(id: String) async throws {
        let _: MessageResponse = try await APIClient.shared.delete(path: Endpoints.Context.organization(id))
        removeOrganizationAndFallback(id)
    }

    func leaveOrganization(id: String) async throws {
        let _: MessageResponse = try await APIClient.shared.post(path: Endpoints.Context.organizationLeave(id))
        removeOrganizationAndFallback(id)
    }

    @discardableResult
    func createBotSpace(name: String) async throws -> Space {
        guard let wsId = selectedOrganizationId else {
            throw APIError.apiError("当前没有可用组织")
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw APIError.apiError("Space 名称不能为空")
        }

        let created: Space = try await APIClient.shared.post(
            path: Endpoints.Context.botSpaces,
            body: [
                "organization_id": wsId,
                "name": trimmed
            ]
        )
        spaces.insert(created, at: 0)
        return created
    }

    func deleteSpace(_ id: String) async throws {
        // ：DELETE /context/spaces/{id} 已 410；对齐 Electron WorkspaceApiService.delete。
        // 后端要求本机绑定设备声明 `device_id`，否则可能 403 REMOTE_DELETE_FORBIDDEN。
        var query: [String: String]?
        if let deviceId = spaces.first(where: { $0.id == id })?.executionDeviceId,
           !deviceId.isEmpty {
            query = ["device_id": deviceId]
        }
        struct WorkspaceDeleteAck: Decodable { let deleted: Bool? }
        let _: WorkspaceDeleteAck = try await APIClient.shared.delete(
            path: Endpoints.Context.workspace(id),
            query: query
        )
        spaces.removeAll { $0.id == id }
    }

    func loadMembers(organizationId: String) async {
        guard AuthService.shared.isAuthenticated else { return }
        membersRequestSeq += 1
        let seq = membersRequestSeq
        isLoadingMembers = members.isEmpty
        errorMessage = nil
        defer {
            if seq == membersRequestSeq, selectedOrganizationId == organizationId {
                isLoadingMembers = false
            }
        }
        do {
            let response: OrganizationMemberListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationMembers(organizationId)
            )
            guard seq == membersRequestSeq,
                  selectedOrganizationId == organizationId else { return }
            members = response.members
            resolveCurrentRoleFromLoadedMembers(organizationId: organizationId)
        } catch {
            guard seq == membersRequestSeq,
                  selectedOrganizationId == organizationId else { return }
            if !error.isCancellation {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                logger.error("loadMembers failed: \(error.localizedDescription)")
            }
        }
    }

    @discardableResult
    func updateMemberRole(organizationId: String, userId: String, role: OrganizationRole) async -> Bool {
        guard AuthService.shared.isAuthenticated else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let _: MessageResponse = try await APIClient.shared.put(
                path: Endpoints.Context.organizationMember(organizationId, userId: userId),
                body: ["role": role.rawValue]
            )
            await loadMembers(organizationId: organizationId)
            return true
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("updateMemberRole failed: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    func removeMember(organizationId: String, userId: String) async -> Bool {
        guard AuthService.shared.isAuthenticated else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let _: MessageResponse = try await APIClient.shared.delete(
                path: Endpoints.Context.organizationMember(organizationId, userId: userId)
            )
            members.removeAll { $0.userId == userId }
            return true
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("removeMember failed: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    func transferOwnership(organizationId: String, newOwnerUserId: String) async -> Bool {
        guard AuthService.shared.isAuthenticated else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let _: MessageResponse = try await APIClient.shared.post(
                path: Endpoints.Context.organizationTransferOwnership(organizationId),
                body: ["new_owner_user_id": newOwnerUserId]
            )
            await loadOrganizations()
            await loadMembers(organizationId: organizationId)
            await resolveCurrentRole(organizationId: organizationId)
            return true
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("transferOwnership failed: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    func updateSpace(_ id: String, name: String, description: String) async throws -> Space {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            throw APIError.apiError("Workspace 名称不能为空")
        }

        // ：PUT /context/spaces/{id} 已 410；正式契约为 PATCH /context/workspaces/{id}。
        let updatedSummary: WorkspaceSummary = try await APIClient.shared.patch(
            path: Endpoints.Context.workspace(id),
            body: [
                "name": trimmedName,
                "description": description.trimmingCharacters(in: .whitespacesAndNewlines)
            ]
        )
        let updated = updatedSummary.asSpace()
        if let idx = spaces.firstIndex(where: { $0.id == id }) {
            spaces[idx] = updated
        }
        return updated
    }

    /// 读取单个执行现场并映射为 Space 壳，供对话运行态 / 设置页复用。
    /// 正式路径：`GET /context/workspaces/{id}`（旧 `/context/spaces/{id}` 已 410）。
    func fetchWorkspaceAsSpace(_ id: String) async throws -> Space {
        let summary: WorkspaceSummary = try await APIClient.shared.get(
            path: Endpoints.Context.workspace(id)
        )
        return summary.asSpace()
    }

    func clearAll() {
        lifecycleGeneration += 1
        organizationsRequestSeq += 1
        organizationsLoadTask?.cancel()
        organizationsLoadTask = nil
        cancelSpacesLoad()
        organizations = []
        selectedOrganization = nil
        currentUserRole = nil
        spaces = []
        spacesLoadedOrganizationId = nil
        agentsById = [:]
        devicesById = [:]
        members = []
        persistedOrganizationId = nil
        didAttemptOrganizationLoad = false
        hasLoadedOrganizations = false
        isLoadingOrganizations = false
        isLoadingSpaces = false
        isLoadingSpaceMetadata = false
        isLoadingMembers = false
        isMutating = false
        errorMessage = nil
        spacesLoadError = nil
        organizationAccessRevokedNotice = nil
        spacesRequestSeq += 1
        spaceMetadataRequestSeq += 1
        membersRequestSeq += 1
    }

    private func removeOrganizationAndFallback(_ id: String) {
        organizations.removeAll { $0.id == id }
        if selectedOrganization?.id == id {
            cancelSpacesLoad()
            spacesRequestSeq += 1
            spaceMetadataRequestSeq += 1
            selectedOrganization = nil
            persistedOrganizationId = nil
            spaces = []
            spacesLoadedOrganizationId = nil
            agentsById = [:]
            devicesById = [:]
            members = []
            currentUserRole = nil
            RealtimeGateway.shared.disconnect()
            if let fallback = organizations.first {
                Task { await selectOrganization(fallback) }
            }
        }
    }

    private nonisolated static func makeOrganizationBody(
        name: String,
        description: String?,
        icon: String?
    ) -> sending [String: Any] {
        var body: [String: Any] = ["name": name]
        if let description, !description.isEmpty { body["description"] = description }
        if let icon, !icon.isEmpty { body["icon"] = icon }
        return body
    }

    private nonisolated static func makeOrganizationUpdateBody(
        name: String?,
        description: String?,
        icon: String?
    ) -> sending [String: Any] {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let icon { body["icon"] = icon }
        return body
    }

    private func resolveCurrentRole(organizationId: String) async {
        guard let userId = AuthService.shared.currentUser?.id else {
            currentUserRole = nil
            return
        }
        if selectedOrganization?.ownerId == userId {
            currentUserRole = .owner
            return
        }
        membersRequestSeq += 1
        let seq = membersRequestSeq
        do {
            let response: OrganizationMemberListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationMembers(organizationId)
            )
            guard seq == membersRequestSeq,
                  selectedOrganizationId == organizationId,
                  AuthService.shared.isAuthenticated else { return }
            members = response.members
            resolveCurrentRoleFromLoadedMembers(organizationId: organizationId)
        } catch {
            guard seq == membersRequestSeq,
                  selectedOrganizationId == organizationId else { return }
            guard !error.isCancellation else { return }
            currentUserRole = nil
            logger.warning("resolveCurrentRole failed: \(error.localizedDescription)")
        }
    }

    private func resolveCurrentRoleFromLoadedMembers(organizationId: String) {
        guard selectedOrganization?.id == organizationId,
              let userId = AuthService.shared.currentUser?.id else { return }
        if selectedOrganization?.ownerId == userId {
            currentUserRole = .owner
        } else if let myMember = members.first(where: { $0.userId == userId }) {
            currentUserRole = myMember.role
        } else {
            currentUserRole = .viewer
        }
    }

    // MARK: - Realtime 连通

    private func makeCredentials() -> RealtimeGateway.Credentials? {
        guard let token = KeychainService.shared.getAccessToken(), let wid = selectedOrganizationId else { return nil }
        return RealtimeGateway.Credentials(
            accessToken: token,
            organizationId: wid,
            deviceId: KeychainService.shared.getOrCreateDeviceId(),
            capabilities: realtimeCapabilities
        )
    }

    /// 进入主工作区时调用：装好凭据 provider 并发起连接。
    func connectRealtime() {
        RealtimeGateway.shared.credentialsProvider = { [weak self] in self?.makeCredentials() }
        observeDeviceStatus()
        observeIMResourceAccessStatus()
        RealtimeGateway.shared.connect()
    }

    // MARK: - IM 资源卡权限态

    private static let imResourceAccessListenerKey = "workspace.im.resource-access"

    /// 云文档 / 多维表卡片的权限变化属于用户级状态，不应依赖某个消息 item 是否正在屏幕内。
    /// 全局订阅后，即使卡片暂时离屏或用户稍后才进入会话，缓存也已收敛到最新权限态。
    private func observeIMResourceAccessStatus() {
        guard let userId = AuthService.shared.currentUser?.id
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !userId.isEmpty else {
            return
        }
        let topic = "context.sync.user.\(userId)"
        RealtimeGateway.shared.subscribe([topic])
        RealtimeGateway.shared.addEnvelopeListener(
            key: Self.imResourceAccessListenerKey
        ) { envelope in
            guard envelope.topic == nil || envelope.topic == topic else { return }
            IMCardStatusMemoryCache.handleResourceAccessEvent(envelope)
        }
    }

    // MARK: - 设备在线态

    private static let deviceStatusListenerKey = "workspace.device.status"

    /// 订阅 `device.status`：设备上下线由服务端主动推，不靠端上轮询。
    ///
    /// 同时挂重连监听——断线期间的事件是**丢掉的**，不补一次拉取，
    /// 在线态会长期停在断线前那一刻（比没有指示器更骗人）。
    private func observeDeviceStatus() {
        RealtimeGateway.shared.addEnvelopeListener(
            key: Self.deviceStatusListenerKey
        ) { [weak self] envelope in
            self?.applyDeviceStatusEvent(envelope)
        }
        RealtimeGateway.shared.addReconnectListener(
            key: Self.deviceStatusListenerKey
        ) { [weak self] in
            self?.refreshDeviceStatusAfterReconnect()
        }
    }

    private func applyDeviceStatusEvent(_ envelope: WSEnvelope) {
        guard let update = DeviceStatusEventPolicy.update(from: envelope) else { return }
        var devices = devicesById
        guard DeviceStatusEventPolicy.apply(update, to: &devices) else { return }
        devicesById = devices
    }

    /// 重连后补齐断线期间错过的状态变化。只重拉设备，不动 Space 列表。
    private func refreshDeviceStatusAfterReconnect() {
        guard let organizationId = selectedOrganizationId else { return }
        Task { [weak self] in
            let devices = await self?.fetchRuntimeDevices(organizationId: organizationId)
            guard let self, let devices, self.selectedOrganizationId == organizationId else { return }
            self.devicesById = devices
        }
    }
}
