import Foundation
import os
@preconcurrency import SwiftData

enum QueuedOutgoingMessageStatus: String {
    case waiting
    case offline
    case sending
    case accepted
    case awaitingDevice = "awaiting_device"
    /// 消息已持久化到服务端，但该轮执行在启动前失败；只能隐藏本机跟踪。
    case persistedExecutionFailed = "persisted_execution_failed"
    case failed
}

enum OutgoingHistoryEvidence: Equatable {
    case absent
    case persisted
    case executionStarted
}

/// 发送回执：区分本地已保存 / 排队 / 服务端已接受，禁止统称「已发送」。
enum QueuedSendReceipt: Equatable, Sendable {
    case blocked(reason: String)
    case persisted(queueId: String)
    case queued(queueId: String)
    case accepted(queueId: String)
    case failed(reason: String)

    var queueId: String? {
        switch self {
        case let .persisted(queueId), let .queued(queueId), let .accepted(queueId):
            return queueId
        case .blocked, .failed:
            return nil
        }
    }

    var userFacingMessage: String {
        switch self {
        case .blocked(let reason): return reason
        case .persisted: return "已保存到本机"
        case .queued: return "已排队，当前任务完成后发送"
        case .accepted: return "已送达"
        case .failed(let reason): return reason
        }
    }

    /// 只有已经写入本地发送队列或被服务端接受的回执，才允许清空用户草稿。
    /// `.blocked` / `.failed` 虽然也是非 nil 回执，但消息并未获得可重试的持久化保障。
    var isPersistedForDelivery: Bool {
        switch self {
        case .persisted, .queued, .accepted:
            return true
        case .blocked, .failed:
            return false
        }
    }
}

struct QueuedOutgoingMessage: Identifiable {
    let id: String
    /// Stable idempotency key. New records reuse `id`; legacy records fall back to `id`.
    let clientEventId: String
    let sessionId: String
    let text: String
    let modelId: String?
    /// 发送时冻结的运行配置；重试绝不读取当前 Composer 的选择。
    let agentMode: ChatAgentMode
    let approvalMode: ChatApprovalMode
    let blocks: [[String: Any]]?
    /// 入队瞬间冻结的 Focus；重试只读本字段，不读当前工作台导航。
    let focusSnapshot: FocusSnapshot?
    let createdAt: Date
    let status: QueuedOutgoingMessageStatus
    let attemptCount: Int
    let lastError: String?
    let serverMessageId: String?
    let taskId: String?

    init(
        id: String,
        clientEventId: String,
        sessionId: String,
        text: String,
        modelId: String?,
        agentMode: String?,
        approvalMode: String? = nil,
        blocks: [[String: Any]]?,
        createdAt: Date,
        status: QueuedOutgoingMessageStatus,
        attemptCount: Int,
        lastError: String?,
        serverMessageId: String?,
        taskId: String?,
        permitsRelaxedApproval: Bool = false,
        focusSnapshot: FocusSnapshot? = nil
    ) {
        let configuration = ConversationRuntimeConfiguration.migrating(
            agentMode: agentMode,
            approvalMode: approvalMode,
            permitsRelaxedApproval: permitsRelaxedApproval
        )
        self.id = id
        self.clientEventId = clientEventId
        self.sessionId = sessionId
        self.text = text
        self.modelId = modelId
        self.agentMode = configuration.agentMode
        self.approvalMode = configuration.approvalMode
        self.blocks = blocks
        self.focusSnapshot = focusSnapshot
        self.createdAt = createdAt
        self.status = status
        self.attemptCount = attemptCount
        self.lastError = lastError
        self.serverMessageId = serverMessageId
        self.taskId = taskId
    }

    var previewText: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        let blockCount = blocks?.count ?? 0
        return blockCount > 0 ? "\(blockCount) 个附件或上下文" : "待发送消息"
    }

    var isAutoDrainable: Bool {
        OutgoingQueuePolicy.isAutoDrainEligible(status)
    }

    var isAwaitingExecutionConfirmation: Bool {
        OutgoingQueuePolicy.isAwaitingExecutionConfirmation(status)
    }

    func matchesExecutionTask(_ candidateTaskId: String) -> Bool {
        isAwaitingExecutionConfirmation && !candidateTaskId.isEmpty && taskId == candidateTaskId
    }

    /// Preserve FIFO order so session recovery reconciles every accepted send deterministically.
    static func acceptedQueueIdsForReconciliation(
        in messages: [QueuedOutgoingMessage]
    ) -> [String] {
        messages.filter(\.isAwaitingExecutionConfirmation).map(\.id)
    }

    /// A matching USER proves persistence only. A following assistant may belong to the prior run.
    static func historyEvidence(
        for message: QueuedOutgoingMessage,
        in messages: [ChatMessage]
    ) -> OutgoingHistoryEvidence {
        let identities = Set([message.id, message.clientEventId, message.serverMessageId].compactMap { $0 })
        guard messages.contains(where: {
            $0.role == .user && !$0.identityKeys.isDisjoint(with: identities)
        }) else { return .absent }
        if messages.contains(where: {
            $0.role == .assistant && $0.sourceClientEventId.map(identities.contains) == true
        }) {
            return .executionStarted
        }
        return .persisted
    }
}

@Model
nonisolated final class QueuedOutgoingMessageRecord {
    @Attribute(.unique) var id: String
    /// Optional/defaulted so the existing SwiftData store can migrate in place.
    var clientEventId: String? = nil
    var sessionId: String
    var text: String
    var modelId: String?
    var agentMode: String?
    /// Optional/defaulted so the existing SwiftData store can migrate in place.
    var approvalMode: String? = nil
    var blocksData: Data?
    var statusRaw: String
    var attemptCount: Int
    var lastError: String?
    var serverMessageId: String? = nil
    var taskId: String? = nil
    var createdAt: Date
    var updatedAt: Date
    /// Optional/defaulted：旧队列记录无 Focus，按 nil 轻量迁移。
    var focusSnapshotData: Data? = nil

    init(
        id: String,
        clientEventId: String? = nil,
        sessionId: String,
        text: String,
        modelId: String?,
        agentMode: String?,
        approvalMode: String? = nil,
        blocksData: Data?,
        statusRaw: String,
        attemptCount: Int,
        lastError: String?,
        serverMessageId: String? = nil,
        taskId: String? = nil,
        createdAt: Date,
        updatedAt: Date,
        focusSnapshotData: Data? = nil
    ) {
        self.id = id
        self.clientEventId = clientEventId
        self.sessionId = sessionId
        self.text = text
        self.modelId = modelId
        self.agentMode = agentMode
        self.approvalMode = approvalMode
        self.blocksData = blocksData
        self.statusRaw = statusRaw
        self.attemptCount = attemptCount
        self.lastError = lastError
        self.serverMessageId = serverMessageId
        self.taskId = taskId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.focusSnapshotData = focusSnapshotData
    }

    func toQueuedMessage(permitsRelaxedApproval: Bool) -> QueuedOutgoingMessage {
        let focus = try? FocusSnapshot.decodeFromPersistenceIfPresent(focusSnapshotData)
        return QueuedOutgoingMessage(
            id: id,
            clientEventId: clientEventId ?? id,
            sessionId: sessionId,
            text: text,
            modelId: modelId,
            agentMode: agentMode,
            approvalMode: approvalMode,
            blocks: Self.decodeBlocks(blocksData),
            createdAt: createdAt,
            status: QueuedOutgoingMessageStatus(rawValue: statusRaw) ?? .waiting,
            attemptCount: attemptCount,
            lastError: lastError,
            serverMessageId: serverMessageId,
            taskId: taskId,
            permitsRelaxedApproval: permitsRelaxedApproval,
            focusSnapshot: focus
        )
    }

    static func encodeBlocks(_ blocks: [[String: Any]]?) -> Data? {
        guard let blocks, !blocks.isEmpty,
              JSONSerialization.isValidJSONObject(blocks) else { return nil }
        return try? JSONSerialization.data(withJSONObject: blocks)
    }

    private static func decodeBlocks(_ data: Data?) -> [[String: Any]]? {
        guard let data,
              let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              !value.isEmpty else { return nil }
        return value
    }
}

final class OutgoingMessageQueueStore: @unchecked Sendable {
    static let shared = OutgoingMessageQueueStore()

    private var container: ModelContainer?
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "OutgoingQueue")

    private init() {
        do {
            let schema = Schema([QueuedOutgoingMessageRecord.self])
            let url = URL.applicationSupportDirectory.appending(path: "TabtinOutgoingMessageQueue.store")
            let config = ModelConfiguration(schema: schema, url: url)
            container = try ModelContainer(for: schema, configurations: [config])
        } catch {
            print("[OutgoingMessageQueueStore] failed to create container: \(error)")
            container = nil
        }
    }

    @MainActor
    func messages(
        sessionId: String,
        permitsRelaxedApproval: Bool = false
    ) -> [QueuedOutgoingMessage] {
        guard let container else { return [] }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<QueuedOutgoingMessageRecord>(
            predicate: #Predicate { $0.sessionId == sessionId },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        do {
            let records = try context.fetch(descriptor)
            var didMigrateLegacyRecord = false
            let messages = records.map { record -> QueuedOutgoingMessage in
                let normalized = ConversationRuntimeConfiguration.normalizedForStorage(
                    agentMode: record.agentMode,
                    approvalMode: record.approvalMode
                )
                let shouldNormalizeMode = record.agentMode != normalized.agentMode.rawValue
                let shouldNormalizeApproval = record.approvalMode != normalized.approvalMode.rawValue
                if shouldNormalizeMode || shouldNormalizeApproval {
                    record.agentMode = normalized.agentMode.rawValue
                    record.approvalMode = normalized.approvalMode.rawValue
                    record.updatedAt = .now
                    didMigrateLegacyRecord = true
                }
                return record.toQueuedMessage(permitsRelaxedApproval: permitsRelaxedApproval)
            }
            if didMigrateLegacyRecord {
                do {
                    try context.save()
                } catch {
                    logPersistenceError(error, operation: "migrate_legacy", recordId: nil)
                }
            }
            return messages
        } catch {
            logPersistenceError(error, operation: "list", recordId: nil)
            return []
        }
    }

    @MainActor
    func insert(
        sessionId: String,
        text: String,
        modelId: String?,
        configuration: ConversationRuntimeConfiguration,
        blocks: [[String: Any]]?,
        status: QueuedOutgoingMessageStatus,
        focusSnapshot: FocusSnapshot? = nil
    ) -> QueuedOutgoingMessage? {
        let stableId = UUID().uuidString.lowercased()
        // Focus 编码失败不得静默丢字段：整条入队失败，避免重试时 Focus 蒸发。
        let focusData: Data?
        if let focusSnapshot {
            do {
                focusData = try FocusSnapshot.encodeForPersistence(focusSnapshot)
            } catch {
                logPersistenceError(error, operation: "encode_focus", recordId: nil)
                return nil
            }
        } else {
            focusData = nil
        }
        let item = QueuedOutgoingMessage(
            id: stableId,
            clientEventId: stableId,
            sessionId: sessionId,
            text: text,
            modelId: modelId,
            agentMode: configuration.agentMode.rawValue,
            approvalMode: configuration.approvalMode.rawValue,
            blocks: blocks,
            createdAt: .now,
            status: status,
            attemptCount: 0,
            lastError: nil,
            serverMessageId: nil,
            taskId: nil,
            permitsRelaxedApproval: true,
            focusSnapshot: focusSnapshot
        )
        guard let container else { return nil }
        let context = ModelContext(container)
        context.insert(QueuedOutgoingMessageRecord(
            id: item.id,
            clientEventId: item.clientEventId,
            sessionId: item.sessionId,
            text: item.text,
            modelId: item.modelId,
            agentMode: item.agentMode.rawValue,
            approvalMode: item.approvalMode.rawValue,
            blocksData: QueuedOutgoingMessageRecord.encodeBlocks(item.blocks),
            statusRaw: item.status.rawValue,
            attemptCount: item.attemptCount,
            lastError: item.lastError,
            serverMessageId: item.serverMessageId,
            taskId: item.taskId,
            createdAt: item.createdAt,
            updatedAt: .now,
            focusSnapshotData: focusData
        ))
        do {
            try context.save()
        } catch {
            logPersistenceError(error, operation: "insert", recordId: item.id)
            return nil
        }
        return item
    }

    @MainActor
    func updateStatus(
        id: String,
        status: QueuedOutgoingMessageStatus,
        error: String? = nil,
        incrementAttempt: Bool = false
    ) {
        guard let container else { return }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<QueuedOutgoingMessageRecord>(
            predicate: #Predicate { $0.id == id }
        )
        let record: QueuedOutgoingMessageRecord
        do {
            guard let fetched = try context.fetch(descriptor).first else { return }
            record = fetched
        } catch {
            logPersistenceError(error, operation: "update_status_fetch", recordId: id)
            return
        }
        record.statusRaw = status.rawValue
        record.lastError = error
        if incrementAttempt { record.attemptCount += 1 }
        record.updatedAt = .now
        do {
            try context.save()
        } catch {
            logPersistenceError(error, operation: "update_status_save", recordId: id)
        }
    }

    @MainActor
    func recordDelivery(
        id: String,
        status: QueuedOutgoingMessageStatus,
        clientEventId: String,
        serverMessageId: String?,
        taskId: String?,
        error: String? = nil
    ) {
        guard let container else { return }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<QueuedOutgoingMessageRecord>(
            predicate: #Predicate { $0.id == id }
        )
        let record: QueuedOutgoingMessageRecord
        do {
            guard let fetched = try context.fetch(descriptor).first else { return }
            record = fetched
        } catch {
            logPersistenceError(error, operation: "record_delivery_fetch", recordId: id)
            return
        }
        record.clientEventId = clientEventId
        record.serverMessageId = serverMessageId ?? record.serverMessageId
        record.taskId = taskId ?? record.taskId
        record.statusRaw = status.rawValue
        record.lastError = error
        record.updatedAt = .now
        do {
            try context.save()
        } catch {
            logPersistenceError(error, operation: "record_delivery_save", recordId: id)
        }
    }

    @MainActor
    func delete(id: String) {
        guard let container else { return }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<QueuedOutgoingMessageRecord>(
            predicate: #Predicate { $0.id == id }
        )
        let records: [QueuedOutgoingMessageRecord]
        do {
            records = try context.fetch(descriptor)
        } catch {
            logPersistenceError(error, operation: "delete_fetch", recordId: id)
            return
        }
        for record in records { context.delete(record) }
        do {
            try context.save()
        } catch {
            logPersistenceError(error, operation: "delete_save", recordId: id)
        }
    }

    private func logPersistenceError(_ error: Error, operation: String, recordId: String?) {
        let nsError = error as NSError
        let shortRecordId = recordId.map { String($0.prefix(8)) } ?? "none"
        logger.error(
            "queue_store_error operation=\(operation, privacy: .public) record=\(shortRecordId, privacy: .public) domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)"
        )
    }

}

/// 单个会话的视图模型（**不锁单通道**模型）。
///
/// 设计取向（取代旧「runner 独占本轮 + observer 旁观」双通道）：
/// 进会话即对本会话 stream topic 开**一条常驻订阅**，把**所有** `agent.stream.*` 事件
/// （本机发的、别端发的，一视同仁）经**同一个** reducer 折叠成 `StreamUpdate`，投进同一
/// `ConversationProjector`。发送变成 **fire-and-forget**：落乐观气泡 + 发 `chat.send_message`，
/// 真正的 Agent 轮次（本轮或被后端排队后才跑的轮次）由常驻通道渲染——不依赖「本端独占一条流」。
///
/// 为什么不锁：WS 下行事件顺序/相位本就乱（`done` 之后还会来更高 `_seq` 的 `lifecycle(end)`、
/// `message_persisted` 等），靠状态机精确判定「别端轮次边界」来置灰输入既脆弱又易闪。后端
/// `ChatService` 对每会话本就是 Redis 锁 + 排队（`HELD_BY_OTHER → enqueue`），数据层并发安全，
/// 故客户端不锁、随时可发，渲染交给单通道 + HTTP 对账兜底。
///
/// `isStreaming` 直接派生自 `projector.isStreamingActive`（气泡级，可靠），不再维护独立的
/// 「轮次进行中」状态机——彻底消除 relight/闪烁问题。
@MainActor
@Observable
final class ConversationViewModel {
    /// 首屏 / 刷新拉「最新一页」用的游标占位 id。
    /// 后端 `GET /chat/sessions/{id}/messages?before=<id>` 在 id 不存在时跳过时间过滤，
    /// 等价于 `order_by(-created_at)[:limit]` 再 reverse → 返回**最近 N 条**（页内仍旧→新）。
    /// 不传 `before` 则走默认 offset 分页 `order_by(created_at)[0:limit]`，拉到的是**最旧 N 条**——
    /// 长会话进去看不到最新消息。对齐旧版 iOS / Electron 首屏期望；上拉加载更早消息用真实 `before=<oldestId>`。
    static let latestPageBeforeCursor = "00000000-0000-0000-0000-000000000000"

    let sessionId: String
    /// 仅用于 Sentry `space_id` tag（ 契约 D 节）；不参与业务逻辑。
    private let workspaceId: String?
    private let organizationId: String?
    private var shareId: String?
    private let isReadOnly: Bool
    /// Project 审批只接受 agent.stream.approval_requested 新协议；旧 action
    /// approval 缺 execution owner / 脱敏契约，只保留给个人会话兼容。
    private let isProjectSession: Bool
    private let threadId: String
    private let topic: String

    /// 纯投射器：每条 StreamUpdate 按序立即 apply（保证顺序/数据正确），但不直接被 UI 观察。
    /// 标 @ObservationIgnored，避免高频 delta 逐 token 触发 SwiftUI 重渲染；对 UI 走 publishNow / 节流。
    @ObservationIgnored private var projector = ConversationProjector()

    /// UI 观察的快照：由 projector 节流发布而来（非每 token 直读）。
    private(set) var messages: [ChatMessage] = []
    /// 末条消息的引用型展示模型。纯文本 delta 只改其正文叶子，不重发 `messages` 整数组。
    private(set) var tipRowModel: MessageRowModel?
    /// 末条正文 leaf 变化后通知 UIKit 列表重新测量对应 cell 高度。
    private(set) var tipRowLayoutRevision = 0
    private(set) var phase: String?
    private(set) var systemNotice: String?
    /// 任意轮次（本机/别端）正在流式：派生自 projector，仅用于 UI 提示（typing 光标），**不锁输入**。
    private(set) var isStreaming = false
    /// Runtime 真实下发的上下文压力与压缩状态；UI 不做 token 估算，只按此快照展示。
    private(set) var contextRuntimeState = ContextRuntimeState()
    /// 历史回放加载态。
    private(set) var isLoadingHistory = false
    /// 是否还有更早的历史可上拉加载（来自历史接口的 `has_more`）。
    private(set) var hasMoreEarlier = false
    /// 正在上拉加载更早历史（顶部转圈 + 防重入）。
    private(set) var isLoadingEarlier = false
    /// 每成功前插一页更早历史自增 → 通知滚动视图保持顶部锚点（不跳位）。
    private(set) var earlierPrependToken = 0
    /// 当前 Composer 的默认运行配置。每次实际发送都会再次夹到组织当前的安全上限，
    /// 并在入队时冻结到 `QueuedOutgoingMessage`。
    private(set) var runtimeConfiguration = ConversationRuntimeConfiguration()
    /// ：本地刚改过 agent_mode 的短脏窗口，期间 GET 不以服务端覆盖。
    @ObservationIgnored private var agentModeLocalDirtyUntil: Date?
    @ObservationIgnored private var agentModeSyncGeneration: Int = 0
    private static let agentModeLocalDirtyWindow: TimeInterval = 15
    var agentMode: String { runtimeConfiguration.agentMode.rawValue }
    var approvalMode: String { runtimeConfiguration.approvalMode.rawValue }
    /// Composer 当前选中的执行 Agent；乐观 assistant 占位写入此 id，头像不必等 message_start。
    var executionAgentId: String?
    /// 提案动作 / 发送失败文案，UI 顶部提示。
    private(set) var actionError: String?
    /// 流进行中传输断开、正在重连：UI 顶部 banner。
    private(set) var connectionInterrupted = false
    /// 只在真实断线后的恢复链路中变化。它把「传输已恢复」和「HTTP 历史已核对」拆开，
    /// 初次正常进入会话保持 `.idle`，不把例行加载伪装成恢复成功。
    private(set) var recoveryState: ConversationRecoveryState = .idle
    /// 本机有一轮可取消的在跑任务（拿到了 task_id）：UI 在输入为空时显示「停止」。
    private(set) var canCancel = false
    /// `canCancel` 从 false 变为 true 的时刻；用来挡住发送键就地变成停止的误触。
    @ObservationIgnored private var canCancelArmedAt: Date?
    var elapsedSinceCanCancel: TimeInterval? {
        canCancelArmedAt.map { Date.now.timeIntervalSince($0) }
    }
    /// 服务端会话级运行事实。用于冷启动/别端发起轮次时补足 header 与 Stop；
    /// 消息气泡是否 streaming 仍只由 projector 决定。
    private(set) var authoritativeRunState: SessionRunState?
    private(set) var authoritativeReadState: SessionReadState?
    var authoritativeRunStatus: SessionRunStatus? { authoritativeRunState?.status }
    /// 协作式暂停状态；当前步骤完成后在下一轮推理前挂起。
    private(set) var isPaused = false
    private(set) var pauseControlPending = false
    /// 停止请求的确认状态；ACK 仅表示服务端接收请求，终态仍须由 stream 回流。
    private(set) var stopRequestState: ConversationStopRequestState = .idle
    /// 供 Composer 在请求尚未得到 ACK 时展示进度并防止重复提交。
    var cancelControlPending: Bool { stopRequestState == .requesting }

    /// 阻断类 HITL 协调器（审批 / AskUser / ask_form / requestApproval）。
    let hitl: HITLCoordinator

    /// 会话内联卡片与独立详情页共用的子 Agent 运行列表（session 级，按 runId 聚合）。
    private(set) var subagentRuns: [SubagentRun] = []
    /// 已发出 `subagent.cancel` 但终态尚未回流的子 Agent run id 集合——UI 据此把 stop
    /// 按钮切成「取消中…」，避免用户重复点；终态（completed/failed/cancelled）回流即清。
    private(set) var cancellingSubagentRunIds: Set<String> = []
    /// Agent 当前待办清单（agent.stream.todo）。
    private(set) var todoItems: [AgentTodoItem] = []
    /// 计费 / 成员额度阻断。
    private(set) var billingBlockedTitle: String?
    private(set) var billingBlockedMessage: String?
    /// 当前会话的本地待发送队列。流式中/离线时先保存在这里，下次可发送时 FIFO flush。
    private(set) var queuedOutgoingMessages: [QueuedOutgoingMessage] = []

    private let gateway: RealtimeGateway
    private let outgoingQueue = OutgoingMessageQueueStore.shared
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "Conversation")
    private let inactiveStreamTopicRetainDuration: Duration = .seconds(90)

    // MARK: - 单通道 ingest 状态
    @ObservationIgnored private var decoder = WireDecoder()
    /// 当前 run 的 reducer。后端每个 run 把 `_seq` 从 1 重置，故跨 run（seq==1）换新 reducer。
    @ObservationIgnored private var reducer = StreamSession()
    /// 子 Agent 内层 transcript reducer：每个 runId 独立一份，避免 content_block index 与主会话互相污染。
    @ObservationIgnored private var subagentDecoder = WireDecoder()
    @ObservationIgnored private var subagentReducers: [String: StreamSession] = [:]
    /// 本通道已应用的最大 `_seq`（线程内单调）。seq==1=新 run 重置基线；<=已应用即丢（重连补发/重排）。
    @ObservationIgnored private var lastSeq: Int?
    /// 从本轮 message_start 取得的权威 model_id；DONE 只刷新它的专项点券投影。
    @ObservationIgnored private var activeRunModelId: String?
    private var listening = false
    private var listenerKey: String { "chat-\(sessionId)" }
    private var pendingInteractionListenerKey: String { "\(listenerKey)-pending-interactions" }

    // MARK: - 本机发送跟踪（fire-and-forget）
    /// 本机最近一轮的 task_id（cancel 用）；排队场景 ack 回 nil。
    @ObservationIgnored private var myTaskId: String?
    /// 当前真正交给 runtime 的本机消息。Composer Stop 用它判断「只停答」还是
    /// 「撤回并回填」，不从最后一条 user 猜测，避免把别端消息误当成本机草稿。
    @ObservationIgnored private var activeSubmittedMessage: ActiveSubmittedMessage?
    /// Stop 后旧 run 仍可能回流尾部事件；本机已乐观收口期间统一丢弃，直到终态或宽限结束。
    @ObservationIgnored private var discardingCancelledRun = false
    /// 已取消 run 的稳定关联键。取消 ACK 后允许下一条立即发送，但旧 run 的迟到尾事件
    /// 仍须按 source/task 精确丢弃，不能误把下一轮 assistant 占位收尾。
    @ObservationIgnored private var cancelledRunIdentity: ConversationCancelledRunIdentity?
    /// 未答轮次撤回的终态对账门控。
    /// 与 `discardingCancelledRun` 协同：后者只管丢弃旧 run 尾事件；本字段在
    /// `withdraw_applied=true` 时豁免 `scheduleTerminalReconcile`→`refreshHistoryFull`，
    /// 避免权威历史把本地已撤轮次拉回。`false` / 字段缺失 / 超时则清回 idle 走现状。
    /// 不在 `clearMySendTracking` 里清——`finishCancelledRunTail` 会先 clear 再决定是否对账。
    @ObservationIgnored private var withdrawReconcileGate: WithdrawTerminalReconcileGate = .idle
    @ObservationIgnored private var sendWatchdog: Task<Void, Never>?
    @ObservationIgnored private var acceptedReconcileTask: Task<Void, Never>?
    @ObservationIgnored private var recoveryReconcileTask: Task<Void, Never>?
    @ObservationIgnored private var recoverySyncedDismissTask: Task<Void, Never>?
    @ObservationIgnored private var pendingUnattributedExecutionEvidenceClientId: String?
    @ObservationIgnored private var flushingQueueItemIds: Set<String> = []
    @ObservationIgnored private var sendingOutgoing = false
    /// 让旧的 pause/resume/cancel ACK 无法覆盖更新后的控制意图。
    @ObservationIgnored private var runControlGeneration = 0
    /// Plan 的产品级幂等键：同一会话同一 plan 同时只允许一个入队事务。
    @ObservationIgnored private var activePlanExecutionKeys: Set<String> = []
    @ObservationIgnored private var acceptedPlanExecutionKeys: Set<String> = []
    private let sendWatchdogTimeout: Duration = .seconds(40)

    // MARK: - 性能基线（DEBUG 度量，见 PerfTrace）
    /// 当前是否已为本轮流式开了 PerfTrace 窗口（首 delta 开 → done/error 收）。
    @ObservationIgnored private var streamWindowOpen = false

    // MARK: - 节流 / 对账
    private enum PublishScope {
        case textLeaves
        case structure
    }

    @ObservationIgnored private var publishTask: Task<Void, Never>?
    @ObservationIgnored private var pendingPublishScope: PublishScope?
    @ObservationIgnored private var scheduledPublishDelay: Duration?
    /// 对齐 Electron rAF 批写量级（~16ms@60Hz）；40ms 会让短回复出现明显「慢一拍」。
    private let publishInterval: Duration = .milliseconds(16)
    /// thinking 往往比正文更密、更长；单独拉长合并窗口，减轻整列 rebuild 压力。
    private let thinkingPublishInterval: Duration = .milliseconds(48)
    /// 本轮检测到 `_seq` 跳号（resume 没补上）：收尾时从 HTTP 重拉历史整体校正。
    @ObservationIgnored private var pendingSeqGapReconcile = false
    @ObservationIgnored private var reconcileTask: Task<Void, Never>?
    @ObservationIgnored private var readAckTask: Task<Void, Never>?
    @ObservationIgnored private var hasHydratedServerHistory = false
    /// 后端返回的稳定同步水位；有水位时，轮次收尾 / 重连对账优先按 updated_at 增量补齐。
    @ObservationIgnored private var historySyncWatermark: String?

    // MARK: - 本地缓存（offline-first）
    @ObservationIgnored private let cache = MessageCacheStore.shared
    /// 列表当前仅由本地缓存播种、尚未被 HTTP 权威态对账：用于让 `loadHistory` 在「已显缓存」时
    /// 仍继续拉网并整体校正（而非因非空直接 bail）。
    @ObservationIgnored private var seededFromCacheOnly = false

    init(
        sessionId: String,
        workspaceId: String? = nil,
        organizationId: String? = nil,
        projectId: String? = nil,
        shareId: String? = nil,
        isReadOnly: Bool = false,
        gateway: RealtimeGateway = .shared
    ) {
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.organizationId = organizationId
        let normalizedShareId = shareId?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.shareId = normalizedShareId?.isEmpty == false ? normalizedShareId : nil
        self.isReadOnly = isReadOnly
        self.isProjectSession = projectId?.isEmpty == false
        self.gateway = gateway
        self.threadId = "chat-session-\(sessionId)"
        self.topic = "\(AgentStreamEvent.prefix)chat-session-\(sessionId)"
        self.hitl = HITLCoordinator(sessionId: sessionId)
    }

    private var subscriptionTopics: [String] {
        var topics = [topic]
        if let organizationId = WorkspaceStore.shared.selectedOrganizationId {
            topics.append("billing.events.\(organizationId)")
        }
        return topics
    }

    private var subscriptionTopicContexts: [String: [String: Any]] {
        guard let shareId else { return [:] }
        return [topic: ["share_id": shareId]]
    }

    /// 共享卡可能在消息投影更新后轮换到同一任务的最新授权；阅读器更新授权后，
    /// 后续历史、实时订阅都必须携带新的 share_id，不能继续使用卡片里的旧快照。
    func updateSharedAccess(shareId: String) {
        let normalized = shareId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        self.shareId = normalized
    }

    static func historyQuery(
        _ query: [String: String],
        shareId: String?
    ) -> [String: String] {
        var expanded = query
        expanded["expand_artifacts"] = "true"
        if let shareId { expanded["share_id"] = expanded["share_id"] ?? shareId }
        return expanded
    }

    private func historyQuery(_ query: [String: String]) -> [String: String] {
        Self.historyQuery(query, shareId: shareId)
    }

    // MARK: - 会话生命周期

    /// 进会话：连接 → 订阅本会话 stream topic → 挂常驻监听 + 断线/重连回调 → 回放历史。
    /// 之后所有事件（本机/别端）都经 `handleEnvelope` 单通道渲染。
    func startSession() async {
        guard !listening else { return }
        resetRecoveryStateForSessionLifecycle()
        listening = true
        reducer = StreamSession()
        contextRuntimeState = reducer.contextRuntimeState
        lastSeq = nil
        clearAgentModeLocalDirty()
        agentModeSyncGeneration &+= 1
        restoreRuntimeConfiguration()
        SentryContextProvider.shared.setActiveSpace(workspaceId)

        gateway.addEnvelopeListener(key: listenerKey) { [weak self] env in self?.handleEnvelope(env) }
        PendingInteractionStore.shared.addUpdateListener(key: pendingInteractionListenerKey) { [weak self] update in
            self?.handlePendingInteractionUpdate(update)
        }
        gateway.onConnectionDropped = { [weak self] in self?.handleConnectionDropped() }
        gateway.onReconnected = { [weak self] in self?.handleReconnected() }

        if isReadOnly {
            await loadHistory()
            _ = await gateway.ensureConnected()
            _ = await gateway.subscribeAndWait(
                [topic],
                topicContexts: subscriptionTopicContexts
            )
            return
        }

        reloadOutgoingQueue()
        Task { await SessionReadStore.shared.flush() }
        async let controlStateResult = refreshSessionControlState()
        // 进会话先用本地缓存即时播种（首帧不空白，offline-first），再走 HTTP 权威对账。
        seedFromCache()
        // 再回放历史（GET 空也无害），再确保订阅就绪——live 事件晚于 history seed，避免被跳过。
        await loadHistory()
        let controlReady = await controlStateResult
        _ = await gateway.ensureConnected()
        _ = await gateway.subscribeAndWait(subscriptionTopics)
        // latest history 只会覆盖最近一页；其余 accepted 必须逐条用稳定标识 around 对账，
        // 不能只恢复最后一条，否则较早的 ACK 会永久留在本地队列。
        // 放在订阅完成后，避免历史恢复请求延迟 live 通道建立。
        await reconcileAllAcceptedOutgoingOnSessionStart()
        // P1-2：先完成权威 HITL hydration（controlState 已在上方 await），再开放 auto-drain，
        // 避免冷启动越过待确认/待回答。顺序见 SessionAutoDrainSequence.beforeAutoDrain。
        // 任一步失败 fail-closed：禁止把网络错误当成「无 HITL / 未暂停」后 drain。
        let hitlReady = await hydratePendingInteractions()
        if SessionAutoDrainSequence.allowsAutoDrain(
            controlState: controlReady,
            hitlHydration: hitlReady
        ) {
            drainOutgoingQueueIfPossible()
        }
    }

    /// 离开会话：移除监听 + 清回调 + 取消看门狗 / 对账，并释放本会话 stream 订阅。
    /// 若当前仍在流式，短暂保留 topic：终态事件会提前退订，超时后由 gateway 兜底退订。
    func stopSession() {
        // A delayed control task may still be waiting for the gateway to
        // reconnect. It must not send after this screen has stopped observing
        // the session.
        invalidateRunControlRequests()
        guard listening else { return }
        listening = false
        SentryContextProvider.shared.clearActiveSpace()
        if projector.isStreamingActive {
            gateway.unsubscribeAfterDelay([topic], delay: inactiveStreamTopicRetainDuration)
        } else {
            gateway.unsubscribe([topic])
        }
        gateway.removeEnvelopeListener(key: listenerKey)
        PendingInteractionStore.shared.removeUpdateListener(key: pendingInteractionListenerKey)
        gateway.onConnectionDropped = nil
        gateway.onReconnected = nil
        sendWatchdog?.cancel(); sendWatchdog = nil
        acceptedReconcileTask?.cancel(); acceptedReconcileTask = nil
        recoveryReconcileTask?.cancel(); recoveryReconcileTask = nil
        recoverySyncedDismissTask?.cancel(); recoverySyncedDismissTask = nil
        recoveryState = .idle
        connectionInterrupted = false
        reconcileTask?.cancel(); reconcileTask = nil
        readAckTask?.cancel(); readAckTask = nil
        publishTask?.cancel(); publishTask = nil
        pendingPublishScope = nil
        scheduledPublishDelay = nil
        flushingQueueItemIds.removeAll()
    }

    /// 协作发言通过 shared-chat HTTP 端点落库后，主动拉一页权威历史，
    /// 避免移动端只依赖实时流而错过刚刚提交的消息。
    func refreshSharedHistory(limit: Int = 50) async {
        guard isReadOnly else { return }
        do {
            let page = try await loadLatestMainTimelinePage(limit: limit)
            guard !projector.isStreamingActive else { return }
            let mapped = page.messages
            hasMoreEarlier = page.response.hasMore ?? false
            _ = projector.replaceWithHistory(mapped)
            seededFromCacheOnly = false
            hasHydratedServerHistory = true
            cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            publishNow()
        } catch {
            logger.warning("shared history refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - 历史回放

    /// 用本地缓存即时播种（主线程同步读，首帧不空白）。仅当前为空且未在流式时生效。
    private func seedFromCache() {
        guard projector.messages.isEmpty, !projector.isStreamingActive else { return }
        let cached = cache.getCachedMessages(sessionId: sessionId)
        guard !cached.isEmpty else { return }
        projector.seed(cached)
        seededFromCacheOnly = true
        publishNow()
    }

    /// 拉取会话历史并播种 / 对账消息列表。失败重试一次（进会话「显示消息」主路径）。
    /// 已被本地缓存播种时仍继续拉网：成功则用服务端权威态整体替换缓存内容（reconcile）。
    func loadHistory(limit: Int = 50) async {
        guard !projector.isStreamingActive else { return }
        guard projector.messages.isEmpty || seededFromCacheOnly else { return }
        isLoadingHistory = projector.messages.isEmpty
        defer { isLoadingHistory = false }
        for attempt in 0..<2 {
            do {
                let page = try await loadLatestMainTimelinePage(limit: limit)
                guard !projector.isStreamingActive else { return }
                let mapped = page.messages
                confirmAcceptedOutgoing(from: mapped)
                if let serverTimestamp = page.response.serverTimestamp, !serverTimestamp.isEmpty {
                    historySyncWatermark = serverTimestamp
                }
                hasMoreEarlier = page.response.hasMore ?? false
                let didChange: Bool
                if projector.messages.isEmpty {
                    projector.seed(mapped)
                    didChange = !mapped.isEmpty
                } else if seededFromCacheOnly {
                    // 缓存播种态 → 用服务端权威历史校正（含别端在离线期间产生的新消息）。
                    // replaceWithHistory 内部内容全等时不动数组 → 一致则不重渲染，缓存秒显后不再闪。
                    didChange = projector.replaceWithHistory(mapped)
                } else {
                    didChange = false
                }
                seededFromCacheOnly = false
                if didChange {
                    publishNow()
                    cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
                }
                restoreTodoItemsFromHistory(projector.messages)
                reconcileSubagentRunsFromHistory(
                    messages: projector.messages,
                    historyDTOs: page.rawDTOs
                )
                hasHydratedServerHistory = true
                acknowledgeReadIfContentHydrated()
                return
            } catch {
                logger.warning("load history failed (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
                if attempt == 0 { try? await Task.sleep(for: .milliseconds(800)) }
            }
        }
    }

    private struct HistoryPageLoad {
        let response: MessageHistoryResponse
        let messages: [ChatMessage]
        /// 翻页过程中累积的原始 DTO（含子 Agent 行），供冷启动 rehydrate。
        let rawDTOs: [SessionMessageDTO]
    }

    private func loadLatestMainTimelinePage(limit: Int) async throws -> HistoryPageLoad {
        var cursor = Self.latestPageBeforeCursor
        var collectedDTOs: [SessionMessageDTO] = []
        while true {
            let resp: MessageHistoryResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionMessages(sessionId),
                query: historyQuery(["limit": String(limit), "before": cursor])
            )
            collectedDTOs.append(contentsOf: resp.messages)
            let mapped = MessageHistoryMapper.map(resp.messages)
            guard mapped.isEmpty,
                  resp.hasMore == true,
                  !resp.messages.isEmpty,
                  let nextCursor = resp.oldestId,
                  nextCursor != cursor else {
                return HistoryPageLoad(response: resp, messages: mapped, rawDTOs: collectedDTOs)
            }
            cursor = nextCursor
        }
    }

    /// ：HTTP 历史恢复子 Agent 卡与详情 transcript（对齐 Electron archive reconcile）。
    private func reconcileSubagentRunsFromHistory(
        messages: [ChatMessage],
        historyDTOs: [SessionMessageDTO]
    ) {
        let merged = SubagentHistoryRehydration.reconcile(
            existing: subagentRuns,
            messages: messages,
            historyDTOs: historyDTOs
        )
        guard merged != subagentRuns else { return }
        subagentRuns = merged
        publishNow()
    }

    /// 每次进入会话 / 轮次收尾后从 HTTP 拉最新消息并 reconcile（含别端在本机离开期间产生的新消息）。
    /// 用服务端为准整体校正：保留本地 proposal 卡，按 createdAt 重排。仅非流式时执行（让位给 live 流）。
    func refreshHistory(limit: Int = 50) async {
        _ = await refreshHistorySucceeded(limit: limit)
    }

    /// 回退 / 撤销回退会重写时间线，不能走增量水位或“保留已分页旧消息”的普通合并。
    /// 用服务端最新页直接替换当前投影，确保已截断消息无需退出会话即可消失。
    @discardableResult
    func refreshHistoryAfterTimelineRewrite(limit: Int = 50) async -> Bool {
        guard !projector.isStreamingActive else {
            logger.warning("refresh rewritten history blocked while stream is active")
            return false
        }
        do {
            let page = try await loadLatestMainTimelinePage(limit: limit)
            guard !projector.isStreamingActive else {
                logger.warning("refresh rewritten history superseded by an active stream")
                return false
            }
            hasMoreEarlier = page.response.hasMore ?? false
            confirmAcceptedOutgoing(from: page.messages)
            let didChange = projector.replaceWithFocusedHistory(page.messages)
            if let serverTimestamp = page.response.serverTimestamp, !serverTimestamp.isEmpty {
                historySyncWatermark = serverTimestamp
            } else {
                historySyncWatermark = nil
            }
            seededFromCacheOnly = false
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: page.rawDTOs
            )
            return true
        } catch {
            logger.warning("refresh rewritten history failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    @discardableResult
    private func refreshHistorySucceeded(
        limit: Int = 50,
        forceFull: Bool = false,
        advanceWatermark: Bool = true,
        allowWhileStreaming: Bool = false
    ) async -> Bool {
        if projector.isStreamingActive && !allowWhileStreaming { return true }
        if forceFull {
            return await refreshHistoryFull(
                limit: limit,
                advanceWatermark: advanceWatermark,
                allowWhileStreaming: allowWhileStreaming
            )
        }
        if let watermark = historySyncWatermark, !watermark.isEmpty, !projector.messages.isEmpty {
            return await refreshHistoryIncremental(
                updatedAfter: watermark,
                limit: 100,
                allowWhileStreaming: allowWhileStreaming
            )
        }
        do {
            let page = try await loadLatestMainTimelinePage(limit: limit)
            if projector.isStreamingActive && !allowWhileStreaming { return true }
            confirmAcceptedOutgoing(from: page.messages)
            if let serverTimestamp = page.response.serverTimestamp, !serverTimestamp.isEmpty {
                historySyncWatermark = serverTimestamp
            }
            hasMoreEarlier = page.response.hasMore ?? false
            // 内容全等时 replaceWithHistory 返回 false → 跳过 publish/缓存写，避免无谓重渲染（不闪）。
            let didChange = projector.replaceWithHistory(
                page.messages,
                allowWhileStreaming: allowWhileStreaming
            )
            seededFromCacheOnly = false
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: page.rawDTOs
            )
            return true
        } catch {
            logger.warning("refresh history failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func refreshHistoryIncremental(
        updatedAfter: String,
        limit: Int,
        allowWhileStreaming: Bool = false
    ) async -> Bool {
        var offset = 0
        var syncWatermark: String?
        var changedMessages: [SessionMessageDTO] = []

        do {
            while true {
                var query = [
                    "limit": String(limit),
                    "updated_after": updatedAfter
                ]
                if offset > 0 { query["offset"] = String(offset) }
                if let syncWatermark { query["updated_before"] = syncWatermark }

                let resp: MessageHistoryResponse = try await APIClient.shared.get(
                    path: Endpoints.Chat.sessionMessages(sessionId),
                    query: historyQuery(query)
                )
                if projector.isStreamingActive && !allowWhileStreaming { return true }

                if syncWatermark == nil {
                    guard let serverTimestamp = resp.serverTimestamp, !serverTimestamp.isEmpty else {
                        // 兼容旧后端：没有稳定水位时不能把 updated_after 响应当完整事实。
                        historySyncWatermark = nil
                        return await refreshHistoryFull(
                            limit: 50,
                            allowWhileStreaming: allowWhileStreaming
                        )
                    }
                    syncWatermark = serverTimestamp
                }

                changedMessages.append(contentsOf: resp.messages)
                if resp.hasMore != true || resp.messages.isEmpty { break }
                offset += resp.messages.count
            }

            if let syncWatermark { historySyncWatermark = syncWatermark }
            let mapped = MessageHistoryMapper.map(changedMessages)
            confirmAcceptedOutgoing(from: mapped)
            let didChange = projector.mergeHistoryDelta(mapped, allowWhileStreaming: allowWhileStreaming)
            seededFromCacheOnly = false
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: changedMessages
            )
            return true
        } catch {
            logger.warning("incremental refresh history failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func refreshHistoryFull(
        limit: Int,
        advanceWatermark: Bool = true,
        allowWhileStreaming: Bool = false
    ) async -> Bool {
        do {
            let page = try await loadLatestMainTimelinePage(limit: limit)
            if projector.isStreamingActive && !allowWhileStreaming { return true }
            hasMoreEarlier = page.response.hasMore ?? false
            let mapped = page.messages
            confirmAcceptedOutgoing(from: mapped)
            let didChange = projector.replaceWithHistory(
                mapped,
                allowWhileStreaming: allowWhileStreaming
            )
            if let serverTimestamp = page.response.serverTimestamp,
               !serverTimestamp.isEmpty,
               advanceWatermark {
                historySyncWatermark = serverTimestamp
            }
            seededFromCacheOnly = false
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: page.rawDTOs
            )
            return true
        } catch {
            logger.warning("refresh history failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func refreshCommittedHistory(limit: Int = 50) async -> Bool {
        do {
            let page = try await loadLatestMainTimelinePage(limit: limit)
            hasMoreEarlier = page.response.hasMore ?? false
            confirmAcceptedOutgoing(from: page.messages)
            let didChange = projector.mergeCommittedHistory(page.messages)
            seededFromCacheOnly = false
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: page.rawDTOs
            )
            return true
        } catch {
            logger.warning("committed history refresh failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// 上拉加载更早一页历史：以当前最旧一条的服务端 id 为 `before` 游标，向更早翻页前插。
    /// 流式期间不翻页（让位 live）；`isLoadingEarlier` 防重入；前插成功自增 `earlierPrependToken`
    /// 让滚动视图保持顶部锚点（不跳位）。失败静默（顶部转圈消失，用户可再次上拉重试）。
    func loadEarlier(limit: Int = 30) async {
        guard hasMoreEarlier, !isLoadingEarlier, !projector.isStreamingActive else { return }
        guard var cursor = projector.oldestServerId else { return }
        isLoadingEarlier = true
        defer { isLoadingEarlier = false }
        do {
            while true {
                let resp: MessageHistoryResponse = try await APIClient.shared.get(
                    path: Endpoints.Chat.sessionMessages(sessionId),
                    query: historyQuery(["limit": String(limit), "before": cursor])
                )
                guard !projector.isStreamingActive else { return }
                let added = projector.prependHistory(MessageHistoryMapper.map(resp.messages))
                hasMoreEarlier = resp.hasMore ?? false
                if added > 0 {
                    earlierPrependToken += 1
                    publishNow()
                    cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
                    restoreTodoItemsFromHistory(projector.messages)
                    reconcileSubagentRunsFromHistory(
                        messages: projector.messages,
                        historyDTOs: resp.messages
                    )
                    return
                }
                guard hasMoreEarlier,
                      !resp.messages.isEmpty,
                      let nextCursor = resp.oldestId,
                      nextCursor != cursor else {
                    return
                }
                cursor = nextCursor
            }
        } catch {
            logger.warning("load earlier failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 定位外部入口指定的持久化消息。即使本地缓存存在，也用 around 向服务端确认消息
    /// 仍存在且当前用户可访问；请求次数不随消息年代增加。返回列表实际使用的稳定 row id。
    func focusMessage(_ messageId: String, limit: Int = 50) async -> String? {
        guard !messageId.isEmpty, !projector.isStreamingActive else { return nil }
        do {
            let response: MessageHistoryResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionMessages(sessionId),
                query: historyQuery(["limit": String(limit), "around": messageId])
            )
            guard !projector.isStreamingActive else { return nil }
            let focused = MessageHistoryMapper.map(response.messages)
            guard focused.contains(where: { $0.identityKeys.contains(messageId) }) else { return nil }
            _ = projector.replaceWithFocusedHistory(focused)
            hasMoreEarlier = response.hasMore ?? false
            seededFromCacheOnly = false
            publishNow()
            restoreTodoItemsFromHistory(projector.messages)
            reconcileSubagentRunsFromHistory(
                messages: projector.messages,
                historyDTOs: response.messages
            )
            return projector.messages.first(where: { $0.identityKeys.contains(messageId) })?.id
        } catch {
            logger.warning("focus message failed message=\(Self.shortId(messageId), privacy: .public)")
            return nil
        }
    }

    // MARK: - 单通道 ingest

    /// 单测入口：绕过 `startSession` 的网络副作用，直接走常驻 ingest。
    func ingestEnvelopeForTesting(_ env: WSEnvelope) {
        listening = true
        handleEnvelope(env)
    }

    /// 单测入口：立刻把 projector 快照刷到 `messages`（绕过 thinking/text 节流）。
    func flushPublishForTesting() {
        publishNow()
    }

    private func handleEnvelope(_ env: WSEnvelope) {
        guard listening else { return }
        if consumeAuthoritativeRunStateEnvelope(env) {
            return
        }
        if consumeReadStateEnvelope(env) {
            return
        }
        if AgentStreamEvent.shouldDropLegacyActionApproval(
            env.type,
            isProjectSession: isProjectSession
        ) {
            logger.warning("ignored legacy action approval in Project session")
            return
        }
        if env.type.hasPrefix("billing.") {
            handleBillingEnvelope(env)
            return
        }
        let isStreamEvent = env.type.hasPrefix(AgentStreamEvent.prefix)
        let isActionApprovalEvent = AgentStreamEvent.actionApprovalTypes.contains(env.type)
        guard (isStreamEvent || isActionApprovalEvent), envelopeBelongsToSession(env) else { return }

        // ：父 topic 上带 subagent_run_id 的 raw 流事件（含 thinking）必须尽早隔离——
        // 在 projectSessionRunState / 父 `_seq==1` 重置 / 主流 ingest 之前。
        // 对齐 Electron streamMessageHandler：绝不能进父时间线或父 run 态。
        if let isolated = SubagentStreamRouting.rewriteAsSubagentStreamEvent(env) {
            applySubagentStream(isolated)
            return
        }

        if isStreamEvent {
            projectSessionRunState(from: env)
        }

        if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.done)",
           let taskId = env.payloadString("task_id"), !taskId.isEmpty {
            completeOutgoingExecution(taskId: taskId)
        }
        if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.messageStart)",
           let sourceClientEventId = env.payloadString("source_client_event_id"),
           !sourceClientEventId.isEmpty {
            completeOutgoingExecution(clientEventId: sourceClientEventId)
        } else if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.messageStart)",
                  let taskId = myTaskId, !taskId.isEmpty {
            completeOutgoingExecution(taskId: taskId)
        }
        if let sourceClientEventId = env.payloadString("source_client_event_id"),
           !sourceClientEventId.isEmpty,
           env.type != "\(AgentStreamEvent.prefix)\(AgentStreamEvent.messageStart)",
           env.type != "\(AgentStreamEvent.prefix)\(AgentStreamEvent.user)" {
            completeOutgoingExecution(clientEventId: sourceClientEventId)
        }

        let isCancelledRunTerminal = env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.done)"
            || env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.persistError)"
        let belongsToCancelledRun = cancelledRunIdentity?.matches(
            sourceClientEventId: env.payloadString("source_client_event_id"),
            taskId: env.payloadString("task_id")
        ) == true
        if belongsToCancelledRun {
            if discardingCancelledRun && isCancelledRunTerminal {
                // done 可能先于 cancel.ok 到达；在此应用 withdraw_applied，供随后的
                // finishCancelledRunTail 决定是否豁免终态对账。
                if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.done)" {
                    noteWithdrawAppliedSignal(env.payloadBool("withdraw_applied"))
                }
                finishCancelledRunTail()
            }
            return
        }

        // seq 去重 / 跨 run 重置：后端每 run lifecycle(start) 把 _seq 重置回 1（_seq 在 payload 内，
        // 非 envelope 顶层，故读 payloadInt）。seq==1 ⇒ 新 run，换 fresh reducer + 重置基线。
        if isStreamEvent, let seq = env.payloadInt("_seq") {
            if seq == 1 {
                reducer = StreamSession()
                contextRuntimeState = reducer.contextRuntimeState
                lastSeq = 1
                activeRunModelId = nil
            } else if let last = lastSeq, seq <= last {
                return
            } else {
                if let last = lastSeq, seq > last + 1 {
                    // resume 也没补上的真实缺口：标记，收尾时 HTTP 整体校正。
                    pendingSeqGapReconcile = true
                }
                lastSeq = seq
            }
        }

        if isStreamEvent,
           OutgoingQueuePolicy.isUnattributedExecutionEvidence(
               eventType: env.type,
               sourceClientEventId: env.payloadString("source_client_event_id"),
               activeClientEventId: activeSubmittedMessage?.clientEventId
           ) {
            completeActiveOutgoingExecutionFromUnattributedStream()
        }

        if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.messageStart)" {
            activeRunModelId = env.payloadString("model_id")
        }

        // agent.stream.user（本机或别端发的用户消息）：WireDecoder 不解，这里直接投射成 user 气泡。
        // 本机自己发的 user 气泡 id=client_event_id，命中即去重（projector.appendObservedUserMessage）。
        if env.type == "\(AgentStreamEvent.prefix)\(AgentStreamEvent.user)" {
            let cid = env.payloadString("client_event_id") ?? env.payloadString("message_id") ?? env.eventId
            let content = env.payloadString("content") ?? env.payloadString("text")
            let triggeredBy = env.payloadString("triggered_by")
            // environment / agent-profile 都是 Runtime 注入给模型的内部 user-role
            // 上下文，绝不能投影成用户气泡。内容兜底同时清理旧 relay 把
            // agent_profile_context 错降为 llm 后留下的存量脏记录。
            if InternalUserContextVisibility.isHidden(
                messageKind: env.payloadString("message_kind"),
                text: content
            ) {
                return
            }
            // 纯子代理完成 push：对齐 Electron fold_into_card，主时间线不新增元素。
            if PushNotificationVisibility.shouldHideFromTimeline(
                triggeredBy: triggeredBy,
                text: content
            ) {
                return
            }
            if let cid, let content, !content.isEmpty {
                applyUpdate(.observedUserMessage(
                    id: cid,
                    text: content,
                    senderUserId: env.payloadString("sender_user_id"),
                    senderDisplayName: env.payloadString("sender_display_name"),
                    triggeredBy: triggeredBy
                ))
                confirmAcceptedOutgoing(clientEventId: cid)
            }
            return
        }

        let updates = reducer.ingest(decoder.decode(env))
        // context_pressure / compaction 不生成消息气泡，但必须与本轮 reducer 同步给 Composer。
        contextRuntimeState = reducer.contextRuntimeState
        for update in updates { applyUpdate(update) }
    }

    /// 投射 + 决定发布时机：高频 delta 攒批节流；其余事件立即发布。projector 始终按序立即 apply。
    private func applyUpdate(_ update: StreamUpdate) {
        switch update {
        case let .hitl(kind, envelope):
            handleHITL(kind: kind, envelope: envelope)
            return
        case let .subagent(event):
            applySubagent(event)
            return
        case let .subagentStream(event):
            applySubagentStream(event)
            return
        case let .todoUpdate(items):
            todoItems = items
            return
        case let .checkpointHealth(ok, sessionId):
            if !ok, let sessionId, sessionId == self.sessionId {
                actionError = "Checkpoint 创建失败，本轮之后可能无法完整回滚。"
            }
            return
        case .accepted, .connectionInterrupted, .connectionRestored, .sequenceGap:
            // 传输/ack 信号不落消息流（连接 banner / seq-gap 由本类驱动）。
            return
        case .messageStarted, .toolUseStarted, .toolUseFinalized, .toolResult,
             .richContent, .contextRef, .messageStop:
            projector.apply(update)
            // ：仅 role 缺失（旧 relay 兼容）或 role="assistant" 才把会话标为运行中。
            // 后台命令终态 relay 的合成 mini-message（role="user"）没有后续 done 事件，
            // 若照样标记会让会话在会话列表里一直「运行中」且无配对终态（对齐 projector
            // 不为它建气泡的口径）。
            if case let .messageStarted(_, _, role) = update, role == nil || role == "assistant" {
                RecentSessionsStore.shared.markRunStarted(sessionId: sessionId)
            }
            publishNow()
        case .appendText:
            projector.apply(update)
            // 性能基线：首个可见 token → TTFT；首 delta → 开流式窗口（累计主线程 maxStall）。
            PerfTrace.markFirstToken()
            if !streamWindowOpen, projector.isStreamingActive {
                streamWindowOpen = true
                PerfTrace.beginStreamWindow()
            }
            schedulePublish(scope: .textLeaves)
        case .citation:
            projector.apply(update)
            PerfTrace.markFirstToken()
            publishNow()
        case .thinking:
            projector.apply(update)
            PerfTrace.markFirstToken()
            if !streamWindowOpen, projector.isStreamingActive {
                streamWindowOpen = true
                PerfTrace.beginStreamWindow()
            }
            schedulePublish(scope: .structure, interval: thinkingPublishInterval)
        case .done, .error:
            projector.apply(update)
            settleRunControls()
            RecentSessionsStore.shared.markRunTerminal(
                sessionId: sessionId,
                failed: Self.isFailureTerminal(update)
            )
            clearMySendTracking()
            if streamWindowOpen {
                streamWindowOpen = false
                PerfTrace.endStreamWindow()
            }
            publishNow()
            // 轮次收尾即落盘当前快照（offline 兜底：HTTP 对账失败也保住本轮内容）；
            // 紧随的 scheduleReconcile 成功后会再用权威态整体替换。
            cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            if recoveryState == .reconciliationDeferredWhileStreaming {
                // 重连期间 live 仍在推进时，不能把未核对的内存态说成同步成功；等流结束后
                // 复用同一条 HTTP 对账链，结果仍以 refreshHistorySucceeded 为准。
                beginRecoveryReconciliation()
            } else if pendingSeqGapReconcile {
                pendingSeqGapReconcile = false
                scheduleTerminalReconcile(delaysMs: [0, 1_000, 3_000])
            } else {
                // 轮次收尾后从 HTTP 拉权威态校正（persistedId / 工具卡 / 富内容），对齐老 app scheduleServerSync。
                scheduleTerminalReconcile(delaysMs: [600, 1_600, 3_000])
            }
            drainOutgoingQueueIfPossible()
            if case let .done(_, errorInfo) = update,
               errorInfo == nil,
               let modelId = activeRunModelId {
                Task { await ChatModelStore.shared.refreshPromotionCredits(afterSettlingModelId: modelId) }
            }
            activeRunModelId = nil
        case .messageCommitted:
            projector.apply(update)
            publishNow()
            scheduleCommittedReconcile(delaysMs: [0, 1_000, 3_000])
        default:
            projector.apply(update)
            publishNow()
        }
    }

    private func schedulePublish(scope: PublishScope, interval: Duration? = nil) {
        let delay = interval ?? publishInterval

        switch (pendingPublishScope, scope) {
        case (.structure, _), (_, .structure):
            pendingPublishScope = .structure
        case (nil, .textLeaves):
            pendingPublishScope = .textLeaves
        case (.textLeaves, .textLeaves):
            break
        }

        if let currentDelay = scheduledPublishDelay, publishTask != nil {
            guard delay < currentDelay else { return }
            publishTask?.cancel()
        }
        scheduledPublishDelay = delay
        publishTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.flushScheduledPublish()
        }
    }

    private func flushScheduledPublish() {
        publishTask = nil
        scheduledPublishDelay = nil
        let scope = pendingPublishScope
        pendingPublishScope = nil
        if scope == .textLeaves {
            publishTextLeaves()
        } else {
            publishNow()
        }
    }

    /// 快路径只允许末条消息的正文字符串变化；检测到首个 text block、引用、终态或任何
    /// 结构漂移时立即退回完整发布，正确性仍由 projector 快照兜底。
    private func publishTextLeaves() {
        guard projector.messages.count == messages.count,
              let projectedTip = projector.messages.last,
              messages.last?.id == projectedTip.id,
              let tipRowModel,
              tipRowModel.id == projectedTip.id,
              tipRowModel.applyTextLeaves(from: projectedTip)
        else {
            publishNow()
            return
        }
        tipRowLayoutRevision += 1
        publishScalarState()
        PerfTrace.mark("conversation.publish.textLeaf(id=\(projectedTip.id))")
    }

    private func publishNow() {
        publishTask?.cancel()
        publishTask = nil
        pendingPublishScope = nil
        scheduledPublishDelay = nil

        let projectedMessages = projector.messages
        synchronizeTipRow(with: projectedMessages.last)
        if messages != projectedMessages {
            messages = projectedMessages
        }
        publishScalarState()
    }

    private func synchronizeTipRow(with message: ChatMessage?) {
        guard let message else {
            tipRowModel = nil
            return
        }
        if let tipRowModel, tipRowModel.id == message.id {
            tipRowModel.replaceStructure(with: message)
        } else {
            tipRowModel = MessageRowModel(message: message)
        }
    }

    private func publishScalarState() {
        if phase != projector.phase { phase = projector.phase }
        if systemNotice != projector.systemNotice { systemNotice = projector.systemNotice }
        let projectedStreaming = projector.isStreamingActive
        if isStreaming != projectedStreaming { isStreaming = projectedStreaming }
    }

    private func envelopeBelongsToSession(_ env: WSEnvelope) -> Bool {
        if let t = env.threadId { return t == threadId }
        if let t = env.payloadString("thread_id") { return t == threadId || t == sessionId }
        if let s = env.sessionId { return s == sessionId }
        if let s = env.payloadString("session_id") { return s == sessionId }
        if let tp = env.topic { return tp == topic }
        if let tp = env.payloadString("_topic") { return tp == topic }
        return true
    }

    // MARK: - 断线 / 重连（流不 teardown，常驻通道）

    private func handleConnectionDropped() {
        guard !connectionInterrupted else { return }
        connectionInterrupted = true
        recoveryReconcileTask?.cancel()
        recoverySyncedDismissTask?.cancel()
        transitionRecovery(to: .transportInterrupted)
        publishNow()
    }

    private func handleReconnected() {
        guard connectionInterrupted else { return }
        connectionInterrupted = false
        if ConversationRecoveryPolicy.shouldResetSeqCursor(connectedAfterDrop: true) {
            lastSeq = nil
            pendingSeqGapReconcile = false
        }
        publishNow()
        // 传输恢复并不代表 resume 没有缺口。先明确展示“已连接、正在核对”，只有
        // refreshHistorySucceeded 真正返回成功后才短暂显示“已同步”。
        beginRecoveryReconciliation()
        if isReadOnly { return }
        // P1-2：重连同样先刷新 paused/control + HITL，再开放 drain；失败 fail-closed。
        Task { @MainActor [weak self] in
            guard let self else { return }
            let controlReady = await self.refreshSessionControlState()
            let hitlReady = await self.hydratePendingInteractions()
            if SessionAutoDrainSequence.allowsAutoDrain(
                controlState: controlReady,
                hitlHydration: hitlReady
            ) {
                self.drainOutgoingQueueIfPossible()
            }
        }
        Task { await SessionReadStore.shared.flush() }
    }

    /// 对账失败后的用户入口；与自动恢复复用同一 HTTP 对账链，不伪造本地成功。
    func retryRecoveryReconciliation() {
        beginRecoveryReconciliation()
    }

    private func beginRecoveryReconciliation() {
        guard listening else { return }
        recoveryReconcileTask?.cancel()
        recoverySyncedDismissTask?.cancel()

        transitionRecovery(to: .reconciliationStarted)
        recoveryReconcileTask = Task { @MainActor [weak self] in
            guard let self else { return }
            var succeeded = false
            let delaysMs = [0, 1_600, 3_000]
            for (index, delayMs) in delaysMs.enumerated() {
                if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                guard !Task.isCancelled else { return }
                let lastAttempt = index == delaysMs.count - 1
                succeeded = await self.refreshHistorySucceeded(
                    forceFull: lastAttempt,
                    allowWhileStreaming: true
                )
                if succeeded && !self.projector.isStreamingActive { break }
            }
            guard !Task.isCancelled else { return }

            // 流式仍在画：权威页已兑过，但还不能宣称整段收束；等 terminal 再进本方法。
            guard !self.projector.isStreamingActive else {
                self.transitionRecovery(to: .reconciliationDeferredWhileStreaming)
                return
            }

            self.recoveryReconcileTask = nil
            if succeeded {
                self.transitionRecovery(to: .reconciliationSucceeded)
                self.dismissSyncedRecoveryStatusSoon()
            } else {
                self.transitionRecovery(to: .reconciliationFailed)
            }
        }
    }

    private func transitionRecovery(to event: ConversationRecoveryEvent) {
        recoveryState = ConversationRecoveryPolicy.reduce(recoveryState, event: event)
    }

    private func resetRecoveryStateForSessionLifecycle() {
        recoveryReconcileTask?.cancel(); recoveryReconcileTask = nil
        recoverySyncedDismissTask?.cancel(); recoverySyncedDismissTask = nil
        recoveryState = .idle
        connectionInterrupted = false
    }

    private func dismissSyncedRecoveryStatusSoon() {
        recoverySyncedDismissTask?.cancel()
        recoverySyncedDismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            self.transitionRecovery(to: .syncedDismissed)
            self.recoverySyncedDismissTask = nil
        }
    }

    // MARK: - HITL / 子 Agent 路由

    @discardableResult
    private func hydratePendingInteractions() async -> SessionAutoDrainSequence.StepResult {
        switch await PendingInteractionStore.shared.refreshSession(sessionId) {
        case let .success(pending):
            for interaction in pending {
                ingestPendingInteraction(interaction)
            }
            return .success
        case .failure:
            return .failure
        }
    }

    private func handlePendingInteractionUpdate(_ update: PendingInteractionUpdate) {
        switch update {
        case let .requested(interaction):
            guard interactionMatchesCurrentSession(interaction) else { return }
            ingestPendingInteraction(interaction)
        case let .terminal(interaction):
            guard interactionMatchesCurrentSession(interaction) else { return }
            hitl.dismissResolvedInteraction(
                kind: interaction.kind,
                threadId: interaction.threadId,
                requestKey: interaction.requestKey
            )
        }
    }

    private func interactionMatchesCurrentSession(_ interaction: PendingInteraction) -> Bool {
        interaction.sessionId == sessionId || interaction.threadId == "chat-session-\(sessionId)"
    }

    private func ingestPendingInteraction(_ interaction: PendingInteraction) {
        guard interactionMatchesCurrentSession(interaction),
              let env = interaction.toHITLEnvelope() else { return }
        if AgentStreamEvent.shouldDropLegacyActionApproval(
            env.type,
            isProjectSession: isProjectSession
        ) {
            logger.warning("ignored restored legacy action approval in Project session")
            return
        }
        guard let kind = hitlKind(forPendingInteraction: interaction, envelope: env) else { return }
        hitl.ingest(kind: kind, envelope: env)
    }

    private func hitlKind(forPendingInteraction interaction: PendingInteraction, envelope env: WSEnvelope) -> HITLKind? {
        if env.type == AgentStreamEvent.actionApprovalRequest {
            return .actionApprovalRequested
        }
        switch interaction.kind {
        case "tool_approval":
            return .approvalRequested
        case "ask_choice":
            return .askUser
        case "ask_form":
            return .askForm
        case "permission_request":
            return .requestApproval
        default:
            return nil
        }
    }

    private func handleHITL(kind: HITLKind, envelope: WSEnvelope) {
        switch kind {
        case .planProposal, .modeSwitchProposal:
            if let prompt = HITLPrompt.decode(kind: kind, envelope: envelope) {
                projector.appendProposalCard(prompt)
                publishNow()
            }
        default:
            hitl.ingest(kind: kind, envelope: envelope)
        }
    }

    private func applySubagent(_ event: SubagentEvent) {
        let idx = ensureSubagentRun(event.runId)
        var run = subagentRuns[idx]
        run.merge(event)

        switch event.kind {
        case .completed, .failed:
            cancellingSubagentRunIds.remove(event.runId)
        case .started, .queued, .progress:
            break
        }

        subagentRuns[idx] = run
        publishNow()
    }

    /// 取消单个正在执行 / 排队的子 Agent（best-effort，对齐整轮 `chat.cancel` 的即发即忘上行）。
    /// 上行 `subagent.cancel { session_id, child_id }`——Django `subagent_cancel` handler
    /// 校验会话权限后转发到绑定设备；终态经 `subagent_failed(status=cancelled)` 回流收尾。
    /// child_id 即子 Agent 的真实 run id（移动端观察 daemon 托管会话，用 runId 寻址）。
    func cancelSubagent(_ runId: String) {
        guard !runId.isEmpty, !cancellingSubagentRunIds.contains(runId) else { return }
        gateway.notify(type: "subagent.cancel",
                       payload: ["session_id": sessionId, "child_id": runId],
                       threadId: threadId)
        cancellingSubagentRunIds.insert(runId)
        publishNow()
    }

    private func applySubagentStream(_ event: SubagentStreamEvent) {
        let idx = ensureSubagentRun(event.runId)
        subagentRuns[idx].parentRunId = event.parentRunId
        subagentRuns[idx].subagentChain = event.subagentChain

        var reducer = subagentReducers[event.runId] ?? StreamSession()
        let updates = reducer.ingest(subagentDecoder.decode(event.childEnvelope))
        subagentReducers[event.runId] = reducer

        guard !updates.isEmpty else { return }
        for update in updates {
            applySubagentTranscriptUpdate(update, runId: event.runId)
        }
        publishNow()
    }

    private func ensureSubagentRun(_ runId: String) -> Int {
        if let idx = subagentRuns.firstIndex(where: { $0.runId == runId }) { return idx }
        subagentRuns.append(.pending(runId: runId))
        return subagentRuns.count - 1
    }

    private func applySubagentTranscriptUpdate(_ update: StreamUpdate, runId: String) {
        let idx = ensureSubagentRun(runId)
        switch update {
        case let .appendText(messageId, index, text):
            upsertSubagentTranscript(
                runIndex: idx,
                id: subagentTranscriptId(messageId: messageId, index: index, suffix: "text"),
                messageId: messageId,
                index: index,
                kind: .assistant,
                textDelta: text,
                isFinal: false
            )
        case let .thinking(messageId, index, text, completed):
            upsertSubagentTranscript(
                runIndex: idx,
                id: subagentTranscriptId(messageId: messageId, index: index, suffix: "thinking"),
                messageId: messageId,
                index: index,
                kind: .thinking,
                title: "思考",
                text: text,
                isFinal: completed
            )
        case let .toolUseStarted(messageId, toolCallId, name, index):
            upsertSubagentTranscript(
                runIndex: idx,
                id: "tool-\(toolCallId)",
                messageId: messageId,
                index: index,
                kind: .tool,
                title: name,
                isFinal: false,
                toolCallId: toolCallId
            )
        case let .toolUseFinalized(messageId, toolCallId, name, index, inputJson):
            upsertSubagentTranscript(
                runIndex: idx,
                id: "tool-\(toolCallId)",
                messageId: messageId,
                index: index,
                kind: .tool,
                title: name,
                inputText: inputJson,
                isFinal: false,
                toolCallId: toolCallId
            )
        case let .toolResult(messageId, toolUseId, text, isError, _, _):
            upsertSubagentTranscript(
                runIndex: idx,
                id: "tool-\(toolUseId)",
                messageId: messageId,
                index: nil,
                kind: .tool,
                outputText: text,
                isFinal: true,
                isError: isError,
                toolCallId: toolUseId
            )
        case let .toolExecution(event):
            let isFailed = event.phase == .failed
            upsertSubagentTranscript(
                runIndex: idx,
                id: "tool-\(event.toolCallId)",
                messageId: nil,
                index: nil,
                kind: .tool,
                title: event.toolName,
                outputText: event.outputText,
                isFinal: event.phase != .running,
                isError: isFailed,
                toolCallId: event.toolCallId
            )
        case .runtimeStep:
            // 对齐主对话 ConversationProjector：agent.stream.step 是兼容性运行提示，
            // 不属于内容时间线。Thinking 由 content_block(thinking) 呈现；再写入会多出
            // 「Thinking... / Thinking... (iteration N)」占位行。
            break
        case let .monitorStatus(_, status):
            upsertSubagentTranscript(
                runIndex: idx,
                id: "monitor-\(status.monitorId ?? status.description ?? "active")",
                messageId: nil,
                index: nil,
                kind: .system,
                title: status.description ?? "监控任务",
                text: status.failReason ?? status.command,
                isFinal: status.status?.lowercased() != "running",
                isError: status.status?.lowercased() == "failed"
            )
        case let .sshOutput(_, output):
            appendSubagentToolOutput(
                runIndex: idx,
                id: "tool-\(output.toolCallId ?? output.taskId ?? output.sessionId ?? "ssh")",
                title: output.serverName ?? "SSH",
                chunk: output.output,
                toolCallId: output.toolCallId
            )
        case let .richContent(messageId, index, block):
            appendSubagentTranscript(
                runIndex: idx,
                item: SubagentTranscriptItem(
                    id: subagentTranscriptId(messageId: messageId, index: index, suffix: "rich"),
                    messageId: messageId,
                    index: index,
                    kind: .richContent,
                    title: block.title,
                    text: block.summary,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: block,
                    contextRef: nil
                )
            )
        case let .contextRef(messageId, index, block):
            appendSubagentTranscript(
                runIndex: idx,
                item: SubagentTranscriptItem(
                    id: subagentTranscriptId(messageId: messageId, index: index, suffix: "context"),
                    messageId: messageId,
                    index: index,
                    kind: .contextRef,
                    title: block.label,
                    text: block.preview,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: nil,
                    contextRef: block
                )
            )
        case let .systemNotice(_, envelope):
            appendSubagentNotice(runIndex: idx, text: envelope.payloadString("content") ?? envelope.payloadString("message") ?? "系统通知")
        case let .error(info):
            appendSubagentTranscript(
                runIndex: idx,
                item: SubagentTranscriptItem(
                    id: "error-\(UUID().uuidString)",
                    messageId: nil,
                    index: nil,
                    kind: .error,
                    title: "执行出错",
                    text: info.message ?? info.errorClass ?? "子 Agent 执行出错",
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: true,
                    toolCallId: nil,
                    richContent: nil,
                    contextRef: nil
                )
            )
        case let .done(_, errorInfo):
            if let errorInfo {
                applySubagentTranscriptUpdate(.error(errorInfo), runId: runId)
            }
        case let .hitl(kind, _):
            appendSubagentNotice(runIndex: idx, text: subagentHITLNotice(kind))
        case let .todoUpdate(items):
            appendSubagentNotice(runIndex: idx, text: "更新待办事项 \(items.count) 项")
        case let .checkpointHealth(ok, _):
            appendSubagentNotice(runIndex: idx, text: ok ? "Checkpoint 已创建" : "Checkpoint 创建失败")
        case let .subagent(event):
            appendSubagentNotice(runIndex: idx, text: "派发子 Agent：\(event.label ?? event.task ?? event.runId)")
        case let .subagentStream(event):
            appendSubagentNotice(runIndex: idx, text: "收到嵌套子 Agent 事件：\(event.runId)")
            applySubagentStream(event)
        case .lifecycle, .messageStarted, .messageStop, .messagePersisted, .messageCommitted, .citation,
             .accepted, .connectionInterrupted, .connectionRestored, .sequenceGap,
             .observedUserMessage:
            break
        }
    }

    private func subagentTranscriptId(messageId: String?, index: Int?, suffix: String) -> String {
        "\(messageId ?? "message")-\(index ?? 0)-\(suffix)"
    }

    private func appendSubagentTranscript(runIndex: Int, item: SubagentTranscriptItem) {
        if !subagentRuns[runIndex].transcript.contains(where: { $0.id == item.id }) {
            subagentRuns[runIndex].transcript.append(item)
        }
    }

    private func appendSubagentNotice(runIndex: Int, text: String) {
        appendSubagentTranscript(
            runIndex: runIndex,
            item: SubagentTranscriptItem(
                id: "notice-\(UUID().uuidString)",
                messageId: nil,
                index: nil,
                kind: .system,
                title: "事件",
                text: text,
                inputText: nil,
                outputText: nil,
                isFinal: true,
                isError: false,
                toolCallId: nil,
                richContent: nil,
                contextRef: nil
            )
        )
    }

    private func appendSubagentToolOutput(
        runIndex: Int,
        id: String,
        title: String,
        chunk: String,
        toolCallId: String?
    ) {
        if let itemIndex = subagentRuns[runIndex].transcript.firstIndex(where: { $0.id == id }) {
            subagentRuns[runIndex].transcript[itemIndex].outputText =
                (subagentRuns[runIndex].transcript[itemIndex].outputText ?? "") + chunk
            return
        }
        upsertSubagentTranscript(
            runIndex: runIndex,
            id: id,
            messageId: nil,
            index: nil,
            kind: .tool,
            title: title,
            outputText: chunk,
            isFinal: false,
            toolCallId: toolCallId
        )
    }

    private func upsertSubagentTranscript(
        runIndex: Int,
        id: String,
        messageId: String?,
        index: Int?,
        kind: SubagentTranscriptItem.Kind,
        title: String? = nil,
        text: String? = nil,
        textDelta: String? = nil,
        inputText: String? = nil,
        outputText: String? = nil,
        isFinal: Bool,
        isError: Bool = false,
        toolCallId: String? = nil
    ) {
        if let itemIndex = subagentRuns[runIndex].transcript.firstIndex(where: { $0.id == id }) {
            if let title { subagentRuns[runIndex].transcript[itemIndex].title = title }
            if let text { subagentRuns[runIndex].transcript[itemIndex].text = text }
            if let textDelta {
                subagentRuns[runIndex].transcript[itemIndex].text = (subagentRuns[runIndex].transcript[itemIndex].text ?? "") + textDelta
            }
            if let inputText { subagentRuns[runIndex].transcript[itemIndex].inputText = inputText }
            if let outputText { subagentRuns[runIndex].transcript[itemIndex].outputText = outputText }
            subagentRuns[runIndex].transcript[itemIndex].isFinal = isFinal
            subagentRuns[runIndex].transcript[itemIndex].isError = isError
            if let toolCallId { subagentRuns[runIndex].transcript[itemIndex].toolCallId = toolCallId }
            if kind == .thinking {
                stampSubagentThinkingTimestamps(runIndex: runIndex, itemIndex: itemIndex, isFinal: isFinal)
            }
            return
        }

        let now = Date()
        subagentRuns[runIndex].transcript.append(SubagentTranscriptItem(
            id: id,
            messageId: messageId,
            index: index,
            kind: kind,
            title: title,
            text: textDelta ?? text,
            inputText: inputText,
            outputText: outputText,
            isFinal: isFinal,
            isError: isError,
            toolCallId: toolCallId,
            richContent: nil,
            contextRef: nil,
            startedAt: kind == .thinking ? now : nil,
            stoppedAt: kind == .thinking && isFinal ? now : nil
        ))
    }

    private func stampSubagentThinkingTimestamps(runIndex: Int, itemIndex: Int, isFinal: Bool) {
        if subagentRuns[runIndex].transcript[itemIndex].startedAt == nil {
            subagentRuns[runIndex].transcript[itemIndex].startedAt = Date()
        }
        if isFinal, subagentRuns[runIndex].transcript[itemIndex].stoppedAt == nil {
            subagentRuns[runIndex].transcript[itemIndex].stoppedAt = Date()
        }
    }

    private func subagentHITLNotice(_ kind: HITLKind) -> String {
        switch kind {
        case .askUser, .askForm:
            return "子 Agent 请求补充信息"
        case .requestApproval, .approvalRequested, .actionApprovalRequested:
            return "子 Agent 请求审批"
        case .singleHitlResolved:
            return "子 Agent 询问已处理"
        case .approvalResolved, .actionApprovalResolved:
            return "子 Agent 审批已处理"
        case .planProposal:
            return "子 Agent 提交计划"
        case .modeSwitchProposal:
            return "子 Agent 请求切换模式"
        }
    }

    private func handleBillingEnvelope(_ env: WSEnvelope) {
        switch env.type {
        case "billing.billing_blocked":
            guard BillingBlockClassification.isOrganizationGuard(env) else { return }
            billingBlockedTitle = "计费状态阻断"
            billingBlockedMessage = env.payloadString("reason")
                ?? env.payloadString("message")
                ?? "当前组织余额或额度不足，请处理后重试。"
        case "billing.quota_exhausted":
            // 常规套餐额度切换只刷新数据，不能与会话内余额不足卡片叠加横幅。
            break
        case "billing.member_budget_exhausted":
            billingBlockedTitle = "成员额度受限"
            billingBlockedMessage = env.payloadString("message")
                ?? "你的成员额度已用完，请联系管理员调整额度。"
        case "billing.balance_low", "billing.budget_warning", "billing.budget_critical",
             "billing.member_budget_warning", "billing.storage_warning", "billing.storage_critical":
            // 预警只由全局 BillingEventHandler 展示 toast，不能占用会话硬阻断字段。
            break
        case "billing.billing_unblocked", "billing.credits_recharged", "billing.member_budget_resolved",
             "billing.budget_resolved", "billing.storage_resolved", "billing.membership_activated":
            billingBlockedTitle = nil
            billingBlockedMessage = nil
            drainOutgoingQueueIfPossible()
        default:
            break
        }
    }

    private func restoreTodoItemsFromHistory(_ messages: [ChatMessage]) {
        guard let latest = messages
            .flatMap(\.toolCalls)
            .reversed()
            .first(where: { $0.name == "todo_write" || $0.name == "TodoWrite" }),
            let items = Self.todoItems(fromToolInput: latest.inputJson),
            !items.isEmpty
        else { return }
        todoItems = items
    }

    private static func todoItems(fromToolInput inputJson: String) -> [AgentTodoItem]? {
        guard let data = inputJson.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let raw = (object["todos"] as? [Any])
            ?? (object["items"] as? [Any])
            ?? ((object["todo"] as? [String: Any])?["items"] as? [Any])
        guard let raw else { return nil }
        let items = raw.enumerated().compactMap { index, item -> AgentTodoItem? in
            guard let dict = item as? [String: Any] else { return nil }
            let content = (dict["content"] as? String)
                ?? (dict["text"] as? String)
                ?? (dict["title"] as? String)
                ?? ""
            guard !content.isEmpty else { return nil }
            return AgentTodoItem(
                id: (dict["id"] as? String) ?? "todo-\(index)",
                content: content,
                status: (dict["status"] as? String) ?? "pending"
            )
        }
        return items
    }

    private struct PreparedOutgoingMessage {
        let clientEventId: String
        let text: String
        let modelId: String
        let configuration: ConversationRuntimeConfiguration
        let blocks: [[String: Any]]?
        let focusSnapshot: FocusSnapshot?
    }

    private struct ActiveSubmittedMessage {
        let queueId: String
        let clientEventId: String
        let text: String
    }

    // MARK: - Actions

    /// 发一条消息：空闲时立即发送；当前会话流式中时先进本地队列，等本轮终态后 FIFO 发送。
    /// 断线/订阅失败时队列持久化，下次打开会话或重连后继续 flush。
    /// `focusSnapshot` 在入队时冻结；忙碌只排队，不 stop/cancel 当前运行。
    @discardableResult
    func send(
        _ text: String,
        modelId: String? = nil,
        agentMode overrideAgentMode: String? = nil,
        approvalMode overrideApprovalMode: String? = nil,
        blocks: [[String: Any]]? = nil,
        focusSnapshot: FocusSnapshot? = nil
    ) -> Bool {
        enqueue(
            text,
            modelId: modelId,
            agentMode: overrideAgentMode,
            approvalMode: overrideApprovalMode,
            blocks: blocks,
            focusSnapshot: focusSnapshot
        ) != nil
    }

    /// 带诚实回执的入队。HITL / paused / 计费 / 模型缺失阻断入队并返回 `.blocked`。
    @discardableResult
    func enqueue(
        _ text: String,
        modelId: String? = nil,
        agentMode overrideAgentMode: String? = nil,
        approvalMode overrideApprovalMode: String? = nil,
        blocks: [[String: Any]]? = nil,
        focusSnapshot: FocusSnapshot? = nil
    ) -> QueuedSendReceipt? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentBlocks = Self.attachmentBlocks(from: blocks)
        let contextBlocks = Self.contextBlocks(from: blocks)
        guard !trimmed.isEmpty || !attachmentBlocks.isEmpty || !contextBlocks.isEmpty else { return nil }

        if let blockReason = enqueueBlockReason() {
            actionError = blockReason
            return .blocked(reason: blockReason)
        }

        guard let resolvedModelId = modelId ?? ChatModelStore.shared.sendableModelId() else {
            let reason = "没有可用模型：请在管理后台配置并激活聊天模型后重试。"
            actionError = reason
            return .blocked(reason: reason)
        }

        let configuration = resolvedRuntimeConfiguration(
            agentMode: overrideAgentMode,
            approvalMode: overrideApprovalMode
        )
        guard let item = outgoingQueue.insert(
            sessionId: sessionId,
            text: trimmed,
            modelId: resolvedModelId,
            configuration: configuration,
            blocks: blocks,
            status: .waiting,
            focusSnapshot: focusSnapshot
        ) else {
            let reason = "消息未能保存到本机，请保留草稿后重试。"
            actionError = reason
            logSendTransition(.failed, clientEventId: nil, detail: "queue_persist_failed")
            return .failed(reason: reason)
        }
        reloadOutgoingQueue()
        logSendTransition(.waiting, clientEventId: item.clientEventId)
        let wasBusy = projector.isStreamingActive || sendingOutgoing
        drainOutgoingQueueIfPossible()
        if wasBusy {
            return .queued(queueId: item.id)
        }
        return .persisted(queueId: item.id)
    }

    /// 胶囊语音等调用方订阅 ACK 回执（queueId → accepted / failed）。
    var onQueuedSendReceipt: ((String, QueuedSendReceipt) -> Void)?

    /// HITL / paused / 计费阻断普通入队（忙碌允许排队）。
    func enqueueBlockReason() -> String? {
        if hitl.pendingCount > 0 {
            return "需要先完成确认或回答，才能继续发送。"
        }
        if isPaused {
            return "任务已暂停，恢复后再发送。"
        }
        if billingBlockedTitle != nil || billingBlockedMessage != nil {
            return billingBlockedMessage ?? billingBlockedTitle ?? "当前计费状态阻止发送。"
        }
        return nil
    }

    private func sendPrepared(
        _ prepared: PreparedOutgoingMessage,
        queuedMessageId: String
    ) async {
        if projector.isStreamingActive {
            markQueuedMessage(queuedMessageId, status: .waiting)
            return
        }
        sendingOutgoing = true
        defer { sendingOutgoing = false }

        guard await gateway.ensureConnected() else {
            markQueuedMessage(queuedMessageId, status: .offline, error: "网络连接中断，连接恢复后将继续发送", incrementAttempt: true)
            logSendTransition(.offline, clientEventId: prepared.clientEventId, detail: "connect_failed")
            return
        }
        guard await gateway.subscribeAndWait(subscriptionTopics) else {
            markQueuedMessage(queuedMessageId, status: .offline, error: "订阅会话流失败，连接恢复后将继续发送", incrementAttempt: true)
            failSend("订阅会话流失败，消息已保存在待发送队列")
            logSendTransition(.offline, clientEventId: prepared.clientEventId, detail: "subscribe_failed")
            return
        }
        if projector.isStreamingActive {
            markQueuedMessage(queuedMessageId, status: .waiting)
            return
        }

        // 固定复用 queue id 作为 client_event_id：超时/断线重试仍是同一条业务消息。
        let clientEventId = prepared.clientEventId
        let attachmentBlocks = Self.attachmentBlocks(from: prepared.blocks)
        let contextBlocks = Self.contextBlocks(from: prepared.blocks)
        // user 与其本地 assistant 占位共享一个轮次锚点。后续若缓存/历史触发重排，
        // 同一时刻的稳定规则会先放 user，再放它的状态/回复卡。
        let optimisticTurnCreatedAt = Date.now
        projector.appendUserMessage(
            id: clientEventId,
            text: prepared.text,
            attachments: attachmentBlocks,
            contextRefs: contextBlocks,
            createdAt: optimisticTurnCreatedAt
        )
        // 乐观用户气泡先落缓存；离开/重进时仍能恢复，且重试同 id 不会重复追加。
        cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
        // 仅当前无任何轮次在流式时建乐观 assistant 占位——否则别端在跑的 message_start 会误认领它。
        // 排队 / 别端在跑场景：不建占位，等本机 run 的 message_start 自建气泡。
        if !projector.isStreamingActive {
            projector.beginAssistant(
                id: "asst_pending_\(clientEventId)",
                sourceClientEventId: clientEventId,
                agentId: executionAgentId,
                createdAt: optimisticTurnCreatedAt
            )
        }
        activeSubmittedMessage = ActiveSubmittedMessage(
            queueId: queuedMessageId,
            clientEventId: clientEventId,
            text: prepared.text
        )
        // 新一轮发送：清掉上一轮撤回对账豁免，避免误跳过本轮终态 HTTP 校正。
        withdrawReconcileGate = WithdrawTerminalReconcilePolicy.clearForNewSend()
        // chat.cancel 已支持只按 session/thread 取消；不必等 send ACK 回 task_id 才让用户 Stop。
        setCanCancel(true)
        actionError = nil
        billingBlockedTitle = nil
        billingBlockedMessage = nil
        PerfTrace.markTurnSent()
        publishNow()

        let payload = prepared.configuration.chatSendPayload(
            sessionId: sessionId,
            message: prepared.text,
            clientEventId: clientEventId,
            modelId: prepared.modelId,
            blocks: prepared.blocks,
            userTimeZone: TimeZone.current.identifier,
            focusSnapshot: prepared.focusSnapshot
        )

        markQueuedMessage(queuedMessageId, status: .sending)
        logSendTransition(.sending, clientEventId: clientEventId)
        let ack = await gateway.sendRequest(
            type: "chat.send_message",
            payload: payload,
            okType: "chat.send_message.ok",
            nakType: "chat.send_message.nak",
            threadId: threadId,
            timeout: 30
        )
        handleSendAck(
            ack,
            queuedMessageId: queuedMessageId,
            localUserMessageId: clientEventId
        )
    }

    private static func attachmentBlocks(from payloads: [[String: Any]]?) -> [AttachmentBlock] {
        (payloads ?? []).enumerated().compactMap { index, payload in
            guard let type = payload["type"] as? String,
                  type == "image" || type == "file" else { return nil }
            return AttachmentBlock(
                index: index,
                kind: type == "image" ? .image : .file,
                filename: (payload["filename"] as? String) ?? (type == "image" ? "图片" : "文件"),
                mimeType: payload["mime_type"] as? String,
                size: Self.int64Value(payload["size"] ?? payload["file_size"]),
                url: (payload["url"] as? String) ?? (payload["remote_url"] as? String),
                fileId: (payload["file_id"] as? String) ?? (payload["fileId"] as? String)
            )
        }
    }

    private static func contextBlocks(from payloads: [[String: Any]]?) -> [ContextRefBlock] {
        let supportedTypes: Set<String> = [
            "table_selection", "doc_selection", "slide", "design", "video",
            "site", "folder", "code_file", "memo", "goal", "canvas",
            "web", "webpage", "search_result"
        ]
        return (payloads ?? []).enumerated().compactMap { index, payload in
            guard let type = payload["type"] as? String,
                  supportedTypes.contains(type) else { return nil }
            let label = (payload["label"] as? String)
                ?? (payload["title"] as? String)
                ?? (payload["preview"] as? String)
                ?? "上下文引用"
            return ContextRefBlock(
                index: index,
                type: type,
                resourceId: contextResourceId(blockType: type, payload: payload),
                url: stringValue(payload["url"]),
                tableId: stringValue(payload["table_id"] ?? payload["tableId"]),
                docId: stringValue(payload["doc_id"] ?? payload["docId"]),
                rowIds: stringArray(payload["row_ids"] ?? payload["rowIds"]) ?? [],
                fieldIds: stringArray(payload["field_ids"] ?? payload["fieldIds"]) ?? [],
                label: label,
                preview: payload["preview"] as? String,
                spaceId: payload["space_id"] as? String,
                spaceName: payload["space_name"] as? String,
                locationHint: contextLocationHint(payload: payload)
            )
        }
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        if let int = value as? Int { return Int64(int) }
        if let int64 = value as? Int64 { return int64 }
        if let double = value as? Double { return Int64(double) }
        if let string = value as? String { return Int64(string) }
        return nil
    }

    private static func contextResourceId(blockType: String, payload: [String: Any]) -> String? {
        switch blockType {
        case "table_selection":
            return stringValue(payload["table_id"]) ?? stringValue(payload["resource_id"])
        case "doc_selection":
            return stringValue(payload["doc_id"]) ?? stringValue(payload["resource_id"])
        default:
            return stringValue(payload["resource_id"])
                ?? stringValue(payload["table_id"])
                ?? stringValue(payload["doc_id"])
        }
    }

    private static func contextLocationHint(payload: [String: Any]) -> String? {
        if let explicit = stringValue(payload["location_hint"] ?? payload["locationHint"]) {
            return explicit
        }
        var parts: [String] = []
        if let page = intValue(payload["page"]) {
            parts.append("第 \(page) 页")
        }
        switch (intValue(payload["start_line"] ?? payload["startLine"]), intValue(payload["end_line"] ?? payload["endLine"])) {
        case let (.some(start), .some(end)) where end > start:
            parts.append("行 \(start)-\(end)")
        case let (.some(start), _):
            parts.append("行 \(start)")
        default:
            break
        }
        if let rowIds = stringArray(payload["row_ids"] ?? payload["rowIds"]), !rowIds.isEmpty {
            parts.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds = stringArray(payload["field_ids"] ?? payload["fieldIds"]), !fieldIds.isEmpty {
            parts.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        if let chunkId = stringValue(payload["chunk_id"] ?? payload["chunkId"]) {
            parts.append("Chunk \(chunkId)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let int64 = value as? Int64 { return Int(int64) }
        if let double = value as? Double { return Int(double) }
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String:
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }

    private static func stringArray(_ value: Any?) -> [String]? {
        if let strings = value as? [String] {
            return strings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        if let values = value as? [Any] {
            return values.compactMap(stringValue)
        }
        return nil
    }

    func setAgentMode(_ mode: String) {
        let resolved = ChatAgentMode.resolve(mode)
        runtimeConfiguration = ConversationRuntimeConfiguration(
            agentMode: resolved,
            approvalMode: runtimeConfiguration.approvalMode.clamped(
                permitsRelaxedApproval: permitsRelaxedApproval
            )
        )
        persistRuntimeConfiguration()
        markAgentModeLocalDirty()
        let generation = agentModeSyncGeneration &+ 1
        agentModeSyncGeneration = generation
        let capturedSessionId = sessionId
        Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await ChatSessionResolver.updateAgentMode(
                    sessionId: capturedSessionId,
                    agentMode: resolved
                )
                guard self.sessionId == capturedSessionId,
                      self.agentModeSyncGeneration == generation else { return }
                self.clearAgentModeLocalDirty()
                self.applyServerAgentMode(
                    updated.agentMode,
                    approvalMode: updated.approvalMode
                )
            } catch {
                // fail-soft：保留本地选择与 dirty 窗口
            }
        }
    }

    private func markAgentModeLocalDirty() {
        agentModeLocalDirtyUntil = Date().addingTimeInterval(Self.agentModeLocalDirtyWindow)
    }

    private func clearAgentModeLocalDirty() {
        agentModeLocalDirtyUntil = nil
    }

    private var hasAgentModeLocalDirty: Bool {
        guard let until = agentModeLocalDirtyUntil else { return false }
        return Date() < until
    }

    /// ：无 dirty 时以服务端 agent_mode 为准；审批档保留本地偏好。
    private func applyServerAgentMode(_ rawAgentMode: String?, approvalMode _: String? = nil) {
        if hasAgentModeLocalDirty { return }
        guard let rawAgentMode, !rawAgentMode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let nextAgent = ChatAgentMode.resolve(rawAgentMode)
        guard nextAgent != runtimeConfiguration.agentMode else { return }
        runtimeConfiguration = ConversationRuntimeConfiguration(
            agentMode: nextAgent,
            approvalMode: runtimeConfiguration.approvalMode.clamped(
                permitsRelaxedApproval: permitsRelaxedApproval
            )
        )
        persistRuntimeConfiguration()
    }

    /// W0-C 的审批选择器接线预留。即使调用方传入非法值，也会回到保守档。
    func setApprovalMode(_ mode: String) {
        runtimeConfiguration = ConversationRuntimeConfiguration(
            agentMode: runtimeConfiguration.agentMode,
            approvalMode: (ChatApprovalMode.resolve(mode) ?? .alwaysAsk).clamped(
                permitsRelaxedApproval: permitsRelaxedApproval
            )
        )
        persistRuntimeConfiguration()
    }

    // MARK: - 运行配置按会话持久化

    /// 每个 session 记住默认配置；真正发送仍以队列内冻结快照为准。
    private var agentModeDefaultsKey: String { "tabtin.chat.agent_mode.\(sessionId)" }
    private var approvalModeDefaultsKey: String { "tabtin.chat.approval_mode.\(sessionId)" }
    private var permitsRelaxedApproval: Bool { WorkspaceStore.shared.allowMemberYolo }

    private func persistRuntimeConfiguration() {
        if runtimeConfiguration.agentMode == .agent {
            UserDefaults.standard.removeObject(forKey: agentModeDefaultsKey)
        } else {
            UserDefaults.standard.set(runtimeConfiguration.agentMode.rawValue, forKey: agentModeDefaultsKey)
        }
        if runtimeConfiguration.approvalMode == .alwaysAsk {
            UserDefaults.standard.removeObject(forKey: approvalModeDefaultsKey)
        } else {
            UserDefaults.standard.set(runtimeConfiguration.approvalMode.rawValue, forKey: approvalModeDefaultsKey)
        }
    }

    /// `yolo` 历史偏好迁为 agent + auto（若组织允许），否则落到 always_ask；
    /// 迁移完成即覆写旧 key，后续发送不会再携带 yolo。
    private func restoreRuntimeConfiguration() {
        let savedAgentMode = UserDefaults.standard.string(forKey: agentModeDefaultsKey)
        let savedApprovalMode = UserDefaults.standard.string(forKey: approvalModeDefaultsKey)
        runtimeConfiguration = ConversationRuntimeConfiguration.migrating(
            agentMode: savedAgentMode,
            approvalMode: savedApprovalMode,
            permitsRelaxedApproval: permitsRelaxedApproval
        )
        if ChatAgentMode.isLegacyYolo(savedAgentMode)
            || (savedApprovalMode != nil && ChatApprovalMode.resolve(savedApprovalMode) == nil) {
            persistRuntimeConfiguration()
        }
    }

    private func resolvedRuntimeConfiguration(
        agentMode overrideAgentMode: String?,
        approvalMode overrideApprovalMode: String?
    ) -> ConversationRuntimeConfiguration {
        ConversationRuntimeConfiguration.migrating(
            agentMode: overrideAgentMode ?? runtimeConfiguration.agentMode.rawValue,
            approvalMode: overrideApprovalMode ?? runtimeConfiguration.approvalMode.rawValue,
            permitsRelaxedApproval: permitsRelaxedApproval
        )
    }

    private func handleSendAck(
        _ ack: AckResult,
        queuedMessageId: String,
        localUserMessageId: String? = nil
    ) {
        switch ack {
        case let .ok(payload):
            let clientEventId = payload["client_event_id"]?.stringValue ?? localUserMessageId ?? queuedMessageId
            let messageId = payload["message_id"]?.stringValue
            let taskId = payload["task_id"]?.stringValue
            let runId = payload["run_id"]?.stringValue
            let delivery = payload["delivery"]?.stringValue
            let executionState = payload["execution_state"]?.stringValue
            let acceptedStatus = OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: delivery,
                executionState: executionState
            )
            let normalizedExecutionState = executionState?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .replacingOccurrences(of: "-", with: "_")
            if taskId?.isEmpty == false
                || ["running", "queued", "in_progress"].contains(normalizedExecutionState ?? "") {
                RecentSessionsStore.shared.markRunStarted(
                    sessionId: sessionId,
                    runId: runId,
                    status: normalizedExecutionState == "queued" ? .queued : .running
                )
            }
            projector.confirmUserMessage(clientEventId: clientEventId, serverMessageId: messageId)
            outgoingQueue.recordDelivery(
                id: queuedMessageId,
                status: acceptedStatus,
                clientEventId: clientEventId,
                serverMessageId: messageId,
                taskId: taskId
            )
            reloadOutgoingQueue()
            publishNow()
            cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            // task_id 非空 ⇒ 本机有在跑轮次（可取消）；nil ⇒ 被排队，等前序轮次跑完。
            if let taskId, !taskId.isEmpty, !discardingCancelledRun {
                myTaskId = taskId
                setCanCancel(true)
            }
            logSendTransition(acceptedStatus, clientEventId: clientEventId, messageId: messageId, taskId: taskId,
                              detail: "delivery:\(delivery ?? "-") execution:\(executionState ?? (taskId?.isEmpty == false ? "running" : "queued"))")
            onQueuedSendReceipt?(queuedMessageId, .accepted(queueId: queuedMessageId))
            if !discardingCancelledRun {
                scheduleAcceptedReconcile(queueId: queuedMessageId)
                startSendWatchdog(queueId: queuedMessageId, clientEventId: clientEventId)
                consumePendingUnattributedExecutionEvidence(clientEventId: clientEventId)
            }
        case let .nak(code, message, category, retryable, delivery, executionState, messageId, ackClientEventId):
            let clientEventId = ackClientEventId ?? localUserMessageId ?? queuedMessageId
            if delivery == "persisted" {
                projector.confirmUserMessage(clientEventId: clientEventId, serverMessageId: messageId)
                let persistedStatus = OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                    delivery: delivery,
                    executionState: executionState
                )
                let persistedError = Self.humanizedSendError(
                    code: code,
                    message: message,
                    fallback: OutgoingQueuePolicy.presentation(for: persistedStatus, queueCount: 1).fallbackDetail
                )
                outgoingQueue.recordDelivery(
                    id: queuedMessageId,
                    status: persistedStatus,
                    clientEventId: clientEventId,
                    serverMessageId: messageId,
                    taskId: nil,
                    error: persistedError
                )
                reloadOutgoingQueue()
                projector.removePendingOptimisticAssistant()
                // delivery=persisted：发送动作已成功，禁止写入 actionError。
                // 执行侧后续态各有唯一出口——
                //   awaitingDevice → Composer 井内硬门闩（环境离线禁发）
                //   persistedExecutionFailed → OutgoingQueueStrip（队列）
                actionError = nil
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
                clearMySendTracking()
                logSendTransition(
                    persistedStatus,
                    clientEventId: clientEventId,
                    messageId: messageId,
                    detail: "persisted_nak:\(code) execution:\(executionState ?? "-")"
                )
                // 消息已落库：对胶囊诚实回执而言仍算「已送达」。
                onQueuedSendReceipt?(queuedMessageId, .accepted(queueId: queuedMessageId))
                drainOutgoingQueueIfPossible()
                return
            }
            if Self.isOrganizationBillingGuard(code: code, category: category) {
                billingBlockedTitle = Self.billingTitle(code: code, category: category)
                billingBlockedMessage = message.isEmpty ? "当前组织或成员额度不足，请调整额度后重试。" : message
            }
            let error = Self.humanizedSendError(
                code: code,
                message: message,
                fallback: "消息发送失败，请稍后重试"
            )
            markQueuedMessage(queuedMessageId, status: .failed, error: error, incrementAttempt: retryable)
            failSend(error)
            logSendTransition(.failed, clientEventId: clientEventId, detail: retryable ? "retryable_nak:\(code)" : "nak:\(code)")
            onQueuedSendReceipt?(queuedMessageId, .failed(reason: error))
            drainOutgoingQueueIfPossible()
        case .timeout:
            markQueuedMessage(queuedMessageId, status: .offline, error: "发送确认超时，连接恢复后可重试", incrementAttempt: true)
            failSend("发送确认超时，消息已保存在待发送队列")
            logSendTransition(.offline, clientEventId: localUserMessageId, detail: "ack_timeout")
            // 超时仍属本机已保存，胶囊侧保持 queued/persisted 语义，不推进 accepted。
            onQueuedSendReceipt?(
                queuedMessageId,
                .failed(reason: "发送确认超时，消息已保存在待发送队列")
            )
            drainOutgoingQueueIfPossible()
        case .disconnected:
            markQueuedMessage(
                queuedMessageId,
                status: .offline,
                error: "网络连接中断，连接恢复后将继续发送",
                incrementAttempt: true
            )
            failSend("网络连接中断，消息已保存在待发送队列")
            logSendTransition(.offline, clientEventId: localUserMessageId, detail: "disconnected")
            onQueuedSendReceipt?(
                queuedMessageId,
                .failed(reason: "网络连接中断，消息已保存在待发送队列")
            )
            drainOutgoingQueueIfPossible()
        }
    }

    /// 发送看门狗：若 ack 后一直没收到任何下行事件（真·没动静，非排队），把乐观占位标记为失败。
    /// 若期间收到任意事件（本轮在跑或别端在跑/排队推进），不误报——耐心等常驻通道渲染。
    private func startSendWatchdog(queueId: String, clientEventId: String) {
        sendWatchdog?.cancel()
        let timeout = sendWatchdogTimeout
        sendWatchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            guard let self, !Task.isCancelled else { return }
            guard self.projector.hasPendingOptimistic else { return }
            _ = await self.reconcileAcceptedOutgoing(queueId: queueId)
            guard self.projector.hasPendingOptimistic else { return }
            if self.queuedOutgoingMessages.contains(where: { $0.id == queueId && $0.status == .accepted }) {
                self.outgoingQueue.recordDelivery(
                    id: queueId,
                    status: .accepted,
                    clientEventId: clientEventId,
                    serverMessageId: nil,
                    taskId: nil,
                    error: "消息已受理，正在等待执行"
                )
                self.reloadOutgoingQueue()
            }
            self.logSendTransition(.accepted, clientEventId: clientEventId, detail: "ack_without_stream")
            self.projector.failPendingOptimistic("消息已受理，但暂未收到执行结果")
            self.publishNow()
            self.cache.cacheMessages(sessionId: self.sessionId, messages: self.projector.messages)
            self.drainOutgoingQueueIfPossible()
        }
    }

    private func failSend(_ message: String) {
        sendWatchdog?.cancel(); sendWatchdog = nil
        let displayMessage = Self.humanizedSendError(
            code: message,
            message: message,
            fallback: "消息发送失败，请稍后重试"
        )
        if projector.hasPendingOptimistic {
            projector.failPendingOptimistic(displayMessage)
            publishNow()
            cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
        } else {
            actionError = displayMessage
        }
        clearMySendTracking()
    }

    private func reloadOutgoingQueue() {
        queuedOutgoingMessages = outgoingQueue.messages(
            sessionId: sessionId,
            permitsRelaxedApproval: permitsRelaxedApproval
        )
    }

    /// USER mirror only proves persistence. Keep the durable idempotency row for device recovery.
    private func confirmAcceptedOutgoing(clientEventId: String) {
        let persisted = queuedOutgoingMessages.filter {
            $0.status == .accepted && $0.clientEventId == clientEventId
        }
        guard !persisted.isEmpty else { return }
        for item in persisted {
            outgoingQueue.recordDelivery(
                id: item.id,
                status: .awaitingDevice,
                clientEventId: item.clientEventId,
                serverMessageId: item.serverMessageId,
                taskId: item.taskId
            )
            logSendTransition(.awaitingDevice, clientEventId: item.clientEventId, messageId: item.serverMessageId, detail: "user_mirror_persisted")
        }
        reloadOutgoingQueue()
    }

    /// HTTP history distinguishes persistence from execution within the matching user turn.
    private func confirmAcceptedOutgoing(from authoritative: [ChatMessage]) {
        guard !authoritative.isEmpty else { return }
        let pending = queuedOutgoingMessages.filter {
            $0.isAwaitingExecutionConfirmation
        }
        guard !pending.isEmpty else { return }
        var changed = false
        for item in pending {
            switch QueuedOutgoingMessage.historyEvidence(for: item, in: authoritative) {
            case .absent:
                continue
            case .persisted:
                guard item.status == .accepted else { continue }
                let identities = Set([item.id, item.clientEventId, item.serverMessageId].compactMap { $0 })
                let matchedUser = authoritative.first {
                    $0.role == .user && !$0.identityKeys.isDisjoint(with: identities)
                }
                outgoingQueue.recordDelivery(
                    id: item.id,
                    status: .awaitingDevice,
                    clientEventId: item.clientEventId,
                    serverMessageId: matchedUser?.persistedId ?? matchedUser?.serverId ?? item.serverMessageId,
                    taskId: item.taskId
                )
                logSendTransition(.awaitingDevice, clientEventId: item.clientEventId, messageId: item.serverMessageId, detail: "history_user_persisted")
                changed = true
            case .executionStarted:
                outgoingQueue.delete(id: item.id)
                flushingQueueItemIds.remove(item.id)
                logSendTransition(.awaitingDevice, clientEventId: item.clientEventId, messageId: item.serverMessageId, taskId: item.taskId, detail: "source_client_event_confirmed")
                changed = true
            }
        }
        if changed { reloadOutgoingQueue() }
    }

    private func completeOutgoingExecution(taskId: String) {
        let completed = queuedOutgoingMessages.filter {
            $0.matchesExecutionTask(taskId)
        }
        guard !completed.isEmpty else { return }
        for item in completed {
            outgoingQueue.delete(id: item.id)
            flushingQueueItemIds.remove(item.id)
            logSendTransition(.awaitingDevice, clientEventId: item.clientEventId, messageId: item.serverMessageId, taskId: taskId, detail: "task_terminal")
        }
        reloadOutgoingQueue()
    }

    private func completeOutgoingExecution(clientEventId: String) {
        let completed = queuedOutgoingMessages.filter {
            $0.isAwaitingExecutionConfirmation && $0.clientEventId == clientEventId
        }
        guard !completed.isEmpty else { return }
        for item in completed {
            outgoingQueue.delete(id: item.id)
            flushingQueueItemIds.remove(item.id)
            logSendTransition(.awaitingDevice, clientEventId: item.clientEventId, messageId: item.serverMessageId, taskId: item.taskId, detail: "source_client_event_confirmed")
        }
        reloadOutgoingQueue()
    }

    private func completeActiveOutgoingExecutionFromUnattributedStream() {
        guard let submitted = activeSubmittedMessage else { return }
        let completed = queuedOutgoingMessages.filter {
            $0.isAwaitingExecutionConfirmation && $0.clientEventId == submitted.clientEventId
        }
        guard !completed.isEmpty else {
            pendingUnattributedExecutionEvidenceClientId = submitted.clientEventId
            return
        }
        for item in completed {
            outgoingQueue.delete(id: item.id)
            flushingQueueItemIds.remove(item.id)
            logSendTransition(
                .awaitingDevice,
                clientEventId: item.clientEventId,
                messageId: item.serverMessageId,
                taskId: item.taskId,
                detail: "unattributed_stream_observed"
            )
        }
        pendingUnattributedExecutionEvidenceClientId = nil
        reloadOutgoingQueue()
    }

    private func consumePendingUnattributedExecutionEvidence(clientEventId: String) {
        guard pendingUnattributedExecutionEvidenceClientId == clientEventId else { return }
        completeActiveOutgoingExecutionFromUnattributedStream()
    }

    private func markQueuedMessage(
        _ id: String,
        status: QueuedOutgoingMessageStatus,
        error: String? = nil,
        incrementAttempt: Bool = false
    ) {
        outgoingQueue.updateStatus(id: id, status: status, error: error, incrementAttempt: incrementAttempt)
        reloadOutgoingQueue()
    }

    func removeQueuedMessage(_ id: String) {
        guard let item = queuedOutgoingMessages.first(where: { $0.id == id }),
              OutgoingQueuePolicy.presentation(for: item.status, queueCount: queuedOutgoingMessages.count)
                .actions.allows(.removeUnsent) else { return }
        flushingQueueItemIds.remove(id)
        outgoingQueue.delete(id: id)
        reloadOutgoingQueue()
        drainOutgoingQueueIfPossible()
    }

    /// 仅删除已受理记录的本机观察行；不会向服务端发取消，也不会影响正在排队/执行的任务。
    func hideAcceptedOutgoingTracking(_ id: String) {
        guard let item = queuedOutgoingMessages.first(where: { $0.id == id }),
              OutgoingQueuePolicy.presentation(for: item.status, queueCount: queuedOutgoingMessages.count)
                .actions.allows(.hideAcceptedTracking) else { return }
        flushingQueueItemIds.remove(id)
        outgoingQueue.delete(id: id)
        reloadOutgoingQueue()
    }

    func retryQueuedMessage(_ id: String) {
        guard let item = queuedOutgoingMessages.first(where: { $0.id == id }),
              OutgoingQueuePolicy.presentation(for: item.status, queueCount: queuedOutgoingMessages.count)
                .actions.allows(.retry) else { return }
        outgoingQueue.updateStatus(id: id, status: .waiting, error: nil)
        reloadOutgoingQueue()
        drainOutgoingQueueIfPossible()
    }

    private func drainOutgoingQueueIfPossible() {
        guard !projector.isStreamingActive, !sendingOutgoing, !discardingCancelledRun else { return }
        // HITL / paused 阻断自动排空；忙碌态本身由 isStreamingActive 挡住，只排队。
        guard enqueueBlockReason() == nil else { return }
        reloadOutgoingQueue()
        guard let item = queuedOutgoingMessages.first(where: {
            $0.isAutoDrainable && !flushingQueueItemIds.contains($0.id)
        }) else { return }
        flushingQueueItemIds.insert(item.id)
        markQueuedMessage(item.id, status: .sending, error: nil)
        let prepared = PreparedOutgoingMessage(
            clientEventId: item.clientEventId,
            text: item.text,
            modelId: item.modelId ?? ChatModelStore.shared.sendableModelId() ?? "",
            configuration: ConversationRuntimeConfiguration(
                agentMode: item.agentMode,
                approvalMode: item.approvalMode
            ),
            blocks: item.blocks,
            focusSnapshot: item.focusSnapshot
        )
        guard !prepared.modelId.isEmpty else {
            flushingQueueItemIds.remove(item.id)
            markQueuedMessage(item.id, status: .failed, error: "没有可用模型，请配置模型后重试", incrementAttempt: true)
            return
        }
        Task { [weak self] in
            guard let self else { return }
            await self.sendPrepared(prepared, queuedMessageId: item.id)
            self.flushingQueueItemIds.remove(item.id)
            self.reloadOutgoingQueue()
            if let finished = self.queuedOutgoingMessages.first(where: { $0.id == item.id }),
               finished.status == .failed || finished.status == .accepted {
                self.drainOutgoingQueueIfPossible()
            }
        }
    }

    static func isOrganizationBillingGuard(code: String, category: String?) -> Bool {
        let normalizedCategory = category?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let normalizedCode = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalizedCategory == "billing_blocked"
            || normalizedCategory == "organization_billing_guard"
            || normalizedCode == "billing_blocked"
            || normalizedCode == "organization_billing_guard"
    }

    /// 仅记录状态与截断关联 id；不记录正文、附件 URL、文件名或服务端原始错误体。
    private func logSendTransition(
        _ status: QueuedOutgoingMessageStatus,
        clientEventId: String?,
        messageId: String? = nil,
        taskId: String? = nil,
        detail: String? = nil
    ) {
        let detailValue = detail ?? "-"
        logger.info(
            "send_transition state=\(status.rawValue, privacy: .public) session=\(Self.shortId(self.sessionId), privacy: .public) client=\(Self.shortId(clientEventId), privacy: .public) message=\(Self.shortId(messageId), privacy: .public) task=\(Self.shortId(taskId), privacy: .public) detail=\(detailValue, privacy: .public)"
        )
    }

    private static func shortId(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "-" }
        return String(value.prefix(8))
    }

    private static func isFailureTerminal(_ update: StreamUpdate) -> Bool {
        let failure: AgentRunFailurePresentation?
        switch update {
        case let .done(stopReason, errorInfo):
            failure = AgentRunFailurePresentation(
                errorMessage: errorInfo?.message,
                errorClass: errorInfo?.errorClass,
                errorCategory: errorInfo?.errorCategory,
                errorCode: errorInfo?.errorCode,
                suggestedAction: errorInfo?.suggestedAction,
                stopReason: stopReason
            )
        case let .error(errorInfo):
            failure = AgentRunFailurePresentation(
                errorMessage: errorInfo.message,
                errorClass: errorInfo.errorClass,
                errorCategory: errorInfo.errorCategory,
                errorCode: errorInfo.errorCode,
                suggestedAction: errorInfo.suggestedAction,
                stopReason: nil
            )
        default:
            return false
        }
        return failure != nil
    }

    private func projectSessionRunState(from envelope: WSEnvelope) {
        guard let runId = envelope.payloadString("run_id"), !runId.isEmpty else { return }
        let shortType = String(envelope.type.dropFirst(AgentStreamEvent.prefix.count))

        switch shortType {
        case AgentStreamEvent.messageStart:
            // ：后台命令终态的合成 mini-message（role="user"）携带的只是占位 run_id
            // （wire schema 要求非空，Django merge 对它忽略），且永远等不到配对的 done——
            // 不能据它把会话标为运行中。仅 role 缺失（旧 relay 兼容）或 role="assistant" 才标记。
            let role = envelope.payloadString("role")
            guard role == nil || role == "assistant" else { return }
            RecentSessionsStore.shared.markRunStarted(
                sessionId: sessionId,
                runId: runId,
                status: .running,
                beginsNewRun: false
            )
        case AgentStreamEvent.persistError:
            RecentSessionsStore.shared.markRunTerminal(
                sessionId: sessionId,
                runId: runId,
                status: .failed
            )
        case AgentStreamEvent.done:
            RecentSessionsStore.shared.markRunTerminal(
                sessionId: sessionId,
                runId: runId,
                status: Self.localTerminalStatus(from: envelope)
            )
        case AgentStreamEvent.lifecycle:
            guard let rawPhase = envelope.payloadString("phase")?.lowercased() else { return }
            switch rawPhase {
            case "start", "starting", "queued", "running", "planning", "executing", "responding":
                RecentSessionsStore.shared.markRunStarted(
                    sessionId: sessionId,
                    runId: runId,
                    status: rawPhase == "queued" ? .queued : .running
                )
            case "waiting_user", "waiting_for_user":
                RecentSessionsStore.shared.markRunStarted(
                    sessionId: sessionId,
                    runId: runId,
                    status: .waitingUser
                )
            case "paused":
                RecentSessionsStore.shared.markRunStarted(
                    sessionId: sessionId,
                    runId: runId,
                    status: .paused
                )
            case "cancelling":
                RecentSessionsStore.shared.markRunStarted(
                    sessionId: sessionId,
                    runId: runId,
                    status: .cancelling
                )
            case "completed", "done", "failed", "cancelled", "interrupted":
                let status = SessionRunStatus(rawValue: rawPhase) ?? .completed
                RecentSessionsStore.shared.markRunTerminal(
                    sessionId: sessionId,
                    runId: runId,
                    status: status
                )
            default:
                break
            }
        default:
            break
        }
    }

    private static func localTerminalStatus(from envelope: WSEnvelope) -> SessionRunStatus {
        let rawStatus = envelope.payloadString("status")?.lowercased()
        if let rawStatus, let status = SessionRunStatus(rawValue: rawStatus), status.isTerminal {
            return status
        }
        let stopReason = envelope.payloadString("stop_reason")?.lowercased() ?? ""
        if stopReason.contains("cancel") || stopReason.contains("abort") {
            return .cancelled
        }
        if envelope.payloadBool("error") == true
            || envelope.payloadString("error_class")?.isEmpty == false
            || envelope.payloadString("error_message")?.isEmpty == false {
            return .failed
        }
        return .completed
    }

    private static func billingTitle(code: String, category: String?) -> String {
        let raw = "\(code) \(category ?? "")".lowercased()
        if raw.contains("member") { return "成员额度受限" }
        if raw.contains("quota") { return "会话额度已用完" }
        return "计费状态阻断"
    }

    private func clearMySendTracking() {
        sendWatchdog?.cancel(); sendWatchdog = nil
        myTaskId = nil
        activeSubmittedMessage = nil
        pendingUnattributedExecutionEvidenceClientId = nil
        discardingCancelledRun = false
        setCanCancel(false)
        stopRequestState = .idle
    }

    private func setCanCancel(_ value: Bool, armIfNewlyEnabled: Bool = true) {
        if value {
            if !canCancel {
                canCancelArmedAt = armIfNewlyEnabled ? Date.now : .distantPast
            }
        } else {
            canCancelArmedAt = nil
        }
        canCancel = value
    }

    private func beginRunControlRequest() -> Int {
        runControlGeneration += 1
        return runControlGeneration
    }

    private func invalidateRunControlRequests() {
        runControlGeneration += 1
    }

    private func isCurrentRunControlRequest(_ generation: Int) -> Bool {
        runControlGeneration == generation
    }

    /// A terminal stream event is authoritative and makes all outstanding ACKs stale.
    private func settleRunControls() {
        invalidateRunControlRequests()
        isPaused = false
        pauseControlPending = false
        stopRequestState = .idle
    }

    @discardableResult
    private func refreshSessionControlState(
        expectedGeneration: Int? = nil
    ) async -> SessionAutoDrainSequence.StepResult {
        let generation = expectedGeneration ?? runControlGeneration
        do {
            let session: ChatSession = try await APIClient.shared.get(
                path: Endpoints.Chat.session(sessionId)
            )
            guard isCurrentRunControlRequest(generation) else { return .failure }
            // ：拉取 session 时无 dirty 则采用服务端工作方式。
            applyServerAgentMode(session.agentMode, approvalMode: session.approvalMode)
            if let runState = session.runState {
                applyAuthoritativeRunState(
                    runState,
                    sessionRequestedPause: session.isPaused == true
                )
            } else {
                // 旧后端兼容：没有 run_state 时才回退到会话级 is_paused。
                isPaused = session.isPaused == true
                if isPaused { setCanCancel(true) }
            }
            if let readState = session.readState {
                applyReadState(readState)
            }
            return .success
        } catch {
            logger.debug("load session control state failed: \(error.localizedDescription)")
            return .failure
        }
    }

    /// 消费用户级 run-state 事件。独立于 session stream projector：该事件没有
    /// `agent.stream.*` topic，也不应生成消息气泡。
    @discardableResult
    func consumeAuthoritativeRunStateEnvelope(_ envelope: WSEnvelope) -> Bool {
        guard envelope.type == "chat.session.run_state.updated",
              envelope.payloadString("session_id") == sessionId,
              let state = envelope.decodePayloadField(
                "run_state",
                as: SessionRunState.self,
                encoder: JSONEncoder(),
                decoder: JSONDecoder()
              ) else { return false }
        if let expectedOrganizationId = organizationId,
           let eventOrganizationId = envelope.payloadString("organization_id"),
           eventOrganizationId != expectedOrganizationId {
            return false
        }
        applyAuthoritativeRunState(state)
        return true
    }

    @discardableResult
    func consumeReadStateEnvelope(_ envelope: WSEnvelope) -> Bool {
        guard envelope.type == "chat.session.read_state.updated",
              envelope.payloadString("session_id") == sessionId else { return false }
        if let expectedOrganizationId = organizationId,
           let eventOrganizationId = envelope.payloadString("organization_id"),
           eventOrganizationId != expectedOrganizationId {
            return false
        }
        let state = envelope.decodePayloadField(
            "read_state",
            as: SessionReadState.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        ) ?? envelope.decodePayload(
            as: SessionReadState.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        )
        guard let state else { return false }
        applyReadState(state)
        return true
    }

    private func applyReadState(_ state: SessionReadState) {
        authoritativeReadState = state
        if state.pendingAck(sessionId: sessionId) != nil {
            scheduleReadAckAfterContentReconcile()
        }
    }

    /// HTTP 冷启动快照与 realtime 增量共用同一个单调 reducer。
    func applyAuthoritativeRunState(
        _ incoming: SessionRunState,
        sessionRequestedPause: Bool = false
    ) {
        let current = SessionRunProjection(
            authoritative: authoritativeRunState,
            localOverlay: nil
        )
        let updated = SessionRunProjectionReducer.applying(
            authoritative: incoming,
            to: current
        )
        let changed = updated.authoritative != authoritativeRunState
        if changed {
            authoritativeRunState = updated.authoritative
        }
        let status = updated.authoritative?.status ?? incoming.status
        guard changed || sessionRequestedPause else { return }

        if status.isTerminal {
            if changed {
                setCanCancel(false)
                settleRunControls()
                scheduleReadAckAfterContentReconcile()
            }
            return
        }
        if changed {
            setCanCancel(status != .cancelling)
            if status == .cancelling {
                stopRequestState = .acknowledgedAwaitingTerminal
            }
        }
        let pause = PauseControlPolicy.afterRunState(
            status,
            currentlyPending: pauseControlPending,
            sessionRequestedPause: sessionRequestedPause
        )
        isPaused = pause.isPaused
        pauseControlPending = pause.isPauseControlPending
    }

    /// 对话面板真实可见时才允许终态自动已读；默认 false，等 Screen 上报可见性（fail-closed）。
    /// 工作台 / 胶囊态保持 unread 完整胶囊。
    private(set) var isConversationContentVisible = false

    func setConversationContentVisible(_ visible: Bool) {
        let wasVisible = isConversationContentVisible
        isConversationContentVisible = visible
        // 从不可见回到可见时，若仍有待 ACK，再走一次门禁后的对账已读。
        if visible, !wasVisible,
           authoritativeReadState?.pendingAck(sessionId: sessionId) != nil
            || authoritativeRunState?.status.isTerminal == true {
            scheduleReadAckAfterContentReconcile()
        }
    }

    private func acknowledgeReadIfContentHydrated() {
        guard !isReadOnly,
              listening,
              hasHydratedServerHistory,
              ConversationAutoReadVisibilityGate.allowsAutoReadAck(
                  isConversationContentVisible: isConversationContentVisible
              ),
              !projector.isStreamingActive else { return }
        // 新契约的未读可能指向“当前 queued/failed 之前的最近 completed”。
        // 因此永远优先 ACK read_state 的 latest-completed 游标；仅为旧后端回退当前 completed。
        let candidate = authoritativeReadState?.pendingAck(sessionId: sessionId)
            ?? authoritativeRunState.flatMap { runState in
                guard runState.status == .completed else { return nil }
                return PendingSessionReadAck(
                    sessionId: sessionId,
                    throughRunId: runState.runId,
                    throughSequence: runState.sequence,
                    throughRevision: runState.revision,
                    mutationId: UUID().uuidString
                )
            }
        guard let candidate else { return }
        Task {
            await SessionReadStore.shared.acknowledgeContentDisplayed(candidate)
        }
    }

    /// 终态事件可能早于 assistant 消息提交；先完成一次强制历史对账，再推进阅读水位。
    /// 对话不可见时（工作台 / app-focus）禁止调度，避免胶囊未读被约 600ms 清掉。
    private func scheduleReadAckAfterContentReconcile() {
        guard ConversationAutoReadVisibilityGate.allowsAutoReadAck(
            isConversationContentVisible: isConversationContentVisible
        ) else {
            readAckTask?.cancel()
            readAckTask = nil
            return
        }
        readAckTask?.cancel()
        readAckTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard let self, self.listening, !Task.isCancelled,
                  ConversationAutoReadVisibilityGate.allowsAutoReadAck(
                      isConversationContentVisible: self.isConversationContentVisible
                  ),
                  !self.projector.isStreamingActive else { return }
            let hydrated = await self.refreshHistorySucceeded(
                forceFull: true,
                advanceWatermark: false
            )
            guard hydrated else { return }
            self.hasHydratedServerHistory = true
            self.acknowledgeReadIfContentHydrated()
        }
    }

    /// 连接不可用/已断开这件事，一旦恢复链路（Banner）已经在说，pause/resume/stop
    /// 失败就不该再用 `actionError` 重复报一遍——两个提示会同时挂在顶部，且措辞不一致。
    /// 非连接类失败（如服务端拒绝、超时）仍照常走 `actionError`，因为恢复 Banner 不
    /// 拥有那类事实。
    private var connectionFactOwnedByRecoveryBanner: Bool {
        connectionInterrupted || (recoveryState != .idle && recoveryState != .synced)
    }

    func pause() {
        setPaused(true)
    }

    func resume() {
        setPaused(false)
    }

    private func setPaused(_ paused: Bool) {
        guard !pauseControlPending, stopRequestState != .requesting, isPaused != paused else { return }
        let generation = beginRunControlRequest()
        pauseControlPending = true
        actionError = nil
        Task { [weak self] in
            guard let self else { return }
            guard self.isCurrentRunControlRequest(generation) else { return }
            guard await self.gateway.ensureConnected() else {
                guard self.isCurrentRunControlRequest(generation) else { return }
                self.pauseControlPending = false
                if !self.connectionFactOwnedByRecoveryBanner {
                    self.actionError = "连接不可用，请稍后重试"
                }
                self.publishNow()
                await self.refreshSessionControlState(expectedGeneration: generation)
                return
            }
            guard self.isCurrentRunControlRequest(generation) else { return }
            let action = paused ? "pause" : "resume"
            let result = await self.gateway.sendRequest(
                type: "chat.\(action)",
                payload: ["session_id": self.sessionId],
                okType: "chat.\(action).ok",
                nakType: "chat.\(action).nak",
                threadId: self.threadId,
                timeout: 15
            )
            guard self.isCurrentRunControlRequest(generation) else { return }
            var acknowledged = false
            switch result {
            case .ok:
                acknowledged = true
                let pause = PauseControlPolicy.afterAck(
                    requestedPause: paused,
                    ackSucceeded: true,
                    currentlyPaused: self.isPaused,
                    currentlyPending: self.pauseControlPending
                )
                self.isPaused = pause.isPaused
                self.pauseControlPending = pause.isPauseControlPending
                if pause.isPaused { self.setCanCancel(true) }
            case let .nak(code, message, _, _, _, _, _, _):
                let pause = PauseControlPolicy.afterAck(
                    requestedPause: paused,
                    ackSucceeded: false,
                    currentlyPaused: self.isPaused,
                    currentlyPending: self.pauseControlPending
                )
                self.isPaused = pause.isPaused
                self.pauseControlPending = pause.isPauseControlPending
                self.actionError = Self.humanizedSendError(
                    code: code,
                    message: message,
                    fallback: "任务控制失败，请稍后重试"
                )
            case .timeout:
                let pause = PauseControlPolicy.afterAck(
                    requestedPause: paused,
                    ackSucceeded: false,
                    currentlyPaused: self.isPaused,
                    currentlyPending: self.pauseControlPending
                )
                self.isPaused = pause.isPaused
                self.pauseControlPending = pause.isPauseControlPending
                self.actionError = "任务控制超时，请稍后重试"
            case .disconnected:
                let pause = PauseControlPolicy.afterAck(
                    requestedPause: paused,
                    ackSucceeded: false,
                    currentlyPaused: self.isPaused,
                    currentlyPending: self.pauseControlPending
                )
                self.isPaused = pause.isPaused
                self.pauseControlPending = pause.isPauseControlPending
                if !self.connectionFactOwnedByRecoveryBanner {
                    self.actionError = "连接已断开，请稍后重试"
                }
            }
            self.publishNow()
            if !acknowledged {
                await self.refreshSessionControlState(expectedGeneration: generation)
            }
        }
    }

    /// Composer Stop 先在本机即时收口，再把取消交给执行端：
    /// - 助手尚无正文/工具产出：撤回本轮并把文字交还 Composer；
    /// - 已有实质产出：保留时间线，只定格当前回复。
    ///
    /// 旧 run 的尾部事件在后台等终态/宽限收敛，不能反过来让 Stop 按钮继续转。
    @discardableResult
    func cancel() -> String? {
        guard ConversationStopRequestPolicy.canRequest(
            hasActiveRun: canCancel,
            isPaused: isPaused,
            state: stopRequestState,
            pauseControlPending: pauseControlPending,
            elapsedSinceCanCancel: elapsedSinceCanCancel
        ) else { return nil }

        let submitted = activeSubmittedMessage
        let shouldWithdraw = submitted.map {
            !projector.hasSubstantiveAssistantOutput(afterUserMessageId: $0.clientEventId)
        } ?? false
        let restoredText = shouldWithdraw ? submitted?.text : nil

        stopRequestState = .requesting
        actionError = nil
        sendWatchdog?.cancel(); sendWatchdog = nil
        acceptedReconcileTask?.cancel(); acceptedReconcileTask = nil
        cancelledRunIdentity = ConversationCancelledRunIdentity(
            clientEventId: submitted?.clientEventId,
            taskId: myTaskId
        )
        discardingCancelledRun = true
        setCanCancel(false)
        isPaused = false
        pauseControlPending = false

        if let submitted, shouldWithdraw {
            // 进入等待 withdraw_applied；收到 true 前不豁免（超时/缺失走现状对账）。
            withdrawReconcileGate = WithdrawTerminalReconcilePolicy.beginWithdraw(
                clientEventId: submitted.clientEventId
            )
            projector.withdrawUnansweredTurn(userMessageId: submitted.clientEventId)
            flushingQueueItemIds.remove(submitted.queueId)
            outgoingQueue.delete(id: submitted.queueId)
            reloadOutgoingQueue()
        } else {
            withdrawReconcileGate = WithdrawTerminalReconcilePolicy.clearPending()
            projector.endStreaming()
        }
        activeSubmittedMessage = nil
        publishNow()
        cache.cacheMessages(sessionId: sessionId, messages: projector.messages)

        var payload: [String: Any] = ["session_id": sessionId]
        if let taskId = myTaskId { payload["task_id"] = taskId }
        if let submitted {
            // 即使只停止、不撤回，也携带稳定来源 ID；服务端 ABORT 镜像与 runtime
            // 迟到尾事件都靠它和下一轮严格隔离。
            payload["client_message_id"] = submitted.clientEventId
        }
        if let submitted, shouldWithdraw {
            payload["withdraw_unanswered"] = true
            payload["target_content"] = submitted.text
        }
        Task { [weak self] in
            guard let self else { return }
            guard await self.gateway.ensureConnected() else {
                let result: ConversationStopRequestResult = .disconnected
                self.stopRequestState = ConversationStopRequestPolicy.state(after: result)
                if !self.connectionFactOwnedByRecoveryBanner {
                    self.actionError = ConversationStopRequestPolicy.message(for: result)
                }
                self.discardingCancelledRun = false
                self.cancelledRunIdentity = nil
                self.setCanCancel(true, armIfNewlyEnabled: false)
                // 未确认撤回 → 清门控，走现状对账（可能回拉，作为断连兜底）。
                self.withdrawReconcileGate = WithdrawTerminalReconcilePolicy.clearPending()
                self.scheduleTerminalReconcile(delaysMs: [0, 1_000])
                self.publishNow()
                return
            }
            let ack = await self.gateway.sendRequest(
                type: "chat.cancel",
                payload: payload,
                okType: "chat.cancel.ok",
                nakType: "chat.cancel.nak",
                threadId: self.threadId,
                timeout: 15
            )
            let result: ConversationStopRequestResult
            switch ack {
            case let .ok(payload):
                result = .acknowledged
                // chat.cancel.ok 可选 withdraw_applied：与 done 事件同源门控。
                self.noteWithdrawAppliedSignal(payload["withdraw_applied"]?.boolValue)
            case let .nak(_, message, _, _, _, _, _, _):
                result = .rejected(message: message)
            case .timeout:
                result = .timedOut
            case .disconnected:
                result = .disconnected
            }
            self.stopRequestState = ConversationStopRequestPolicy.state(after: result)
            if result != .disconnected || !self.connectionFactOwnedByRecoveryBanner {
                self.actionError = ConversationStopRequestPolicy.message(for: result)
            }
            if case .acknowledged = result {
                if let submitted {
                    // 当前条已被明确取消，不再让它以 accepted tracking 残留在本机队列，
                    // 否则下一条虽然已经直发，Composer 仍会误显示「消息排队中」。
                    self.flushingQueueItemIds.remove(submitted.queueId)
                    self.outgoingQueue.delete(id: submitted.queueId)
                    self.reloadOutgoingQueue()
                }
                if self.discardingCancelledRun {
                    // ACK 前服务端已把 ABORT 控制终态写入 session topic。此处立即释放
                    // 本地发送门闩；旧 run 后续尾事件仍由 cancelledRun* 关联键精确丢弃。
                    self.finishCancelledRunTail()
                } else {
                    self.stopRequestState = .idle
                }
            } else {
                self.discardingCancelledRun = false
                self.cancelledRunIdentity = nil
                self.setCanCancel(true, armIfNewlyEnabled: false)
                // 超时 / nak：清撤回豁免标记，终态对账按现状回拉。
                self.withdrawReconcileGate = WithdrawTerminalReconcilePolicy.clearPending()
                self.scheduleTerminalReconcile(delaysMs: [0, 1_000])
            }
            self.publishNow()
        }
        return restoredText
    }

    /// 应用 `withdraw_applied`（来自 cancel.ok 或 stream.done）。`true` 时取消已排队的终态对账。
    private func noteWithdrawAppliedSignal(_ withdrawApplied: Bool?) {
        withdrawReconcileGate = WithdrawTerminalReconcilePolicy.applySignal(
            withdrawReconcileGate,
            withdrawApplied: withdrawApplied
        )
        if WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(withdrawReconcileGate) {
            reconcileTask?.cancel()
            reconcileTask = nil
        }
    }

    private func finishCancelledRunTail() {
        reducer = StreamSession()
        lastSeq = nil
        contextRuntimeState = reducer.contextRuntimeState
        projector.endStreaming()
        clearMySendTracking()
        actionError = nil
        publishNow()
        cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
        // withdraw_applied=true 时跳过终态对账，避免 GET /messages 把已撤轮次拉回。
        // false / 字段缺失 / 仍在 awaiting：走现状短重试对账。
        scheduleTerminalReconcile(delaysMs: [600, 1_600, 3_000])
        drainOutgoingQueueIfPossible()
    }

    // MARK: - 非阻断提案动作（plan / mode_switch）

    func executePlan(_ proposal: PlanProposal) async -> PlanExecutionResult {
        let cardId = "plan_\(proposal.planDocumentId)"
        let executionKey = "\(sessionId):\(proposal.planDocumentId)"
        if acceptedPlanExecutionKeys.contains(executionKey)
            || projector.messages.first(where: { $0.id == cardId })?.proposalResolved == true {
            return .alreadyAccepted
        }
        guard activePlanExecutionKeys.insert(executionKey).inserted else {
            return .alreadyAccepted
        }
        defer { activePlanExecutionKeys.remove(executionKey) }

        actionError = nil
        // ：执行不再走 Django /plan/exit。关键事务顺序是：
        // 先以 agent override 把继续消息持久化进本地发送队列；成功后才切当前模式和标卡片。
        // 这样模型缺失 / 队列落盘失败时，UI 仍保持未执行且可重试，不会出现“已执行但没发出”。
        let nameSuffix = proposal.planName.isEmpty ? "" : "「\(proposal.planName)」"
        let pointer = proposal.planDocumentId.isEmpty ? "" : "plan 指针：`\(proposal.planDocumentId)`，"
        let snapshot = proposal.descriptionMarkdown.isEmpty ? proposal.overview : proposal.descriptionMarkdown
        let body = snapshot.isEmpty
            ? "（快照正文为空——请先按指针重读 plan，或用 ask_user 与用户确认要执行的具体内容。）"
            : snapshot
        let prompt = "请按已批准的 Plan\(nameSuffix)开始执行。\(pointer)执行前先读取 plan 最新内容再动手。\n\n\(body)"
        guard send(prompt, agentMode: "agent") else {
            return .failed(actionError ?? "启动执行失败，请重试。")
        }

        setAgentMode("agent")
        acceptedPlanExecutionKeys.insert(executionKey)
        projector.markProposalResolved(id: cardId)
        cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
        publishNow()
        return .accepted
    }

    func approveModeSwitch(_ proposal: ModeSwitchProposal) {
        let cardId = "mode_\(proposal.proposalId)"
        setAgentMode("agent")
        projector.markProposalResolved(id: cardId)
        publishNow()
        let prompt = proposal.reason.isEmpty
            ? "继续执行（已切换到 Agent 模式）"
            : "继续执行（已切换到 Agent 模式）：\(proposal.reason)"
        send(prompt)
    }

    func ignoreProposal(cardId: String) {
        projector.markProposalResolved(id: cardId)
        publishNow()
    }

    // MARK: - Private

    /// 轮次收尾 / 重连后从 HTTP 重拉权威历史整体校正。仅非流式时执行；失败静默——校正是增益。
    private func scheduleReconcile(delayMs: Int) {
        scheduleReconcileSequence(delaysMs: [delayMs])
    }

    /// ACK 已受理后主动做短周期 HTTP 增量对账；USER mirror 丢失时也能确认落库。
    private func scheduleAcceptedReconcile(queueId: String) {
        acceptedReconcileTask?.cancel()
        acceptedReconcileTask = Task { @MainActor [weak self] in
            for delayMs in [800, 3_000, 10_000] {
                try? await Task.sleep(for: .milliseconds(delayMs))
                guard let self, !Task.isCancelled else { return }
                _ = await self.reconcileAcceptedOutgoing(queueId: queueId)
                self.reloadOutgoingQueue()
                if !self.queuedOutgoingMessages.contains(where: { $0.id == queueId }) { return }
            }
        }
    }

    /// App 重启/重新进入会话时，逐条恢复所有仍待持久化确认的 ACK。
    /// 每条调用 `reconcileAcceptedOutgoing`，由其使用 message_id/client_event_id 作为 around 锚点。
    private func reconcileAllAcceptedOutgoingOnSessionStart() async {
        reloadOutgoingQueue()
        let queueIds = QueuedOutgoingMessage.acceptedQueueIdsForReconciliation(
            in: queuedOutgoingMessages
        )
        for queueId in queueIds {
            guard listening, !Task.isCancelled else { return }
            _ = await reconcileAcceptedOutgoing(queueId: queueId)
        }
    }

    /// 不受 optimistic assistant `isStreamingActive` 影响的 bounded HTTP 对账。
    /// 优先按发送前水位拉增量；旧后端无水位时只拉 latest page，避免全量分页。
    @discardableResult
    private func reconcileAcceptedOutgoing(queueId: String, limit: Int = 100) async -> Bool {
        reloadOutgoingQueue()
        guard let item = queuedOutgoingMessages.first(where: { $0.id == queueId }) else { return true }
        do {
            // USER id 当前与 client_event_id 同 UUID；ACK 若回 server message_id 则优先用它。
            let anchor = item.serverMessageId ?? item.clientEventId
            let response: MessageHistoryResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionMessages(sessionId),
                query: ["limit": String(limit), "around": anchor]
            )
            if let serverTimestamp = response.serverTimestamp, !serverTimestamp.isEmpty {
                historySyncWatermark = serverTimestamp
            }
            let authoritative = MessageHistoryMapper.map(response.messages)
            confirmAcceptedOutgoing(from: authoritative)
            let didChange = projector.mergeCommittedHistory(authoritative)
            if didChange {
                publishNow()
                cache.cacheMessages(sessionId: sessionId, messages: projector.messages)
            }
            reloadOutgoingQueue()
            return !queuedOutgoingMessages.contains(where: { $0.id == queueId })
        } catch {
            logger.warning("accepted reconcile failed queue=\(Self.shortId(queueId), privacy: .public)")
            return false
        }
    }

    /// 轮次终态后的短重试：WS 终态可能早于 assistant 消息落入历史页。
    /// 这里强制拉完整最新页，且不推进增量水位，避免把晚到历史挡在水位之前。
    ///
    /// ：`withdraw_applied=true` 豁免本路径（含其驱动的 `refreshHistoryFull`），
    /// 防止权威历史覆盖本地已撤投影；睡眠间隙若晚到 true 也会在循环内再次检查并中止。
    private func scheduleTerminalReconcile(delaysMs: [Int]) {
        if WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(withdrawReconcileGate) {
            return
        }
        scheduleReconcileSequence(
            delaysMs: delaysMs,
            forceFull: true,
            advanceWatermark: false,
            respectWithdrawExemption: true
        )
    }

    /// message_committed 是单条 message 的 DB 事实边界，可能与下一条 message_start
    /// 交错。这里用 streaming-safe merge，不因后续气泡正在流式而跳过，也不整体替换列表。
    private func scheduleCommittedReconcile(delaysMs: [Int]) {
        reconcileTask?.cancel()
        reconcileTask = Task { @MainActor [weak self] in
            for delayMs in delaysMs {
                if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                guard let self, !Task.isCancelled else { return }
                _ = await self.refreshCommittedHistory()
            }
        }
    }

    private static func humanizedSendError(code: String, message: String, fallback: String) -> String {
        let trimmedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // 优先用人话 message；若 message 是 wire code / 空，则用 code 再走队列条同源映射。
        if !trimmedMessage.isEmpty {
            let fromMessage = OutgoingQueuePolicy.displayDetail(
                lastError: trimmedMessage,
                fallback: ""
            )
            if !fromMessage.isEmpty { return fromMessage }
        }
        if !trimmedCode.isEmpty {
            let fromCode = OutgoingQueuePolicy.displayDetail(
                lastError: trimmedCode,
                fallback: ""
            )
            if !fromCode.isEmpty { return fromCode }
        }
        return fallback
    }

    private func scheduleReconcileSequence(
        delaysMs: [Int],
        forceFull: Bool = false,
        advanceWatermark: Bool = true,
        respectWithdrawExemption: Bool = false
    ) {
        reconcileTask?.cancel()
        reconcileTask = Task { @MainActor [weak self] in
            for delayMs in delaysMs {
                if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                guard let self, !Task.isCancelled else { return }
                switch ConversationRecoveryPolicy.reconcileTick(
                    streamingActive: self.projector.isStreamingActive,
                    allowWhileStreaming: false
                ) {
                case .abort:
                    return
                case .skipWait:
                    continue
                case .apply:
                    break
                }
                // 终态对账睡眠期间可能晚到 withdraw_applied=true；到点再判一次以免回拉。
                if respectWithdrawExemption,
                   WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(self.withdrawReconcileGate) {
                    return
                }
                _ = await self.refreshHistorySucceeded(
                    forceFull: forceFull,
                    advanceWatermark: advanceWatermark
                )
            }
        }
    }
}
