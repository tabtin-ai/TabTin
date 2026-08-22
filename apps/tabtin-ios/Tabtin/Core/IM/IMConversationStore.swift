import Foundation
import os

/// 用户级 IM 实时事件源。会话 Store 只消费原始领域信封，不感知 Centrifugo 或其他 SDK。
@MainActor
protocol IMPersonalRealtimeSource: AnyObject {
    func setPersonalPublicationListener(_ listener: (@MainActor (Data) -> Void)?)
    /// personal subscription 确认可用后触发，供目录层在没有订阅空窗的前提下补拉权威快照。
    func setConnectionAvailableListener(_ listener: (@MainActor () -> Void)?)
}

@MainActor
private final class NoopIMPersonalRealtimeSource: IMPersonalRealtimeSource {
    static let shared = NoopIMPersonalRealtimeSource()
    func setPersonalPublicationListener(_ listener: (@MainActor (Data) -> Void)?) {}
    func setConnectionAvailableListener(_ listener: (@MainActor () -> Void)?) {}
}

/// 会话目录数据面。列表与正文搜索共享同一领域接口，
/// 避免单测为了触发网络错误而接入真实传输。
@MainActor
protocol IMConversationDataPlane: AnyObject {
    func listConversations(organizationId: String) async throws -> [IMConversation]
    func searchMessages(organizationId: String, query: String) async throws -> [IMMessageSearchResult]
    func setConversationChangedListener(_ listener: (@MainActor @Sendable () -> Void)?)
    func pinConversation(conversationId: String, pinned: Bool) async throws
    func setConversationMuted(conversationId: String, muted: Bool) async throws
    func leaveConversation(conversationId: String) async throws
    func markConversationRemoved(conversationId: String)
    func clearSession()
}

extension IMConversationDataPlane {
    func pinConversation(conversationId: String, pinned: Bool) async throws { throw IMTransportError.unsupported }
    func setConversationMuted(conversationId: String, muted: Bool) async throws { throw IMTransportError.unsupported }
    func leaveConversation(conversationId: String) async throws { throw IMTransportError.unsupported }
}

struct IMPersonalNotice: Identifiable, Equatable {
    enum Kind: Equatable {
        case aiError
        case aiSuggestTask
    }

    let id = UUID()
    let kind: Kind
    let agentName: String
    let reason: String
    let conversationId: String?
    let messageId: Int?
}

/// TabChat IM 会话列表 store。
///
/// 负责加载会话清单、进会话清未读，以及监听会话变化刷新角标。
@MainActor
@Observable
final class IMConversationStore {
    static let shared = IMConversationStore(personalRealtimeSource: CentrifugoClient.shared)

    /// 全局「近期已计入未读」message_id 环形上限：超过则淘汰最旧。仅用于抵御 realtime 重投去重。
    private static let maxRecentAppliedMessageIds = 512

    private(set) var conversations: [IMConversation] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    /// 会话置顶写入失败时的用户可见提示；由消息页统一呈现。
    private(set) var pinActionError: String?
    /// 会话免打扰写入失败时的用户可见提示；由消息页统一呈现。
    private(set) var muteActionError: String?
    private(set) var searchResults: [IMMessageSearchResult] = []
    private(set) var isSearching = false
    private(set) var searchError: String?
    private(set) var personalNotice: IMPersonalNotice?
    /// 参与者资料变化版本；活动会话观察它重拉成员快照。
    private(set) var profileRevision = 0

    /// 当前 organization 的 IM 未读总数。只从 conversations 派生，不维护第二份状态。
    var aggregateUnreadCount: Int {
        conversations.reduce(into: 0) { total, conversation in
            let unread = max(0, conversation.unreadCount)
            total = unread > Int.max - total ? Int.max : total + unread
        }
    }

    /// 当前前台打开的会话 id：该会话上的 personal 未读增量应被忽略（详情页已在读）。
    private(set) var activeConversationId: String?

    private let dataPlane: IMConversationDataPlane
    private let personalRealtimeSource: IMPersonalRealtimeSource
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "IMConversationStore")
    private var loadTask: Task<Void, Never>?
    /// 置顶写为显式 bool；同一会话在请求未完成时必须串行，避免响应乱序把状态翻错。
    private var pinMutationInFlight: Set<String> = []
    /// 免打扰同样写显式 bool；同一会话的写入保持串行。
    private var muteMutationInFlight: Set<String> = []
    /// 加载代次：只有最新一代允许写状态 / 复位 `isLoading`，避免并发或乱序响应
    /// 覆盖列表、卡住 spinner（下拉刷新与主动加载可能交错）。
    private var loadGeneration = 0
    private var searchGeneration = 0
    private var organizationId: String?
    private var isListeningPersonal = false
    /// 未知会话（尚未在列表）的未读缓冲：`im.unread.update` 可能早于 `im.conversation.new` 到达，
    /// 先缓存增量，待会话插入时回放。org 切换 / 登出 / 已读回写清空。
    private var bufferedUnread: [String: BufferedUnread] = [:]
    /// 会话快照在撤回后可能短暂继续返回旧 lastMessage preview。这里仅记住“最后一条 seq
    /// 已被撤回”的本地事实，直到更高 seq 的新消息到达，避免外层列表被陈旧快照打回旧文案。
    private var latestPreviewOverrides: [String: LatestPreviewOverride] = [:]
    /// 列表请求在途时，各会话「窗口内到达的新消息」累积：非 nil 表示有 load 在飞、正在收集。
    /// 结果落地按 baseline/delta 合并——只有 `seq > 快照水位`（快照未含）的窗口消息才计入净增量，
    /// 避免用陈旧本地绝对值覆盖权威快照、也不与快照已含的消息重复计数（见 `commitMerged`）。
    /// preview 随最高 seq 一起保存：realtime 可乱序到达，只有更高 seq 的 preview 才代表更新的摘要。
    private var loadWindow: [String: WindowUnreadAccum]?
    /// 列表请求在途时经 `im.conversation.new` 新插入的会话 id：结果落地若快照尚未包含则整条保留。
    private var loadWindowInserted: Set<String> = []
    /// 全局有界「近期已计入未读的 message_id」（`message_id` 为 Message 主键、全局唯一）：
    /// Centrifugo 重连/重投同一消息时不再对已知或未知会话重复 +1。`recentAppliedOrder` 记录插入序做环形淘汰。
    private var recentAppliedMessageIds: Set<Int> = []
    private var recentAppliedOrder: [Int] = []
    /// 当前组织内由数据面成功确认的最大已读 seq。只在 mark-read 成功后推进，用来挡住
    /// clean 前已经发出的陈旧目录请求；切组织时连同 generation 一起失效。
    private var confirmedReadWaterlines: [String: Int] = [:]
    private var organizationGeneration = 0

    /// 加载窗口内某会话的未读累积：`seqs` 用于按快照水位算净增量；`preview`/`previewSeq`
    /// 只保留窗口内见过的最高 seq 对应预览，避免乱序（先 seq=10 后 seq=9）把摘要退回旧消息。
    private struct WindowUnreadAccum {
        var seqs: Set<Int> = []
        var mentionSeqs: Set<Int> = []
        var previewSeq: Int = -1
        var preview: String = ""
        var lastMessageAt: String?
    }

    private struct BufferedUnread {
        /// 已缓冲的未读条数（入口已按 message_id 全局去重，这里只需计数）。
        var count: Int = 0
        /// 缓冲的最新预览随最高 seq 保存：乱序到达时不把摘要退回旧消息。
        var previewSeq: Int = -1
        var preview: String = ""
        var lastMessageAt: String?
        /// 缓冲窗口内是否至少有一条消息提到当前用户。
        var hasMention = false
    }

    private struct LatestPreviewOverride {
        let messageSeq: Int
        let preview: String
        let lastMessageAt: String?
    }

    init(
        dataPlane: IMConversationDataPlane = DjangoIMAdapter.shared,
        personalRealtimeSource: IMPersonalRealtimeSource = NoopIMPersonalRealtimeSource.shared
    ) {
        self.dataPlane = dataPlane
        self.personalRealtimeSource = personalRealtimeSource
        // 登出时清空会话列表并断开实时通道（与其他 store 同约定，在 init 注册一次）。
        AuthService.shared.registerLogoutHook { [weak self] in
            self?.clear()
            CentrifugoClient.shared.disconnect()
        }
    }

    /// 拉取指定组织的会话列表（取消上一次未完成的加载）。
    func loadConversations(organizationId: String) {
        prepareOrganization(organizationId)
        guard !organizationId.isEmpty else { return }
        startListeningPersonalIfNeeded()
        startLoad(organizationId: organizationId)
    }

    /// 供下拉刷新等待完成的加载；与 `loadConversations` 共享取消 / 代次归属。
    func reload(organizationId: String) async {
        prepareOrganization(organizationId)
        guard !organizationId.isEmpty else { return }
        startListeningPersonalIfNeeded()
        await startLoad(organizationId: organizationId).value
    }

    /// 搜索当前 Organization 的历史正文。代次门禁保证旧关键字响应不会覆盖新结果。
    func searchMessages(organizationId: String, query: String) async {
        prepareOrganization(organizationId)
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchGeneration += 1
        let generation = searchGeneration
        searchResults = []
        searchError = nil
        guard !organizationId.isEmpty, !normalizedQuery.isEmpty else {
            isSearching = false
            return
        }
        isSearching = true
        defer {
            if generation == searchGeneration, self.organizationId == organizationId {
                isSearching = false
            }
        }
        do {
            try await Task.sleep(for: .milliseconds(250))
            guard generation == searchGeneration, self.organizationId == organizationId else { return }
            let result = try await dataPlane.searchMessages(
                organizationId: organizationId,
                query: normalizedQuery
            )
            guard generation == searchGeneration, self.organizationId == organizationId else { return }
            searchResults = result.filter { $0.conversation.directoryOrganizationId == organizationId }
        } catch is CancellationError {
            return
        } catch {
            guard generation == searchGeneration, self.organizationId == organizationId else { return }
            searchError = L10n.Messages.networkError
            logger.error("search IM messages failed org=\(organizationId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    /// 进入会话详情：登记活动会话 + **立刻清本地未读**（对齐 Electron 选中即清角标），
    /// 再由详情页 `markRead` REST 把服务端水位推上去。
    func enterConversation(_ conversationId: String) {
        activeConversationId = conversationId
        clearUnread(conversationId: conversationId)
    }

    /// 退出会话详情：取消活动会话登记（不影响已清零的本地未读）。
    func leaveConversation(_ conversationId: String) {
        if activeConversationId == conversationId {
            activeConversationId = nil
        }
    }

    /// 退出群聊成功后立即从本地会话列表移除，避免返回消息页仍看到已退出的群。
    func removeConversation(_ conversationId: String) {
        guard !conversationId.isEmpty else { return }
        leaveConversation(conversationId)
        dataPlane.markConversationRemoved(conversationId: conversationId)
        conversations.removeAll { $0.id == conversationId }
        confirmedReadWaterlines.removeValue(forKey: conversationId)
    }

    /// 发起异步传输层已读请求时捕获；回调时用于拒绝上一个组织的迟到成功结果。
    func captureReadContextGeneration() -> Int {
        organizationGeneration
    }

    /// 仅接收传输层已成功确认的实际已读 seq。若确认期间切换了组织，旧回调不得修改新列表。
    func acknowledgeRead(
        conversationId: String,
        throughSeq seq: Int,
        contextGeneration: Int
    ) {
        guard contextGeneration == organizationGeneration,
              !conversationId.isEmpty,
              seq > 0 else { return }
        confirmedReadWaterlines[conversationId] = max(confirmedReadWaterlines[conversationId] ?? 0, seq)
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }),
              conversations[index].lastMessageSeq <= seq else { return }
        var updated = conversations[index]
        updated.unreadCount = 0
        updated.labels.removeAll { $0.id == IMConversationLabel.systemMention.id }
        conversations[index] = updated
    }

    /// 把指定会话的本地未读清零（整条重赋，触发 @Observable UI 刷新）。
    func clearUnread(conversationId: String) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        let hasMention = conversations[index].labels.contains { $0.id == IMConversationLabel.systemMention.id }
        guard conversations[index].unreadCount != 0 || hasMention else { return }
        var updated = conversations[index]
        updated.unreadCount = 0
        updated.labels.removeAll { $0.id == IMConversationLabel.systemMention.id }
        conversations[index] = updated
    }

    /// 设置页改名成功后立即更新消息列表标题，避免返回列表仍显示旧群名。
    func updateConversationName(_ conversationId: String, name: String) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        guard conversations[index].name != name else { return }
        var updated = conversations[index]
        updated.name = name
        conversations[index] = updated
    }

    /// 群头像保存成功后立即更新会话列表，避免退出设置页后仍看到旧头像。
    func updateConversationAvatar(_ conversationId: String, avatarUrl: String) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        guard conversations[index].avatarUrl != avatarUrl else { return }
        var updated = conversations[index]
        updated.avatarUrl = avatarUrl
        conversations[index] = updated
    }

    /// 同一条最后消息发生状态变化（例如撤回）时，只更新会话摘要，不增加未读。
    /// 这类事件不是一条新消息；复用 unread update 会让活动会话直接 return，
    /// 或让非活动会话误 +1。
    func applyLatestPreviewUpdate(
        conversationId: String,
        messageSeq: Int,
        preview: String,
        lastMessageAt: String? = nil
    ) {
        guard !conversationId.isEmpty, !preview.isEmpty else { return }
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else {
            latestPreviewOverrides[conversationId] = LatestPreviewOverride(
                messageSeq: messageSeq,
                preview: preview,
                lastMessageAt: lastMessageAt
            )
            return
        }
        guard messageSeq >= conversations[index].lastMessageSeq else { return }
        var updated = conversations[index]
        updated.lastMessagePreview = preview
        updated.lastMessageSeq = max(updated.lastMessageSeq, messageSeq)
        if let lastMessageAt, !lastMessageAt.isEmpty {
            updated.lastMessageAt = lastMessageAt
        }
        conversations[index] = updated
        latestPreviewOverrides[conversationId] = LatestPreviewOverride(
            messageSeq: messageSeq,
            preview: preview,
            lastMessageAt: lastMessageAt
        )
    }

    private func applyLatestPreviewOverride(_ conversation: IMConversation) -> IMConversation {
        guard let override = latestPreviewOverrides[conversation.id] else { return conversation }
        if conversation.lastMessageSeq > override.messageSeq {
            latestPreviewOverrides.removeValue(forKey: conversation.id)
            return conversation
        }
        var updated = conversation
        updated.lastMessagePreview = override.preview
        updated.lastMessageSeq = max(updated.lastMessageSeq, override.messageSeq)
        if let lastMessageAt = override.lastMessageAt, !lastMessageAt.isEmpty {
            updated.lastMessageAt = lastMessageAt
        }
        return updated
    }

    /// 设置页切换免打扰成功后本地回写，按钮文案与列表状态无需等整表 reload。
    func updateMuteState(_ conversationId: String, muted: Bool) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        guard conversations[index].isMuted != muted else { return }
        var updated = conversations[index]
        updated.isMuted = muted
        conversations[index] = updated
    }

    /// 当前会话是否正在写入免打扰偏好；列表据此避免重复触发。
    func isTogglingMute(conversationId: String) -> Bool {
        muteMutationInFlight.contains(conversationId)
    }

    /// 乐观切换免打扰；写数据面显式目标值，失败只回滚当前会话状态。
    func toggleMute(conversationId: String) async {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }),
              !muteMutationInFlight.contains(conversationId) else { return }

        let previous = conversations[index].isMuted
        let confirmed = !previous
        muteMutationInFlight.insert(conversationId)
        updateMuteState(conversationId, muted: confirmed)
        defer { muteMutationInFlight.remove(conversationId) }

        do {
            try await dataPlane.setConversationMuted(
                conversationId: conversationId,
                muted: confirmed
            )
            updateMuteState(conversationId, muted: confirmed)
            muteActionError = nil
        } catch is CancellationError {
            updateMuteState(conversationId, muted: previous)
        } catch {
            updateMuteState(conversationId, muted: previous)
            muteActionError = L10n.Messages.muteActionFailed
            logger.error("toggle IM mute failed id=\(conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    func dismissMuteActionError() {
        muteActionError = nil
    }

    /// 当前会话是否正在写入置顶偏好；列表据此避免重复触发 toggle 接口。
    func isTogglingPin(conversationId: String) -> Bool {
        pinMutationInFlight.contains(conversationId)
    }

    /// 乐观切换会话置顶；写 Django 显式 bool，失败则恢复点击前状态并反馈给用户。
    func togglePin(conversationId: String) async {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }),
              !pinMutationInFlight.contains(conversationId) else { return }

        let previous = conversations[index].pinned
        let confirmed = !previous
        pinMutationInFlight.insert(conversationId)
        setPinned(conversationId: conversationId, pinned: confirmed)
        defer { pinMutationInFlight.remove(conversationId) }

        do {
            try await dataPlane.pinConversation(conversationId: conversationId, pinned: confirmed)
            setPinned(conversationId: conversationId, pinned: confirmed)
            pinActionError = nil
        } catch is CancellationError {
            setPinned(conversationId: conversationId, pinned: previous)
        } catch {
            setPinned(conversationId: conversationId, pinned: previous)
            pinActionError = "置顶状态未能保存，请稍后重试。"
            logger.error("toggle IM pin failed id=\(conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    func dismissPinActionError() {
        pinActionError = nil
    }

    private func setPinned(conversationId: String, pinned: Bool) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        guard conversations[index].pinned != pinned else { return }
        var updated = conversations[index]
        updated.pinned = pinned
        conversations[index] = updated
    }

    func setLabels(_ labels: [IMConversationLabel], conversationId: String) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        conversations[index].labels = labels
    }

    func replaceLabelMetadata(_ updatedLabel: IMConversationLabel) {
        for index in conversations.indices {
            conversations[index].labels = conversations[index].labels.map { label in
                label.id == updatedLabel.id ? updatedLabel : label
            }
        }
    }

    func removeLabel(_ labelId: String) {
        for index in conversations.indices {
            conversations[index].labels.removeAll { $0.id == labelId }
        }
    }

    /// 消费 personal 频道 publication：同步未读、新会话、标签与 Agent 个人提示。
    func applyPersonalRealtime(_ data: Data) {
        guard let event = IMEventDecoder.decode(data) else { return }
        dispatchPersonalEvent(event)
    }

    private func dispatchPersonalEvent(_ event: IMRealtimeEvent) {
        switch event {
        case let .unreadUpdate(update):
            applyUnreadUpdate(update)
        case let .conversationNew(conversation):
            applyConversationNew(conversation)
        case let .conversationPreviewUpdated(update):
            let directoryOrganizationId = update.directoryScopeId ?? update.organizationId
            guard isEventForCurrentOrganization(directoryOrganizationId) else { return }
            applyLatestPreviewUpdate(
                conversationId: update.conversationId,
                messageSeq: update.messageSeq,
                preview: update.preview,
                lastMessageAt: update.lastMessageAt
            )
        case let .conversationLabelsUpdated(conversationId, labels):
            setLabels(labels, conversationId: conversationId)
        case let .userProfileUpdated(profile):
            applyUserProfileUpdated(profile)
        case let .aiError(agentName, reason):
            personalNotice = IMPersonalNotice(
                kind: .aiError,
                agentName: agentName.trimmingCharacters(in: .whitespacesAndNewlines),
                reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
                conversationId: nil,
                messageId: nil
            )
        case let .aiSuggestTask(conversationId, messageId, agentName):
            personalNotice = IMPersonalNotice(
                kind: .aiSuggestTask,
                agentName: agentName.trimmingCharacters(in: .whitespacesAndNewlines),
                reason: "",
                conversationId: conversationId,
                messageId: messageId
            )
        default:
            break
        }
    }

    private func applyUserProfileUpdated(_ profile: IMUserProfileUpdated) {
        guard !profile.userId.isEmpty else { return }
        for index in conversations.indices where
            conversations[index].conversationType == .dm &&
            conversations[index].dmPeerUserId == profile.userId
        {
            if !profile.displayName.isEmpty {
                conversations[index].name = profile.displayName
            }
            conversations[index].avatarUrl = profile.avatar
        }
        profileRevision &+= 1
    }

    func dismissPersonalNotice() {
        personalNotice = nil
    }

    /// 加载在途时登记一条窗口内新消息的 seq + 预览，供结果落地按水位算净增量 / 取最高 seq 预览。
    private func noteWindowDelta(
        _ conversationId: String,
        seq: Int,
        preview: String,
        lastMessageAt: String?,
        mention: Bool
    ) {
        guard loadWindow != nil else { return }
        var acc = loadWindow?[conversationId] ?? WindowUnreadAccum()
        acc.seqs.insert(seq)
        if mention { acc.mentionSeqs.insert(seq) }
        if seq > acc.previewSeq, !preview.isEmpty {
            acc.previewSeq = seq
            acc.preview = preview
            acc.lastMessageAt = lastMessageAt
        }
        loadWindow?[conversationId] = acc
    }

    /// 加载在途时登记一条新插入的会话，供结果落地在快照未含时保留。
    private func noteWindowInserted(_ conversationId: String) {
        guard loadWindow != nil else { return }
        loadWindowInserted.insert(conversationId)
    }

    /// 加载在途时清掉某会话已积累的窗口增量（该会话被读 / 前台消费，窗口净增量应归零）。
    private func clearWindowDelta(_ conversationId: String) {
        guard loadWindow != nil else { return }
        loadWindow?[conversationId] = WindowUnreadAccum()
    }

    /// 全局有界去重：首次见到该 `message_id` 返回 true 并登记；重投（重连/重发）返回 false。
    /// `message_id <= 0`（理论上不应出现）不参与去重，直接放行避免误合并。
    private func markMessageAppliedIfNew(_ messageId: Int) -> Bool {
        guard messageId > 0 else { return true }
        guard !recentAppliedMessageIds.contains(messageId) else { return false }
        recentAppliedMessageIds.insert(messageId)
        recentAppliedOrder.append(messageId)
        if recentAppliedOrder.count > Self.maxRecentAppliedMessageIds {
            let evicted = recentAppliedOrder.removeFirst()
            recentAppliedMessageIds.remove(evicted)
        }
        return true
    }

    /// 新会话（如对端新建 DM）：不在列表则插到最前，令列表与「消息」聚合角标即时出现，
    /// 无需等手动刷新。已存在则忽略（幂等；完整字段由下次 reload 校正）。
    func applyConversationNew(_ conversation: IMConversation) {
        guard !conversation.id.isEmpty else { return }
        // 跨组织隔离：personal:{user} 频道跨组织共用，非当前组织的新会话不得插入当前列表。
        guard isEventForCurrentOrganization(conversation.directoryOrganizationId) else { return }
        guard !conversations.contains(where: { $0.id == conversation.id }) else { return }
        var inserted = conversation
        // 回放先于本会话到达、被缓存的未读增量：im.unread.update 与 im.conversation.new 是
        // 两条独立 outbox 记录，投递顺序不保证；未读先到会被缓存，此处补齐缓存条数，
        // 避免新 DM 首条消息漏角标。新建 DM 摘要 unread 为 0，直接累加缓存条数。
        if let buffered = bufferedUnread.removeValue(forKey: conversation.id) {
            let addCount = buffered.count
            if addCount > 0 {
                inserted.unreadCount = inserted.unreadCount > Int.max - addCount
                    ? Int.max : inserted.unreadCount + addCount
            }
            if !buffered.preview.isEmpty { inserted.lastMessagePreview = buffered.preview }
            if let lastMessageAt = buffered.lastMessageAt, !lastMessageAt.isEmpty {
                inserted.lastMessageAt = lastMessageAt
            }
            // 随缓存预览一并推进水位：否则插入后到达的更旧 seq 消息会因 >= 0 覆盖回旧预览。
            inserted.lastMessageSeq = max(inserted.lastMessageSeq, buffered.previewSeq)
            if buffered.hasMention {
                inserted.labels = [IMConversationLabel.systemMention]
                    + inserted.labels.filter { $0.id != IMConversationLabel.systemMention.id }
            }
        }
        conversations.insert(inserted, at: 0)
        noteWindowInserted(conversation.id)
    }

    /// 本端刚从幂等 DM 接口拿到会话 ID 时，先写一条最小目录快照。
    /// personal realtime / 下次 reload 会补齐权威字段；在此之前再次点击同一人也能本地命中。
    func rememberDirectMessage(
        conversationId: String,
        organizationId: String,
        otherUserId: String,
        displayName: String
    ) {
        guard !conversationId.isEmpty, !organizationId.isEmpty, !otherUserId.isEmpty else { return }
        applyConversationNew(IMConversation(
            id: conversationId,
            organizationId: organizationId,
            spaceId: nil,
            spaceName: "",
            isTeamSpaceChannel: false,
            isExternal: false,
            type: IMConversationType.dm.rawValue,
            name: displayName,
            avatarUrl: "",
            memberCount: 2,
            isArchived: false,
            lastMessageAt: nil,
            lastMessagePreview: "",
            unreadCount: 0,
            lastMessageSeq: 0,
            createdAt: "",
            dmPeerUserId: otherUserId,
            pinned: false,
            isMuted: false
        ))
    }

    /// 外部联系人私信的本地最小目录快照；目录刷新后由服务端补齐其余字段。
    func rememberExternalDirectMessage(
        conversationId: String,
        organizationId: String,
        peerUserId: String,
        displayName: String
    ) {
        guard !conversationId.isEmpty, !organizationId.isEmpty, !peerUserId.isEmpty else { return }
        applyConversationNew(IMConversation(
            id: conversationId,
            organizationId: organizationId,
            spaceId: nil,
            spaceName: "",
            isTeamSpaceChannel: false,
            isExternal: true,
            type: IMConversationType.dm.rawValue,
            name: displayName,
            avatarUrl: "",
            memberCount: 2,
            isArchived: false,
            lastMessageAt: nil,
            lastMessagePreview: "",
            unreadCount: 0,
            lastMessageSeq: 0,
            createdAt: "",
            dmPeerUserId: peerUserId,
            pinned: false,
            isMuted: false
        ))
    }

    /// personal 频道跨组织共用：事件带 `organization_id` 时，仅当前组织的事件才参与本地状态。
    /// 组织未知（尚未加载）或事件未带组织（如 marked_read 已读回写）时放行，避免误伤既有链路。
    private func isEventForCurrentOrganization(_ eventOrganizationId: String) -> Bool {
        guard let current = organizationId else { return true }
        if eventOrganizationId.isEmpty { return true }
        return eventOrganizationId == current
    }

    /// 缓存未知会话的一条新消息未读增量（累加计数、保留最新预览），待 `applyConversationNew` 回放。
    /// 入口已做全局 message_id 去重，这里直接累加。
    private func bufferUnknownUnread(_ update: IMUnreadUpdate) {
        var entry = bufferedUnread[update.conversationId] ?? BufferedUnread()
        entry.count += 1
        entry.hasMention = entry.hasMention || update.mention
        // 预览随最高 seq 保存：乱序缓冲（先 seq=10 后 seq=9）时不把摘要退回旧消息。
        if update.messageSeq > entry.previewSeq, !update.preview.isEmpty {
            entry.previewSeq = update.messageSeq
            entry.preview = update.preview
            entry.lastMessageAt = update.lastMessageAt
        }
        bufferedUnread[update.conversationId] = entry
    }

    /// 应用一条未读更新：已读回写 → 清零；新消息 → 非活动会话递增并刷新预览。
    ///
    /// - 未读计数只做「已读回写清零」与「新消息 +1」两种确定增量，不按标量 seq 水位去重
    ///   （标量水位无法与不透明 `unread_count` 对齐，也会丢乱序补发，详见 ）。
    /// - 新消息 +1 前经全局有界 `message_id` 去重：Centrifugo 重连/重投同一消息不重复计数。
    func applyUnreadUpdate(_ update: IMUnreadUpdate) {
        guard !update.conversationId.isEmpty else { return }
        if let override = latestPreviewOverrides[update.conversationId],
           update.messageSeq > override.messageSeq {
            latestPreviewOverrides.removeValue(forKey: update.conversationId)
        }
        if update.isMarkedReadEvent {
            // 已读回写：清列表角标，并清掉该会话尚未插入时缓冲的未读——否则延迟到达的
            // im.conversation.new 会把已读消息回放成未读。窗口内已积累的净增量也清掉。
            bufferedUnread.removeValue(forKey: update.conversationId)
            clearWindowDelta(update.conversationId)
            clearUnread(conversationId: update.conversationId)
            return
        }
        // 正在看这个会话：详情页会 mark-read，列表角标保持 0。
        if update.conversationId == activeConversationId {
            // 前台已消费这条消息：登记 message_id，防离开/切后台后 Centrifugo 重投同一条时冒出伪未读。
            _ = markMessageAppliedIfNew(update.messageId)
            // 正在看详情只代表不增加未读，不能丢掉目录摘要。否则用户返回消息列表时，
            // subtitle 仍停在进入会话前的旧消息。
            applyLatestPreviewUpdate(
                conversationId: update.conversationId,
                messageSeq: update.messageSeq,
                preview: update.preview,
                lastMessageAt: update.lastMessageAt
            )
            clearWindowDelta(update.conversationId)
            clearUnread(conversationId: update.conversationId)
            return
        }
        // 跨组织隔离：非当前组织的新消息未读不得计入当前列表 / 聚合角标。
        let directoryOrganizationId = conversations
            .first(where: { $0.id == update.conversationId })?
            .directoryOrganizationId
            ?? update.directoryScopeId
            ?? update.organizationId
        guard isEventForCurrentOrganization(directoryOrganizationId) else { return }
        // 全局去重：同一 message_id 的重复投递（重连/重发）不重复 +1。
        guard markMessageAppliedIfNew(update.messageId) else { return }
        // 已读水位以内的迟到 publication 已被用户消费；即使是本进程首次看到，也不得复活角标。
        guard update.messageSeq <= 0
                || update.messageSeq > (confirmedReadWaterlines[update.conversationId] ?? 0) else { return }
        // 加载在途：登记窗口增量 seq + 预览，结果落地按水位判定净增量并取最高 seq 预览。
        noteWindowDelta(
            update.conversationId,
            seq: update.messageSeq,
            preview: update.preview,
            lastMessageAt: update.lastMessageAt,
            mention: update.mention
        )
        guard let index = conversations.firstIndex(where: { $0.id == update.conversationId }) else {
            // 会话尚未在列表：im.conversation.new 可能晚于 im.unread.update 到达（两者是独立
            // outbox 记录、投递顺序不保证）。缓存这条未读，待会话插入时回放，避免首条消息漏角标。
            bufferUnknownUnread(update)
            return
        }
        var updated = conversations[index]
        if updated.unreadCount < Int.max {
            updated.unreadCount += 1
        }
        // 预览只在不更旧的 seq 时覆盖：realtime 可乱序到达（先 seq=10 后 seq=9），摘要必须停在
        // 最高 seq 的消息，不被迟到的旧消息退回。seq 每条唯一，相等只可能是同一条（已按 message_id
        // 去重），故用 >= 兼容缺省 seq(0) 且不放过真正更旧的消息。同步推进本地水位。
        if update.messageSeq >= updated.lastMessageSeq, !update.preview.isEmpty {
            updated.lastMessagePreview = update.preview
            if let lastMessageAt = update.lastMessageAt, !lastMessageAt.isEmpty {
                updated.lastMessageAt = lastMessageAt
            }
        }
        updated.lastMessageSeq = max(updated.lastMessageSeq, update.messageSeq)
        if update.mention {
            updated.labels = [IMConversationLabel.systemMention]
                + updated.labels.filter { $0.id != IMConversationLabel.systemMention.id }
        }
        conversations[index] = updated
        // 有新未读的会话沉到列表靠前：按 lastMessageAt 本就由服务端排序，本地只改计数即可；
        // 完整重排留给下一次 reload，避免错序。
    }

    /// 落地一次列表加载结果，按 baseline/delta 合并（权威快照 + 仅窗口净增量）：
    /// - 快照会话：`unread = 快照 unread + 加载窗口内 seq > 快照水位 的新消息数`。
    ///   只取「快照未含」的窗口消息，既不被陈旧本地绝对值覆盖（修非零陈旧基线），也不与快照
    ///   已含的消息重复计数（修 snapshot-includes-publication）。用同一致快照下发的 `lastMessageSeq`
    ///   作水位，可证明合并。
    /// - 未被触碰的会话：直接用权威快照值。
    /// - 加载期间新插入、快照尚未包含的会话：整条保留，避免刚建的 DM 被覆盖丢失。
    private func commitMerged(_ result: [IMConversation], window: [String: WindowUnreadAccum], inserted: Set<String>) {
        var snapshotIds = Set<String>()
        var merged: [IMConversation] = []
        for var conversation in result {
            snapshotIds.insert(conversation.id)
            let readWaterline = confirmedReadWaterlines[conversation.id] ?? 0
            if readWaterline > 0, conversation.lastMessageSeq <= readWaterline {
                conversation.unreadCount = 0
                conversation.labels.removeAll { $0.id == IMConversationLabel.systemMention.id }
            }
            if let acc = window[conversation.id], !acc.seqs.isEmpty {
                let waterline = conversation.lastMessageSeq
                let unreadWaterline = max(waterline, readWaterline)
                let newCount = acc.seqs.filter { $0 > unreadWaterline }.count
                if newCount > 0, conversation.unreadCount < Int.max {
                    conversation.unreadCount = conversation.unreadCount > Int.max - newCount
                        ? Int.max : conversation.unreadCount + newCount
                }
                // 预览只在窗口内更高 seq（快照未含）时覆盖：既不被乱序旧消息退回，
                // 也不用快照已含 seq 的窗口预览去覆盖同样权威的快照预览。
                if acc.previewSeq > waterline, !acc.preview.isEmpty {
                    conversation.lastMessagePreview = acc.preview
                    if let lastMessageAt = acc.lastMessageAt, !lastMessageAt.isEmpty {
                        conversation.lastMessageAt = lastMessageAt
                    }
                }
                conversation.lastMessageSeq = max(waterline, acc.seqs.max() ?? waterline)
                if acc.mentionSeqs.contains(where: { $0 > unreadWaterline }) {
                    conversation.labels = [IMConversationLabel.systemMention]
                        + conversation.labels.filter { $0.id != IMConversationLabel.systemMention.id }
                }
            }
            conversation = applyLatestPreviewOverride(conversation)
            merged.append(conversation)
        }
        // 加载期间新插入、快照尚未包含的会话：保留在最前，避免刚建的 DM 被覆盖丢失。
        for local in conversations.reversed()
        where inserted.contains(local.id) && !snapshotIds.contains(local.id) {
            merged.insert(local, at: 0)
        }
        conversations = merged
        // 活动会话若在列表里仍带着未读（reload 竞态），保持清零语义。
        if let active = activeConversationId {
            clearUnread(conversationId: active)
        }
        // 已在权威列表中的会话不应再留缓冲（否则后续 conversation.new 不会来、缓冲永不消费）。
        for id in bufferedUnread.keys where snapshotIds.contains(id) {
            bufferedUnread.removeValue(forKey: id)
        }
    }

    @discardableResult
    private func startLoad(organizationId: String) -> Task<Void, Never> {
        loadTask?.cancel()
        loadGeneration += 1
        let generation = loadGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performLoad(organizationId: organizationId, generation: generation)
        }
        loadTask = task
        return task
    }

    private func performLoad(organizationId: String, generation: Int) async {
        isLoading = true
        loadError = nil
        // 开始收集本次请求窗口内到达的 realtime 未读增量 / 新会话，供结果落地做 baseline/delta 合并。
        loadWindow = [:]
        loadWindowInserted = []
        defer {
            if generation == loadGeneration {
                isLoading = false
                loadWindow = nil
                loadWindowInserted = []
            }
        }
        do {
            let result = try await dataPlane.listConversations(organizationId: organizationId)
            guard generation == loadGeneration, self.organizationId == organizationId else { return }
            let window = loadWindow ?? [:]
            let inserted = loadWindowInserted
            loadWindow = nil
            loadWindowInserted = []
            commitMerged(result, window: window, inserted: inserted)
            logger.info("loaded \(result.count) IM conversations")
        } catch is CancellationError {
            return
        } catch {
            guard generation == loadGeneration else { return }
            loadError = L10n.Messages.networkError
            logger.error("load IM conversations failed org=\(organizationId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    /// 会话变更后重拉权威目录快照。保留旧方法名仅避免扰动现有测试辅助入口。
    private func startListeningPersonalIfNeeded() {
        dataPlane.setConversationChangedListener { [weak self] in
            guard let self, let organizationId = self.organizationId else { return }
            self.startLoad(organizationId: organizationId)
        }
        guard !isListeningPersonal else { return }
        personalRealtimeSource.setPersonalPublicationListener { [weak self] data in
            self?.applyPersonalRealtime(data)
        }
        personalRealtimeSource.setConnectionAvailableListener { [weak self] in
            guard let self, let organizationId = self.organizationId else { return }
            self.startLoad(organizationId: organizationId)
        }
        isListeningPersonal = true
    }

    /// 登出 / 切组织时清空并使在途加载失效；同时拆掉 personal 监听，供重登后重建。
    func clear() {
        loadTask?.cancel()
        loadGeneration += 1
        searchGeneration += 1
        organizationId = nil
        conversations = []
        loadError = nil
        pinActionError = nil
        muteActionError = nil
        searchResults = []
        searchError = nil
        personalNotice = nil
        isSearching = false
        isLoading = false
        activeConversationId = nil
        pinMutationInFlight.removeAll()
        muteMutationInFlight.removeAll()
        bufferedUnread.removeAll()
        latestPreviewOverrides.removeAll()
        loadWindow = nil
        loadWindowInserted = []
        recentAppliedMessageIds.removeAll()
        recentAppliedOrder.removeAll()
        confirmedReadWaterlines.removeAll()
        organizationGeneration += 1
        stopListeningPersonal()
        dataPlane.clearSession()
    }

    /// 切组织时先同步清空旧列表，防止新请求返回前仍显示上一组织角标。
    private func prepareOrganization(_ nextOrganizationId: String) {
        let normalized = nextOrganizationId.isEmpty ? nil : nextOrganizationId
        guard organizationId != normalized else { return }
        if organizationId != nil {
            dataPlane.clearSession()
        }
        loadTask?.cancel()
        loadGeneration += 1
        searchGeneration += 1
        organizationId = normalized
        conversations = []
        loadError = nil
        pinActionError = nil
        muteActionError = nil
        searchResults = []
        searchError = nil
        personalNotice = nil
        isSearching = false
        isLoading = false
        activeConversationId = nil
        pinMutationInFlight.removeAll()
        muteMutationInFlight.removeAll()
        bufferedUnread.removeAll()
        latestPreviewOverrides.removeAll()
        loadWindow = nil
        loadWindowInserted = []
        recentAppliedMessageIds.removeAll()
        recentAppliedOrder.removeAll()
        confirmedReadWaterlines.removeAll()
        organizationGeneration += 1
    }

    /// 复位会话监听态并拆掉 callback。
    private func stopListeningPersonal() {
        isListeningPersonal = false
        personalRealtimeSource.setPersonalPublicationListener(nil)
        personalRealtimeSource.setConnectionAvailableListener(nil)
        dataPlane.setConversationChangedListener(nil)
    }

    /// 单测注入会话列表（不打网络）。
    func replaceConversationsForTesting(_ items: [IMConversation]) {
        conversations = items
    }

    /// 单测：当前是否已标记为正在听 personal（门禁 connect 的 flag）。
    var isListeningPersonalForTesting: Bool { isListeningPersonal }

    /// 单测：直接走 personal 监听启动路径（等同 `loadConversations` 里那一步）。
    func startListeningPersonalForTesting() {
        startListeningPersonalIfNeeded()
    }

    /// 单测：模拟 Organization 上下文切换，不触发真网络。
    func prepareOrganizationForTesting(_ organizationId: String) {
        prepareOrganization(organizationId)
    }

    /// 单测：开始一次「加载在途」窗口（等同 `performLoad` 请求发出、结果未回时开始收集窗口增量）。
    func beginLoadWindowForTesting() {
        loadWindow = [:]
        loadWindowInserted = []
    }

    /// 单测：落地一次加载结果，走与 `performLoad` 相同的 baseline/delta 合并提交路径。
    func commitLoadForTesting(_ result: [IMConversation]) {
        let window = loadWindow ?? [:]
        let inserted = loadWindowInserted
        loadWindow = nil
        loadWindowInserted = []
        commitMerged(result, window: window, inserted: inserted)
    }
}
