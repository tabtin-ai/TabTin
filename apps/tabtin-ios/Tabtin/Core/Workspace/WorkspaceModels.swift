import Foundation

enum AgentAvatarPreset: String, CaseIterable, Identifiable, Sendable {
    // 已发布的首批头像：顺序与 rawValue 是跨端持久化契约，不得调整。
    case generalAssistant = "general-assistant"
    case codeEngineer = "code-engineer"
    case docWriter = "doc-writer"
    case dataAnalyst = "data-analyst"
    case webResearcher = "web-researcher"
    case slideDesigner = "slide-designer"
    case officeSecretary = "office-secretary"

    // 功能优先的简笔头像使用独立 key，追加在旧头像之后，避免改变默认选择。
    case functionGeneralAssistant = "function-general-assistant"
    case functionCodeEngineer = "function-code-engineer"
    case functionDocWriter = "function-doc-writer"
    case functionDataAnalyst = "function-data-analyst"
    case functionWebResearcher = "function-web-researcher"
    case functionSlideDesigner = "function-slide-designer"
    case functionOfficeSecretary = "function-office-secretary"

    var id: String { rawValue }

    var imageName: String {
        switch self {
        case .generalAssistant: "AgentAvatarGeneralAssistant"
        case .codeEngineer: "AgentAvatarCodeEngineer"
        case .docWriter: "AgentAvatarDocWriter"
        case .dataAnalyst: "AgentAvatarDataAnalyst"
        case .webResearcher: "AgentAvatarWebResearcher"
        case .slideDesigner: "AgentAvatarSlideDesigner"
        case .officeSecretary: "AgentAvatarOfficeSecretary"
        case .functionGeneralAssistant: "AgentAvatarFunctionGeneralAssistant"
        case .functionCodeEngineer: "AgentAvatarFunctionCodeEngineer"
        case .functionDocWriter: "AgentAvatarFunctionDocWriter"
        case .functionDataAnalyst: "AgentAvatarFunctionDataAnalyst"
        case .functionWebResearcher: "AgentAvatarFunctionWebResearcher"
        case .functionSlideDesigner: "AgentAvatarFunctionSlideDesigner"
        case .functionOfficeSecretary: "AgentAvatarFunctionOfficeSecretary"
        }
    }

    var label: String {
        switch self {
        case .generalAssistant: "通用助手"
        case .codeEngineer: "代码工程师"
        case .docWriter: "文档写作"
        case .dataAnalyst: "数据分析"
        case .webResearcher: "网页研究"
        case .slideDesigner: "幻灯片设计"
        case .officeSecretary: "办公秘书"
        case .functionGeneralAssistant: "功能简笔·通用助理"
        case .functionCodeEngineer: "功能简笔·代码工程"
        case .functionDocWriter: "功能简笔·文档写作"
        case .functionDataAnalyst: "功能简笔·数据分析"
        case .functionWebResearcher: "功能简笔·网页研究"
        case .functionSlideDesigner: "功能简笔·幻灯片设计"
        case .functionOfficeSecretary: "功能简笔·办公秘书"
        }
    }
}

/// Organization / Space 模型。移植自 apps/tabtin-ios，裁掉与 Phase 1 无关的派生字段
/// （RelativeTimeFormatter 等随对应 Feature 再补）。字段与后端 /context/* 对齐。

struct OrganizationSettings: Codable, Equatable, Hashable, Sendable {
    let defaultModel: String?
    let enableTools: Bool?
    /// 组织准入天花板：是否允许成员在对话里使用 YOLO / 宽松审批档。
    /// 缺失按未开放（nil → false）处理，与后端 fail-safe 一致。
    let allowMemberYolo: Bool?
    /// 组织头像的当前契约；legacy `Organization.icon` 不再参与头像展示。
    let logoUrl: String?

    enum CodingKeys: String, CodingKey {
        case defaultModel = "default_model"
        case enableTools = "enable_tools"
        case allowMemberYolo = "allow_member_yolo"
        case logoUrl = "logo_url"
    }
}

struct Organization: Codable, Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String?
    let icon: String?
    let ownerId: String?
    let isDefault: Bool?
    let type: String?
    let memberCount: Int?
    let spaceCount: Int?
    let settings: OrganizationSettings?
    let createdAt: String?
    let updatedAt: String?

    var isPersonal: Bool { type == "personal" }

    var logoURL: URL? {
        guard let raw = settings?.logoUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var hasCustomLogo: Bool { logoURL != nil }

    /// 团队默认头像只显示名称的第一个字，不复用用户头像的双首字母规则。
    var avatarFallbackText: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first.map(String.init) ?? "?"
    }

    /// 导航栏 / 切换器展示名：个人组织用统一文案，团队组织用 name。
    var switcherLabel: String {
        isPersonal ? L10n.Workspace.personalIdentity : name
    }

    enum CodingKeys: String, CodingKey {
        case id, name, description, icon, settings, type
        case ownerId = "owner_id"
        case isDefault = "is_default"
        case memberCount = "member_count"
        case spaceCount = "space_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct OrganizationListResponse: Decodable, Sendable {
    let organizations: [Organization]
    let total: Int?
}

enum OrganizationRole: String, Codable, Comparable, CaseIterable, Identifiable, Sendable {
    case viewer
    case editor
    case admin
    case owner
    case unknown

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = OrganizationRole(rawValue: value) ?? .unknown
    }

    private var level: Int {
        switch self {
        case .unknown, .viewer: return 0
        case .editor: return 1
        case .admin: return 2
        case .owner: return 3
        }
    }

    static func < (lhs: OrganizationRole, rhs: OrganizationRole) -> Bool {
        lhs.level < rhs.level
    }

    var title: String {
        switch self {
        case .owner: return L10n.Workspace.owner
        case .admin: return L10n.Workspace.admin
        case .editor: return L10n.Workspace.editor
        case .viewer: return L10n.Workspace.viewer
        case .unknown: return L10n.Workspace.unknown
        }
    }

    /// 组织级管理写权限：仅 owner（与 Electron `canManageOrganization` 对齐；存量 admin 无管理写权限）。
    var canManage: Bool { self == .owner }
    var canEdit: Bool { self >= .editor }
    var isOwner: Bool { self == .owner }
}

enum OrganizationMemberActions {
    static func canManage(
        operatorRole: OrganizationRole?,
        targetRole: OrganizationRole,
        isCurrentUser: Bool,
        isPersonalOrganization: Bool
    ) -> Bool {
        guard let operatorRole else { return false }
        return !isPersonalOrganization
            && !isCurrentUser
            && operatorRole >= .admin
            && operatorRole > targetRole
    }

    static func canAssign(operatorRole: OrganizationRole?, role: OrganizationRole) -> Bool {
        guard let operatorRole else { return false }
        return operatorRole >= .admin && operatorRole > role
    }
}

struct InvitationInfo: Decodable, Sendable {
    let valid: Bool
    let status: String
    let organizationName: String?
    let organizationIcon: String?
    let role: OrganizationRole?

    enum CodingKeys: String, CodingKey {
        case valid, status, role
        case organizationName = "organization_name"
        case organizationIcon = "organization_icon"
    }
}

struct AcceptInvitationResponse: Decodable, Sendable {
    let organizationId: String
    let organizationName: String
    let role: OrganizationRole

    enum CodingKeys: String, CodingKey {
        case role
        case organizationId = "organization_id"
        case organizationName = "organization_name"
    }
}

/// 组织切换后上下文是否可用于侧栏 / 主壳（计划 7.2 readiness）。
enum OrganizationContextReadiness: Equatable, Sendable {
    case ready
    case loading
    case failed(message: String)
}

struct MemberUser: Codable, Hashable, Sendable {
    let id: String
    let nickname: String?
    let username: String?
    let email: String?
    let phone: String?
    let avatar: String?
}

struct OrganizationMember: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let role: OrganizationRole
    let joinedAt: String?
    let user: MemberUser?

    enum CodingKeys: String, CodingKey {
        case id, role, user
        case userId = "user_id"
        case joinedAt = "joined_at"
    }

    var displayName: String {
        if let name = user?.nickname, !name.isEmpty { return name }
        if let name = user?.username, !name.isEmpty { return name }
        if let phone = user?.phone, !phone.isEmpty { return phone }
        if let email = user?.email, !email.isEmpty { return email }
        return L10n.Profile.defaultName
    }

    var subtitle: String? {
        if let username = user?.username, !username.isEmpty { return "@\(username)" }
        if let email = user?.email, !email.isEmpty { return email }
        if let phone = user?.phone, !phone.isEmpty { return phone }
        return nil
    }

    var avatar: String? { user?.avatar }
}

enum OrganizationMemberPresentation {
    /// 组织所有者固定置顶；其余成员保持服务端顺序，避免每次刷新产生无意义跳动。
    static func ownerFirst(_ members: [OrganizationMember]) -> [OrganizationMember] {
        members.enumerated().sorted { lhs, rhs in
            let lhsIsOwner = lhs.element.role.isOwner
            let rhsIsOwner = rhs.element.role.isOwner
            if lhsIsOwner != rhsIsOwner { return lhsIsOwner }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }
}

struct OrganizationMemberListResponse: Decodable, Sendable {
    let members: [OrganizationMember]
    let total: Int?
}

struct MessageResponse: Decodable, Sendable {
    let message: String?
}

struct WalletInfo: Decodable, Equatable, Sendable {
    let organizationId: String
    let credits: Int
    let creditsPrecise: String?
    let creditsFrozen: Int
    let creditsFrozenPrecise: String?
    let availableCredits: Int
    let availableCreditsPrecise: String?

    enum CodingKeys: String, CodingKey {
        case credits
        case organizationId = "organization_id"
        case creditsPrecise = "credits_precise"
        case creditsFrozen = "credits_frozen"
        case creditsFrozenPrecise = "credits_frozen_precise"
        case availableCredits = "available_credits"
        case availableCreditsPrecise = "available_credits_precise"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        credits = try c.decodeIfPresent(Int.self, forKey: .credits) ?? 0
        creditsFrozen = try c.decodeIfPresent(Int.self, forKey: .creditsFrozen) ?? 0
        availableCredits = try c.decodeIfPresent(Int.self, forKey: .availableCredits) ?? 0
        creditsPrecise = WorkspaceNumberFormat.decodeString(from: c, key: .creditsPrecise)
        creditsFrozenPrecise = WorkspaceNumberFormat.decodeString(from: c, key: .creditsFrozenPrecise)
        availableCreditsPrecise = WorkspaceNumberFormat.decodeString(from: c, key: .availableCreditsPrecise)
    }
}

struct WalletTransaction: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let transactionType: String
    let amount: Int
    let amountPrecise: String?
    let description: String
    let organizationId: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, amount, description
        case transactionType = "transaction_type"
        case amountPrecise = "amount_precise"
        case organizationId = "organization_id"
        case createdAt = "created_at"
    }
}

struct TransactionsResponse: Decodable, Sendable {
    let total: Int
    let transactions: [WalletTransaction]
}

enum WorkspaceNumberFormat {
    static func formatCredits(_ precise: String?, fallback: Int? = nil) -> String {
        guard let raw = precise, let decimal = Decimal(string: raw) else {
            guard let fallback else { return "0" }
            return "\(fallback)"
        }
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 4
        formatter.numberStyle = .none
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSDecimalNumber(decimal: decimal)) ?? (fallback.map { "\($0)" } ?? "0")
    }

    static func decodeString<Key: CodingKey>(
        from container: KeyedDecodingContainer<Key>,
        key: Key
    ) -> String? {
        if let value = try? container.decode(String.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(Double.self, forKey: key) {
            return String(format: "%.4f", value)
        }
        if let value = try? container.decode(Int.self, forKey: key) {
            return "\(value)"
        }
        return nil
    }

    /// 与 Electron 用量中心保持一致的点券精度：极小值 4 位、小于 1 时 2 位，
    /// 其余最多 2 位。用 Decimal 避免高精度点券先转 Double 后产生误差。
    static func formatUsageCredits(_ raw: String, locale: Locale = .current) -> String {
        guard let decimal = Decimal(string: raw, locale: Locale(identifier: "en_US_POSIX")) else {
            return "0"
        }
        if decimal == .zero { return "0" }

        let magnitude = decimal.magnitude
        let fixedDigits: Int?
        let maximumDigits: Int
        if magnitude < Decimal(string: "0.01")! {
            fixedDigits = 4
            maximumDigits = 4
        } else if magnitude < 1 {
            fixedDigits = 2
            maximumDigits = 2
        } else {
            fixedDigits = nil
            maximumDigits = 2
        }

        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.roundingMode = .halfUp
        formatter.minimumFractionDigits = fixedDigits ?? 0
        formatter.maximumFractionDigits = maximumDigits
        return formatter.string(from: NSDecimalNumber(decimal: decimal)) ?? "0"
    }
}

enum UsageDashboardPresentation {
    /// 后端仪表盘契约最多返回 20 个模型；移动端不再额外截断。
    static let modelRankLimit = 20
}

struct UsageMeterSlice: Decodable, Equatable, Sendable {
    let meterKey: String
    let totalCredits: String
    let totalQuantity: String?

    enum CodingKeys: String, CodingKey {
        case meterKey = "meter_key"
        case totalCredits = "total_credits"
        case totalQuantity = "total_quantity"
    }
}

struct UsageModelSlice: Decodable, Equatable, Sendable {
    let modelName: String
    let totalCredits: String
    let callCount: Int?

    enum CodingKeys: String, CodingKey {
        case modelName = "model_name"
        case totalCredits = "total_credits"
        case callCount = "call_count"
    }
}

struct UsageDashboardData: Decodable, Equatable, Sendable {
    let organizationId: String?
    let currentMonthTotalCredits: String
    let lastMonthTotalCredits: String
    let monthOverMonthPct: Double?
    let todayTotalCredits: String?
    let todayAggregatedAmount: String?
    let byMeter: [UsageMeterSlice]
    let byModel: [UsageModelSlice]

    enum CodingKeys: String, CodingKey {
        case organizationId = "organization_id"
        case currentMonthTotalCredits = "current_month_total_credits"
        case lastMonthTotalCredits = "last_month_total_credits"
        case monthOverMonthPct = "month_over_month_pct"
        case todayTotalCredits = "today_total_credits"
        case todayAggregatedAmount = "today_aggregated_amount"
        case byMeter = "by_meter"
        case byModel = "by_model"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        organizationId = try c.decodeIfPresent(String.self, forKey: .organizationId)
        currentMonthTotalCredits = (try? c.decode(String.self, forKey: .currentMonthTotalCredits)) ?? "0"
        lastMonthTotalCredits = (try? c.decode(String.self, forKey: .lastMonthTotalCredits)) ?? "0"
        monthOverMonthPct = try c.decodeIfPresent(Double.self, forKey: .monthOverMonthPct)
        todayTotalCredits = try c.decodeIfPresent(String.self, forKey: .todayTotalCredits)
        todayAggregatedAmount = try c.decodeIfPresent(String.self, forKey: .todayAggregatedAmount)
        byMeter = (try? c.decode([UsageMeterSlice].self, forKey: .byMeter)) ?? []
        byModel = (try? c.decode([UsageModelSlice].self, forKey: .byModel)) ?? []
    }
}

struct OrganizationInvitation: Codable, Identifiable, Sendable {
    let id: String
    let organizationId: String
    let invitedBy: String?
    let inviteType: String?
    let email: String?
    let invitedUserId: String?
    let role: OrganizationRole
    let token: String?
    let status: String
    let expiresAt: String?
    let maxUses: Int?
    let useCount: Int?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, email, role, token, status
        case organizationId = "organization_id"
        case invitedBy = "invited_by"
        case inviteType = "invite_type"
        case invitedUserId = "invited_user_id"
        case expiresAt = "expires_at"
        case maxUses = "max_uses"
        case useCount = "use_count"
        case createdAt = "created_at"
    }
}

struct InvitationListResponse: Decodable, Sendable {
    let invitations: [OrganizationInvitation]
    let total: Int?
}

struct PendingInvitation: Codable, Identifiable, Sendable {
    let id: String
    let workspaceId: String
    let workspaceName: String
    let workspaceIcon: String
    let invitedBy: String?
    let invitedByName: String
    let role: OrganizationRole
    let status: String
    let expiresAt: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, role, status
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
        case workspaceIcon = "workspace_icon"
        case invitedBy = "invited_by"
        case invitedByName = "invited_by_name"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }

    enum OrganizationCodingKeys: String, CodingKey {
        case organizationId = "organization_id"
        case organizationName = "organization_name"
        case organizationIcon = "organization_icon"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let wt = try decoder.container(keyedBy: OrganizationCodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
            ?? wt.decode(String.self, forKey: .organizationId)
        workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
            ?? wt.decode(String.self, forKey: .organizationName)
        workspaceIcon = try c.decodeIfPresent(String.self, forKey: .workspaceIcon)
            ?? wt.decodeIfPresent(String.self, forKey: .organizationIcon)
            ?? ""
        invitedBy = try c.decodeIfPresent(String.self, forKey: .invitedBy)
        invitedByName = try c.decodeIfPresent(String.self, forKey: .invitedByName) ?? ""
        role = try c.decode(OrganizationRole.self, forKey: .role)
        status = try c.decode(String.self, forKey: .status)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct PendingInvitationListResponse: Decodable, Sendable {
    let invitations: [PendingInvitation]
    let total: Int?
}

struct InvitationRespondResponse: Decodable, Sendable {
    let workspaceId: String
    let workspaceName: String
    let status: String
    let role: OrganizationRole?

    enum CodingKeys: String, CodingKey {
        case status, role
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
    }

    enum OrganizationCodingKeys: String, CodingKey {
        case organizationId = "organization_id"
        case organizationName = "organization_name"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let wt = try decoder.container(keyedBy: OrganizationCodingKeys.self)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
            ?? wt.decode(String.self, forKey: .organizationId)
        workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
            ?? wt.decode(String.self, forKey: .organizationName)
        status = try c.decode(String.self, forKey: .status)
        role = try c.decodeIfPresent(OrganizationRole.self, forKey: .role)
    }
}

struct Space: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String
    /// 后端 Space 表类型：workspace 是可执行 Space，team_space 是 Project。
    /// 旧响应可能不带该字段，因此保持可选并在派生属性里按 workspace 兼容。
    var type: String? = nil
    var agentId: String?
    var executionAgentId: String? = nil
    var executionSpaceId: String? = nil
    var executionBindingSource: String? = nil
    var boundDeviceId: String? = nil
    var controlDeviceId: String? = nil
    var name: String
    var description: String?
    var icon: String?
    var avatar: String?
    var color: String?
    let status: String?
    let tableCount: Int?
    let order: Int?
    let isArchived: Bool?
    let isDefault: Bool?
    let configVersion: Int?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, icon, avatar, color, status, order, type
        case organizationId = "organization_id"
        case agentId = "agent_id"
        case executionAgentId = "execution_agent_id"
        case executionSpaceId = "execution_space_id"
        case executionBindingSource = "execution_binding_source"
        case boundDeviceId = "bound_device_id"
        case controlDeviceId = "control_device_id"
        /// `GET /context/workspaces/{id}` 正典字段；旧 Space 响应用 bound/control_device_id。
        case deviceId = "device_id"
        case workingDir = "working_dir"
        case isHome = "is_home"
        case tableCount = "table_count"
        case isArchived = "is_archived"
        case isDefault = "is_default"
        case configVersion = "config_version"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: String,
        organizationId: String,
        type: String? = nil,
        agentId: String? = nil,
        executionAgentId: String? = nil,
        executionSpaceId: String? = nil,
        executionBindingSource: String? = nil,
        boundDeviceId: String? = nil,
        controlDeviceId: String? = nil,
        name: String,
        description: String? = nil,
        icon: String? = nil,
        avatar: String? = nil,
        color: String? = nil,
        status: String? = nil,
        tableCount: Int? = nil,
        order: Int? = nil,
        isArchived: Bool? = nil,
        isDefault: Bool? = nil,
        configVersion: Int? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.organizationId = organizationId
        self.type = type
        self.agentId = agentId
        self.executionAgentId = executionAgentId
        self.executionSpaceId = executionSpaceId
        self.executionBindingSource = executionBindingSource
        self.boundDeviceId = boundDeviceId
        self.controlDeviceId = controlDeviceId
        self.name = name
        self.description = description
        self.icon = icon
        self.avatar = avatar
        self.color = color
        self.status = status
        self.tableCount = tableCount
        self.order = order
        self.isArchived = isArchived
        self.isDefault = isDefault
        self.configVersion = configVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        let decodedType = try c.decodeIfPresent(String.self, forKey: .type)
        let workingDir = try c.decodeIfPresent(String.self, forKey: .workingDir)
        // Workspace 详情没有历史 `type` 字段；有 working_dir / device_id 时按执行现场处理。
        if let decodedType {
            type = decodedType
        } else if workingDir != nil || c.contains(.deviceId) {
            type = "workspace"
        } else {
            type = nil
        }
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        executionAgentId = try c.decodeIfPresent(String.self, forKey: .executionAgentId)
        executionSpaceId = try c.decodeIfPresent(String.self, forKey: .executionSpaceId)
        executionBindingSource = try c.decodeIfPresent(String.self, forKey: .executionBindingSource)
        let deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
        boundDeviceId = try c.decodeIfPresent(String.self, forKey: .boundDeviceId) ?? deviceId
        controlDeviceId = try c.decodeIfPresent(String.self, forKey: .controlDeviceId) ?? deviceId
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description)
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        color = try c.decodeIfPresent(String.self, forKey: .color)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        tableCount = try c.decodeIfPresent(Int.self, forKey: .tableCount)
        order = try c.decodeIfPresent(Int.self, forKey: .order)
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived)
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault)
            ?? c.decodeIfPresent(Bool.self, forKey: .isHome)
        configVersion = try c.decodeIfPresent(Int.self, forKey: .configVersion)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(organizationId, forKey: .organizationId)
        try c.encodeIfPresent(type, forKey: .type)
        try c.encodeIfPresent(agentId, forKey: .agentId)
        try c.encodeIfPresent(executionAgentId, forKey: .executionAgentId)
        try c.encodeIfPresent(executionSpaceId, forKey: .executionSpaceId)
        try c.encodeIfPresent(executionBindingSource, forKey: .executionBindingSource)
        try c.encodeIfPresent(boundDeviceId, forKey: .boundDeviceId)
        try c.encodeIfPresent(controlDeviceId, forKey: .controlDeviceId)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(avatar, forKey: .avatar)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(tableCount, forKey: .tableCount)
        try c.encodeIfPresent(order, forKey: .order)
        try c.encodeIfPresent(isArchived, forKey: .isArchived)
        try c.encodeIfPresent(isDefault, forKey: .isDefault)
        try c.encodeIfPresent(configVersion, forKey: .configVersion)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }

    var subtitle: String { description ?? "" }
    var isExecutionSpace: Bool { type == nil || type == "workspace" }
    var isProject: Bool { type == "team_space" }
    var primaryAgentId: String? { executionAgentId ?? agentId }
    var executionDeviceId: String? { controlDeviceId ?? boundDeviceId }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    static func == (lhs: Space, rhs: Space) -> Bool {
        lhs.id == rhs.id && lhs.updatedAt == rhs.updatedAt && lhs.configVersion == rhs.configVersion
    }
}

/// Space 卡片所需的轻量 Agent 身份信息。
/// Agent 是参与者身份，不是 Space 的别名；完整设置字段仍由会话设置页按需加载。
struct AgentSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String?
    let userId: String?
    let ownerUserId: String?
    let name: String?
    let type: String?
    let isActive: Bool?
    let boundDeviceId: String?
    let controlDeviceId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type
        case organizationId = "organization_id"
        case userId = "user_id"
        case ownerUserId = "owner_user_id"
        case isActive = "is_active"
        case boundDeviceId = "bound_device_id"
        case controlDeviceId = "control_device_id"
    }

    var displayName: String? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return nil
        }
        return name
    }
}

/// Agent 展示配置。预置头像优先于自定义 URL，与 Electron 使用同一 avatar_key 契约。
struct OrganizationAgentSettings: Codable, Hashable, Sendable {
    let avatarURL: String?
    let avatarKey: String?

    enum CodingKeys: String, CodingKey {
        case avatarURL = "avatar_url"
        case avatarKey = "avatar_key"
    }
}

/// 组织下 AI分身列表项，对齐 Electron `OrganizationAgentSummary` / `GET /agents`。
struct OrganizationAgent: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String?
    let name: String
    let displayNameRaw: String?
    let type: String?
    let isActive: Bool?
    let isDefault: Bool?
    let goal: String?
    let customRules: String?
    let icon: String?
    let settings: OrganizationAgentSettings?
    let templateId: String?
    let updatedAt: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, goal, icon, settings
        case organizationId = "organization_id"
        case displayNameRaw = "display_name"
        case isActive = "is_active"
        case isDefault = "is_default"
        case customRules = "custom_rules"
        case templateId = "template_id"
        case updatedAt = "updated_at"
        case createdAt = "created_at"
    }

    var displayName: String {
        if let displayNameRaw {
            let trimmed = displayNameRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? id : trimmed
    }

    var isFromTemplate: Bool {
        guard let templateId, !templateId.isEmpty else { return false }
        return true
    }

    var avatarURL: URL? {
        guard let raw = settings?.avatarURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var avatarPreset: AgentAvatarPreset? {
        guard let raw = settings?.avatarKey?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return AgentAvatarPreset(rawValue: raw)
    }
}

/// AI分身携带的一个技能。服务端会合并携带开关与用户总开关，`locked` 的技能不可在手机端关闭或移除。
struct AgentSkillLink: Codable, Identifiable, Hashable, Sendable {
    let skillCanonicalKey: String
    let source: String?
    let enabled: Bool
    let agentEnabled: Bool?
    let userEnabled: Bool?
    let locked: Bool
    let name: String
    let description: String?
    let emoji: String?

    enum CodingKeys: String, CodingKey {
        case skillCanonicalKey = "skill_canonical_key"
        case source, enabled, locked, name, description, emoji
        case agentEnabled = "agent_enabled"
        case userEnabled = "user_enabled"
    }

    var id: String { skillCanonicalKey }
}

struct AgentSkillLinkListResponse: Decodable, Sendable {
    let skills: [AgentSkillLink]
    let total: Int?
}

/// 组织级远程 MCP 连接（Django LIST_ORG）。不含 Electron 本机 `attachedAgentIds`。
struct OrgMcpConnection: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let scope: String
    let transport: String
    let endpoint: String
    let enabled: Bool
    let organizationId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, scope, transport, endpoint, enabled
        case organizationId = "organization_id"
    }

    /// 组织列表仅含 remote；UI 用 localizedSourceLabel。
    var isLocalScope: Bool { scope == "local" }
}

struct OrgMcpConnectionListResponse: Decodable, Sendable {
    let connections: [OrgMcpConnection]
    let total: Int?
}

/// 当前用户某台设备上已登记的连接器安全展示子集。
/// 服务端响应还包含 command / args / cwd / config；移动端模型刻意不声明，
/// 防止市场展示层接触运行配置或凭据线索。
struct DeviceMcpConnection: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let transport: String
    let endpoint: String
    let enabled: Bool
    let deviceId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, transport, endpoint, enabled
        case deviceId = "device_id"
    }
}

struct DeviceMcpConnectionListResponse: Decodable, Sendable {
    let connections: [DeviceMcpConnection]
    let total: Int?
}

/// AI分身作用域下的一条长期记忆。
struct AgentMemoryRecord: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let memoryType: String
    let title: String
    let content: String
    let importance: Int?
    let tags: [String]
    let state: String
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, content, importance, tags, state
        case memoryType = "memory_type"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct AgentMemoryRecordListResponse: Decodable, Sendable {
    let items: [AgentMemoryRecord]
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case items
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decodeIfPresent([AgentMemoryRecord].self, forKey: .items) ?? []
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }
}

enum WorkspaceMemoryModelMode: String, Codable, Sendable {
    case officialDefault = "official_default"
    case explicitModel = "explicit_model"
}

enum WorkspaceMemoryProviderScope: String, Codable, CaseIterable, Sendable {
    case global
    case user
    case organization

    var groupTitle: String {
        switch self {
        case .global: return "TabTin 官方"
        case .user: return "我的模型"
        case .organization: return "组织模型"
        }
    }
}

struct WorkspaceMemoryModel: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let providerScope: WorkspaceMemoryProviderScope
    let providerDisplayName: String

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case providerScope = "provider_scope"
        case providerDisplayName = "provider_display_name"
    }
}

struct WorkspaceMemorySettings: Codable, Sendable {
    let workspaceScope: String
    let autoMemoryEnabled: Bool
    let memoryModelMode: WorkspaceMemoryModelMode
    let memoryModel: WorkspaceMemoryModel?
    let canUpdate: Bool

    enum CodingKeys: String, CodingKey {
        case workspaceScope = "workspace_scope"
        case autoMemoryEnabled = "auto_memory_enabled"
        case memoryModelMode = "memory_model_mode"
        case memoryModel = "memory_model"
        case canUpdate = "can_update"
    }

    func hasAvailableExplicitModel(in candidates: [WorkspaceMemoryModel]) -> Bool {
        guard memoryModelMode == .explicitModel else { return true }
        guard let memoryModel else { return false }
        return candidates.contains { $0.id == memoryModel.id }
    }
}

struct WorkspaceMemoryModelCatalog: Decodable, Sendable {
    let workspaceScope: String
    let items: [WorkspaceMemoryModel]

    enum CodingKeys: String, CodingKey {
        case workspaceScope = "workspace_scope"
        case items
    }
}

enum WorkspaceMemoryUpdatePayload {
    static func toggle(organizationId: String, enabled: Bool) -> [String: Any] {
        [
            "organization_id": organizationId,
            "auto_memory_enabled": enabled,
        ]
    }

    static func officialDefault(organizationId: String) -> [String: Any] {
        [
            "organization_id": organizationId,
            "memory_model_mode": WorkspaceMemoryModelMode.officialDefault.rawValue,
        ]
    }

    static func explicit(organizationId: String, modelId: String) -> [String: Any] {
        [
            "organization_id": organizationId,
            "memory_model_mode": WorkspaceMemoryModelMode.explicitModel.rawValue,
            "memory_model_id": modelId,
        ]
    }
}

/// Agent 参与的跨 Project 任务的移动端展示投影。
struct AgentProjectTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let workStatus: String?
    let assignmentStatus: String?
    let updatedAt: String?
    let project: AgentProjectTaskProject?

    enum CodingKeys: String, CodingKey {
        case id, title, project
        case workStatus = "work_status"
        case assignmentStatus = "assignment_status"
        case updatedAt = "updated_at"
    }
}

struct AgentProjectTaskProject: Codable, Hashable, Sendable {
    let id: String
    let name: String
}

struct AgentProjectTaskListResponse: Decodable, Sendable {
    let tasks: [AgentProjectTask]
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case tasks
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try container.decodeIfPresent([AgentProjectTask].self, forKey: .tasks) ?? []
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }
}

struct AgentMemoryMutationResult: Decodable, Sendable {
    let memoryId: String?
    let forgotten: Bool?

    enum CodingKeys: String, CodingKey {
        case memoryId = "memory_id"
        case forgotten
    }
}

struct AgentSkillRemovalResult: Decodable, Sendable {
    let skillCanonicalKey: String?
    let found: Bool?

    enum CodingKeys: String, CodingKey {
        case skillCanonicalKey = "skill_canonical_key"
        case found
    }
}

struct OrganizationAgentListResponse: Decodable, Sendable {
    let agents: [OrganizationAgent]
    let total: Int?
}

/// 已停用 AI分身列表项，对齐 `GET /agents/deactivated` 的轻量响应。
struct DeactivatedOrganizationAgent: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let type: String?
    let createdAt: String?
    let deactivatedAt: String?
    let settings: OrganizationAgentSettings?

    enum CodingKeys: String, CodingKey {
        case id, name, type, settings
        case createdAt = "created_at"
        case deactivatedAt = "deactivated_at"
    }

    init(
        id: String,
        name: String,
        type: String?,
        createdAt: String?,
        deactivatedAt: String?,
        settings: OrganizationAgentSettings? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.createdAt = createdAt
        self.deactivatedAt = deactivatedAt
        self.settings = settings
    }

    init(agent: OrganizationAgent) {
        self.init(
            id: agent.id,
            name: agent.displayName,
            type: agent.type,
            createdAt: agent.createdAt,
            // DELETE 会刷新服务端 updated_at，但响应不回传 Agent；本地先用当前时间，
            // 避免把停用前的旧更新时间误展示成“停用于”。
            deactivatedAt: ISO8601DateFormatter().string(from: Date()),
            settings: agent.settings
        )
    }

    var avatarURL: URL? {
        guard let raw = settings?.avatarURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var avatarPreset: AgentAvatarPreset? {
        guard let raw = settings?.avatarKey?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return AgentAvatarPreset(rawValue: raw)
    }
}

struct DeactivatedOrganizationAgentListResponse: Decodable, Sendable {
    let items: [DeactivatedOrganizationAgent]
    let total: Int?
}

struct AgentTemplateSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let version: String?
    let name: String
    let icon: String?
    let tagline: String?
    let description: String?
    let skills: [String]?

    func displayName(ownerName: String) -> String {
        name.replacingOccurrences(of: "{owner}", with: ownerName)
    }
}

struct AgentTemplateListResponse: Decodable, Sendable {
    let templates: [AgentTemplateSummary]
    let total: Int?
}

struct SpaceListResponse: Decodable, Sendable {
    let spaces: [Space]
    let total: Int?
}

/// `GET /context/workspaces` 摘要（ 后个人执行现场正典列表）。
struct WorkspaceSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String
    let name: String?
    let description: String?
    let workingDir: String
    let workingDirType: String?
    let customRules: String?
    let executionLimits: WorkspaceExecutionLimits?
    let deviceId: String?
    let deviceOnline: Bool?
    let isHome: Bool?
    let agentId: String?
    let executionAgentId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description
        case organizationId = "organization_id"
        case workingDir = "working_dir"
        case workingDirType = "working_dir_type"
        case customRules = "custom_rules"
        case executionLimits = "execution_limits"
        case deviceId = "device_id"
        case deviceOnline = "device_online"
        case isHome = "is_home"
        case agentId = "agent_id"
        case executionAgentId = "execution_agent_id"
    }

    /// 映射为现有 Space UI 模型，避免工作页整页改写。
    func asSpace() -> Space {
        let trimmedDir = workingDir.trimmingCharacters(in: CharacterSet(charactersIn: "/\\"))
        let fallbackName = (trimmedDir as NSString).lastPathComponent
        let resolvedName: String = {
            if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return name
            }
            return fallbackName.isEmpty ? "Workspace" : fallbackName
        }()
        let resolvedDescription: String? = {
            guard let description else { return nil }
            let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }()
        return Space(
            id: id,
            organizationId: organizationId,
            type: "workspace",
            agentId: agentId,
            executionAgentId: executionAgentId,
            executionBindingSource: nil,
            boundDeviceId: deviceId,
            controlDeviceId: deviceId,
            name: resolvedName,
            description: resolvedDescription,
            icon: nil,
            avatar: nil,
            color: nil,
            status: "active",
            tableCount: nil,
            order: nil,
            isArchived: false,
            isDefault: isHome,
            configVersion: nil,
            createdAt: nil,
            updatedAt: nil
        )
    }
}

struct WorkspaceExecutionLimits: Codable, Hashable, Sendable {
    let maxIterationsPerRun: Int?
    let maxCreditsPerRun: String?

    enum CodingKeys: String, CodingKey {
        case maxIterationsPerRun = "max_iterations_per_run"
        case maxCreditsPerRun = "max_credits_per_run"
    }

    init(maxIterationsPerRun: Int?, maxCreditsPerRun: String?) {
        self.maxIterationsPerRun = maxIterationsPerRun
        self.maxCreditsPerRun = maxCreditsPerRun
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maxIterationsPerRun = try container.decodeIfPresent(Int.self, forKey: .maxIterationsPerRun)
        if let text = try? container.decode(String.self, forKey: .maxCreditsPerRun) {
            maxCreditsPerRun = text
        } else if let number = try? container.decode(Double.self, forKey: .maxCreditsPerRun) {
            maxCreditsPerRun = String(number)
        } else {
            maxCreditsPerRun = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(maxIterationsPerRun, forKey: .maxIterationsPerRun)
        try container.encodeIfPresent(maxCreditsPerRun, forKey: .maxCreditsPerRun)
    }
}

struct WorkspaceListResponse: Decodable, Sendable {
    let workspaces: [WorkspaceSummary]
    let total: Int?
}

struct RuntimeDevice: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String?
    let deviceType: String?
    let status: String?
    let lastHeartbeatAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, status
        case deviceType = "device_type"
        case lastHeartbeatAt = "last_heartbeat_at"
    }

    var isAvailableForExecution: Bool {
        switch status?.lowercased() {
        case "online", "busy":
            return true
        default:
            return false
        }
    }
}

struct RuntimeDeviceListResponse: Decodable, Sendable {
    let devices: [RuntimeDevice]
    let total: Int?
}
