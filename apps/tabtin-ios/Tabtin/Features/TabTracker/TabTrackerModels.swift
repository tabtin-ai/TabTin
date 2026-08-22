import Foundation

// MARK: - Tracker（自动化）

/// TabTracker 自动化。对齐后端 charter v1.8 单 Skill 执行模型
/// （TrackerListOut / TrackerOut）：无 steps、无 step-level checkpoint。
struct Tracker: Codable, Identifiable, Equatable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    var triggerType: TrackerTriggerType
    /// 触发参数（cron 表达式 / 时区等）。**列表接口不返回，只有详情返回**——
    /// 后端 `TrackerListOut` 无此字段，Electron 侧列表映射同样填空字典。
    /// 因此消费方必须容忍空值，不能把「空 = 没有排程」当事实。
    var triggerConfig: [String: AnyCodable]
    var status: TrackerStatus
    var skillKey: String
    var spaceId: String?
    var spaceName: String?
    var workspaceId: String?
    var agentId: String?
    var totalRuns: Int
    var successRuns: Int
    var failRuns: Int
    var lastRunAt: String?
    var nextRunAt: String?
    var capabilities: TrackerCapabilities?
    let createdAt: String
    var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, description, status
        case triggerType = "trigger_type"
        case triggerConfig = "trigger_config"
        case skillKey = "skill_key"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case workspaceId = "workspace_id"
        case agentId = "agent_id"
        case totalRuns = "total_runs"
        case successRuns = "success_runs"
        case failRuns = "fail_runs"
        case lastRunAt = "last_run_at"
        case nextRunAt = "next_run_at"
        case capabilities
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        triggerType = try c.decodeIfPresent(TrackerTriggerType.self, forKey: .triggerType) ?? .manual
        triggerConfig = try c.decodeIfPresent([String: AnyCodable].self, forKey: .triggerConfig) ?? [:]
        status = try c.decodeIfPresent(TrackerStatus.self, forKey: .status) ?? .unknown
        skillKey = try c.decodeIfPresent(String.self, forKey: .skillKey) ?? ""
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        spaceName = try c.decodeIfPresent(String.self, forKey: .spaceName)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        totalRuns = try c.decodeIfPresent(Int.self, forKey: .totalRuns) ?? 0
        successRuns = try c.decodeIfPresent(Int.self, forKey: .successRuns) ?? 0
        failRuns = try c.decodeIfPresent(Int.self, forKey: .failRuns) ?? 0
        lastRunAt = try c.decodeIfPresent(String.self, forKey: .lastRunAt)
        nextRunAt = try c.decodeIfPresent(String.self, forKey: .nextRunAt)
        capabilities = try c.decodeIfPresent(TrackerCapabilities.self, forKey: .capabilities)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }

    static func == (lhs: Tracker, rhs: Tracker) -> Bool {
        lhs.id == rhs.id && lhs.updatedAt == rhs.updatedAt && lhs.status == rhs.status
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

/// 服务端按当前用户投影的动作能力。字段缺失代表旧后端，必须按只读处理。
struct TrackerCapabilities: Codable, Equatable, Sendable {
    let canEdit: Bool
    let canTrigger: Bool
    let canCancel: Bool

    enum CodingKeys: String, CodingKey {
        case canEdit = "can_edit"
        case canTrigger = "can_trigger"
        case canCancel = "can_cancel"
    }

    static let readOnly = TrackerCapabilities(canEdit: false, canTrigger: false, canCancel: false)

    init(canEdit: Bool, canTrigger: Bool, canCancel: Bool) {
        self.canEdit = canEdit
        self.canTrigger = canTrigger
        self.canCancel = canCancel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canEdit = try c.decodeIfPresent(Bool.self, forKey: .canEdit) ?? false
        canTrigger = try c.decodeIfPresent(Bool.self, forKey: .canTrigger) ?? false
        canCancel = try c.decodeIfPresent(Bool.self, forKey: .canCancel) ?? false
    }
}

/// Tracker 生命周期状态。后端可能新增取值，解码失败兜底 `.unknown` 避免整列表失败。
enum TrackerStatus: String, Codable, Sendable {
    case draft, active, paused, disabled, archived, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TrackerStatus(rawValue: raw) ?? .unknown
    }

    var displayLabel: String {
        switch self {
        case .draft: return "草案"
        case .active: return "已激活"
        case .paused: return "已暂停"
        case .disabled: return "已禁用"
        case .archived: return "已归档"
        case .unknown: return "未知"
        }
    }

    var displayIcon: String {
        switch self {
        case .draft: return "doc.text"
        case .active: return "bolt.fill"
        case .paused: return "pause.circle.fill"
        case .disabled, .archived: return "xmark.circle"
        case .unknown: return "questionmark.circle"
        }
    }
}

enum TrackerTriggerType: String, Codable, Sendable {
    case manual
    case cron
    case interval
    case at
    case extensionEvent = "extension_event"
    case tableEvent = "table_event"
    case webhook
    case trackerCompleted = "tracker_completed"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TrackerTriggerType(rawValue: raw) ?? .unknown
    }

    var displayLabel: String {
        switch self {
        case .manual: return "手动触发"
        case .cron: return "定时（Cron）"
        case .interval: return "固定间隔"
        case .at: return "一次性执行"
        case .extensionEvent: return "扩展事件"
        case .tableEvent: return "表格事件"
        case .webhook: return "Webhook"
        case .trackerCompleted: return "上游任务完成后"
        case .unknown: return "其他"
        }
    }

    var displayIcon: String {
        switch self {
        case .manual: return "hand.tap"
        case .cron: return "clock"
        case .interval: return "timer"
        case .at: return "calendar.badge.clock"
        case .extensionEvent: return "puzzlepiece.extension"
        case .tableEvent: return "tablecells"
        case .webhook: return "antenna.radiowaves.left.and.right"
        case .trackerCompleted: return "checkmark.circle"
        case .unknown: return "gearshape"
        }
    }
}

// MARK: - TrackerTemplate（预置场景模板）

/// 自动化预置模板。对齐后端 `GET /tracker/templates`（`tracker_templates.py`）：
/// 只是「任务蓝图」——给名称、指令与默认 cron，**不**绑定 Agent / Workspace，
/// 后者一律由创建弹窗让用户当场确认，模板不代替授权决策。
struct TrackerTemplate: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let version: String
    let name: String
    let description: String
    let category: String
    let iconKey: String
    /// 预填到「自动化任务名称」输入框的默认值，与展示用的 `name` 可以不同。
    let defaultName: String
    let instructions: String
    let triggerType: TrackerTriggerType
    /// 后端在 `expression` 与 `cron_expression` 两个键之间不统一，消费方需双读。
    let triggerConfig: [String: AnyCodable]
    let requirements: String

    enum CodingKeys: String, CodingKey {
        case id, version, name, description, category, instructions, requirements
        case iconKey = "icon_key"
        case defaultName = "default_name"
        case triggerType = "trigger_type"
        case triggerConfig = "trigger_config"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? "1"
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        iconKey = try c.decodeIfPresent(String.self, forKey: .iconKey) ?? ""
        defaultName = try c.decodeIfPresent(String.self, forKey: .defaultName) ?? name
        instructions = try c.decodeIfPresent(String.self, forKey: .instructions) ?? ""
        triggerType = try c.decodeIfPresent(TrackerTriggerType.self, forKey: .triggerType) ?? .manual
        triggerConfig = try c.decodeIfPresent([String: AnyCodable].self, forKey: .triggerConfig) ?? [:]
        requirements = try c.decodeIfPresent(String.self, forKey: .requirements) ?? ""
    }
}

struct TrackerTemplateListResponse: Codable, Sendable {
    let templates: [TrackerTemplate]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        templates = try c.decodeIfPresent([TrackerTemplate].self, forKey: .templates) ?? []
    }
}

// MARK: - TrackerRun（运行记录）

/// 一次 Tracker 运行 = Agent 的一轮 react 循环，transcript 在关联 ChatSession。
/// 对齐后端 TrackerRunListOut / TrackerRunOut。
struct TrackerRun: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let trackerId: String
    var chatSessionId: String?
    var triggerType: String
    var status: TrackerRunStatus
    var progress: Int
    var progressPct: Int
    var progressMessage: String
    var tokensUsed: Int
    var currentCycle: Int
    var maxCycles: Int
    var startedAt: String?
    var finishedAt: String?
    var duration: Double?
    var errorSummary: String
    var resultSummary: String
    var capabilities: TrackerCapabilities?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, status, progress, duration
        case trackerId = "tracker_id"
        case chatSessionId = "chat_session_id"
        case triggerType = "trigger_type"
        case progressPct = "progress_pct"
        case progressMessage = "progress_message"
        case tokensUsed = "tokens_used"
        case currentCycle = "current_cycle"
        case maxCycles = "max_cycles"
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case errorSummary = "error_summary"
        case resultSummary = "result_summary"
        case capabilities
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        trackerId = try c.decodeIfPresent(String.self, forKey: .trackerId) ?? ""
        chatSessionId = try c.decodeIfPresent(String.self, forKey: .chatSessionId)
        triggerType = try c.decodeIfPresent(String.self, forKey: .triggerType) ?? "manual"
        status = try c.decodeIfPresent(TrackerRunStatus.self, forKey: .status) ?? .pending
        progress = try c.decodeIfPresent(Int.self, forKey: .progress) ?? 0
        progressPct = try c.decodeIfPresent(Int.self, forKey: .progressPct) ?? 0
        progressMessage = try c.decodeIfPresent(String.self, forKey: .progressMessage) ?? ""
        tokensUsed = try c.decodeIfPresent(Int.self, forKey: .tokensUsed) ?? 0
        currentCycle = try c.decodeIfPresent(Int.self, forKey: .currentCycle) ?? 1
        maxCycles = try c.decodeIfPresent(Int.self, forKey: .maxCycles) ?? 1
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
        duration = try c.decodeIfPresent(Double.self, forKey: .duration)
        errorSummary = try c.decodeIfPresent(String.self, forKey: .errorSummary) ?? ""
        resultSummary = try c.decodeIfPresent(String.self, forKey: .resultSummary) ?? ""
        capabilities = try c.decodeIfPresent(TrackerCapabilities.self, forKey: .capabilities)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }

    static func == (lhs: TrackerRun, rhs: TrackerRun) -> Bool {
        lhs.id == rhs.id && lhs.status == rhs.status && lhs.progressPct == rhs.progressPct
    }
}

/// Run 状态。`waiting_checkpoint` 仅 DB 历史存量可能出现（新链路已废弃）。
enum TrackerRunStatus: String, Codable, Sendable {
    case pending
    case running
    case waitingDevice = "waiting_device"
    case waitingCheckpoint = "waiting_checkpoint"
    case completed
    case partialFailed = "partial_failed"
    case failed
    case cancelled
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TrackerRunStatus(rawValue: raw) ?? .unknown
    }

    var isTerminal: Bool {
        switch self {
        case .completed, .partialFailed, .failed, .cancelled: return true
        case .pending, .running, .waitingDevice, .waitingCheckpoint, .unknown: return false
        }
    }

    var displayLabel: String {
        switch self {
        case .pending: return "排队中"
        case .running: return "执行中"
        case .waitingDevice: return "等待设备"
        case .waitingCheckpoint: return "等待确认"
        case .completed: return "已完成"
        case .partialFailed: return "部分失败"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .unknown: return "未知"
        }
    }

    var displayIcon: String {
        switch self {
        case .pending: return "clock"
        case .running: return "arrow.triangle.2.circlepath"
        case .waitingDevice: return "iphone.and.arrow.forward"
        case .waitingCheckpoint: return "hand.raised.fill"
        case .completed: return "checkmark.circle.fill"
        case .partialFailed: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.circle.fill"
        case .cancelled: return "stop.circle.fill"
        case .unknown: return "questionmark.circle"
        }
    }
}

// MARK: - API Response Wrappers

/// `GET /tracker/schedule-preview` 的一个未来执行点。
/// 服务端只展开 active 且时间触发（cron / interval / at）的自动化，不含 trigger_config。
struct TrackerScheduleOccurrence: Codable, Identifiable, Equatable, Sendable {
    let trackerId: String
    let name: String
    let spaceId: String?
    let spaceName: String?
    let scheduledAt: String
    let status: TrackerStatus
    let triggerType: String
    let timezone: String

    /// 同一个自动化在窗口里会出现多次，`trackerId` 不唯一——加上时间才是这一条的身份。
    var id: String { "\(trackerId)@\(scheduledAt)" }

    enum CodingKeys: String, CodingKey {
        case name, status, timezone
        case trackerId = "tracker_id"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case scheduledAt = "scheduled_at"
        case triggerType = "trigger_type"
    }
}

struct TrackerSchedulePreviewResponse: Codable, Sendable {
    let occurrences: [TrackerScheduleOccurrence]
    /// 窗口内执行点过多被服务端截断——UI 要如实说「还有更多」，不能假装这就是全部。
    let truncated: Bool

    enum CodingKeys: String, CodingKey {
        case occurrences, truncated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        occurrences = try c.decodeIfPresent([TrackerScheduleOccurrence].self, forKey: .occurrences) ?? []
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

struct TrackerListResponse: Codable, Sendable {
    let events: [Tracker]
    let total: Int
    let page: Int
    let pageSize: Int
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case events, total, page
        case pageSize = "page_size"
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decodeIfPresent([Tracker].self, forKey: .events) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        page = try c.decodeIfPresent(Int.self, forKey: .page) ?? 1
        pageSize = try c.decodeIfPresent(Int.self, forKey: .pageSize) ?? max(events.count, 1)
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? (events.count < total)
    }
}

struct TrackerRunListResponse: Codable, Sendable {
    let runs: [TrackerRun]
}

struct TrackerEmptyResponse: Codable, Sendable {}

enum TrackerListStatusFilter: String, CaseIterable, Identifiable, Sendable {
    case all, active, paused, draft, disabled

    var id: Self { self }

    var title: String {
        switch self {
        case .all: return "全部状态"
        case .active: return "运行中"
        case .paused: return "已暂停"
        case .draft: return "草案"
        case .disabled: return "已禁用"
        }
    }

    var trackerStatus: TrackerStatus? {
        self == .all ? nil : TrackerStatus(rawValue: rawValue)
    }
}

enum TrackerListProjection {
    static func filtered(
        _ trackers: [Tracker],
        searchText: String,
        status: TrackerListStatusFilter
    ) -> [Tracker] {
        let keyword = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trackers.filter { tracker in
            let matchesStatus = status.trackerStatus.map { tracker.status == $0 } ?? true
            guard matchesStatus else { return false }
            guard !keyword.isEmpty else { return true }
            return tracker.name.localizedCaseInsensitiveContains(keyword)
                || tracker.description.localizedCaseInsensitiveContains(keyword)
                || tracker.skillKey.localizedCaseInsensitiveContains(keyword)
                || (tracker.spaceName?.localizedCaseInsensitiveContains(keyword) ?? false)
        }
    }
}

enum TrackerLifecycleAction: Equatable, Sendable {
    case pause, resume, activate
}

/// 手动触发只看最新 Run：任意尚未终结的状态都必须先完成或取消，避免客户端
/// 枚举与服务端的单 Tracker 并发约束漂移。
enum TrackerRunExecutionPolicy {
    static let activeRunExplanation = "当前运行尚未结束，请等待完成或先取消当前运行。"

    static func canTrigger(latestRun: TrackerRun?) -> Bool {
        guard let latestRun else { return true }
        return latestRun.status.isTerminal
    }
}

enum TrackerRunExecutionError: LocalizedError {
    case activeRunInProgress

    var errorDescription: String? {
        switch self {
        case .activeRunInProgress: return TrackerRunExecutionPolicy.activeRunExplanation
        }
    }
}

enum TrackerActionPolicy {
    static func canTrigger(_ tracker: Tracker) -> Bool {
        tracker.capabilities?.canTrigger == true && tracker.status == .active
    }

    static func lifecycleAction(for tracker: Tracker) -> TrackerLifecycleAction? {
        guard tracker.capabilities?.canEdit == true else { return nil }
        switch tracker.status {
        case .active: return .pause
        case .paused, .disabled: return .resume
        case .draft: return .activate
        case .archived, .unknown: return nil
        }
    }

    static func canCancel(_ run: TrackerRun) -> Bool {
        run.capabilities?.canCancel == true && !run.status.isTerminal
    }
}

enum TrackerRunConversationTargetResolver {
    static func resolve(
        session: ChatSession,
        fallbackOrganizationId: String
    ) -> ConversationTarget? {
        guard let workspaceId = nonEmpty(session.workspaceId) else { return nil }
        return ConversationTarget(
            title: nonEmpty(session.title) ?? "自动化会话",
            workspaceId: workspaceId,
            organizationId: nonEmpty(session.organizationId) ?? fallbackOrganizationId,
            agentId: nonEmpty(session.agentId),
            projectId: nonEmpty(session.projectId),
            sessionId: session.id
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

enum AutomationLayoutMode: Equatable, Sendable {
    case stack, split
}

enum AutomationLayoutPolicy {
    static func mode(isRegularWidth: Bool) -> AutomationLayoutMode {
        isRegularWidth ? .split : .stack
    }
}

/// 自动化页是否应自行写入 `MainRouter.setTabPushed(.tasks, …)`。
///
/// 从任务页 push 进来时（`providesNavigationContainer == false`），栈深度由
/// `TaskHomeRoot.path.count` 权威上报；此处再写会在列表层把 `pushed` 清回 `false`，
/// 导致 dock 不消失。模态（`isModal`）不参与主 Tab 底栏契约。
enum AutomationTabBarPushReporting {
    static func shouldReportToMainRouter(
        providesNavigationContainer: Bool,
        isModal: Bool
    ) -> Bool {
        providesNavigationContainer && !isModal
    }
}
