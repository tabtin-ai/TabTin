import Foundation

/// 把一轮 `StreamUpdate` 序列投射成 `[ChatMessage]` 的纯投射器（§4.3 第三刀的确定性核心）。
///
/// 与 `StreamSession`（流事件 → StreamUpdate）解耦：reducer 管「单轮事件折叠」，projector 管
/// 「更新落到哪条消息、delta 怎么合并、流式态怎么收尾」。值类型 + `mutating`，无 async / 无
/// transport，便于单测（喂 WireDecoder→StreamSession 产出的 StreamUpdate，断言消息列表）。
///
/// **多气泡模型**：一轮 agentic 对话可能有多个 `message_start`，每个对应一条独立 assistant 气泡
/// （对齐 Electron / 旧 iOS）。发送时建的乐观占位气泡由首个 `message_start` 认领，后续 `message_start`
/// 各自新建气泡；block 更新按 `messageId` 路由到对应气泡。HITL / systemNotice 仅落最小痕迹
/// （system 气泡 / notice 文案），不丢事件但不展开。
struct ConversationProjector {
    private(set) var messages: [ChatMessage] = []
    private(set) var phase: String?
    /// 最近一条系统提示（seq-gap / 连接中断等），UI 可做顶部 banner。
    private(set) var systemNotice: String?

    /// server messageId → 本地气泡 id（一条 message_start 一条气泡）。
    private var bubbleForMessage: [String: String] = [:]
    /// 最近活动助手气泡：messageId 为空的更新 / message_start 之前的事件兜底落它。
    private var activeAssistantId: String?
    /// 发送时建的乐观占位气泡，等首个 message_start 认领；nil 表示已认领或无占位。
    private var pendingOptimisticId: String?

    init() {}

    var isStreamingActive: Bool { messages.contains { $0.isStreaming } }

    /// 是否还有未被 message_start 认领的乐观 assistant 占位（发送看门狗用：真没动静即标失败）。
    var hasPendingOptimistic: Bool { pendingOptimisticId != nil }

    /// 把未认领的乐观占位标记为失败（发送超时 / nak）：停转 + 挂错误文案。
    mutating func failPendingOptimistic(_ message: String) {
        guard let opt = pendingOptimisticId,
              let idx = messages.firstIndex(where: { $0.id == opt }) else { return }
        messages[idx].errorMessage = message
        messages[idx].isStreaming = false
        // 这不是一条独立的 AI 回答，而是紧随本轮 user 的投递/执行状态。历史或缓存
        // 对账可能按服务端时间戳重排消息，必须在这里明确恢复它的轮次位置。
        messages = Self.orderedTimeline(messages)
        pendingOptimisticId = nil
        if activeAssistantId == opt { activeAssistantId = nil }
    }

    /// 服务端已确认会持久化错误气泡时，移除本地空占位，避免历史对账后出现双错误气泡。
    mutating func removePendingOptimisticAssistant() {
        guard let opt = pendingOptimisticId else { return }
        messages.removeAll { $0.id == opt }
        pendingOptimisticId = nil
        if activeAssistantId == opt { activeAssistantId = nil }
    }

    /// Composer Stop 的「撤回未答轮次」判定：thinking 只是内部准备，不算已经开始回复；
    /// 一旦出现正文、工具或可见富内容，就只停止而不撤回用户消息。
    func hasSubstantiveAssistantOutput(afterUserMessageId userMessageId: String) -> Bool {
        guard let userIndex = messages.lastIndex(where: {
            $0.role == .user && ($0.id == userMessageId || $0.identityKeys.contains(userMessageId))
        }) else { return false }
        return messages.dropFirst(userIndex + 1).contains { message in
            guard message.role == .assistant else { return false }
            return message.blocks.contains { block in
                switch block {
                case let .text(text):
                    return !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                case .tool, .richContent, .attachment, .contextRef:
                    return true
                case .thinking:
                    return false
                }
            }
        }
    }

    /// 撤回本轮 user 及其后尚未形成实质回复的半截时间线，与 Electron 的
    /// `truncateFromMessage` 一致。调用方只会在上面的 substance 判定为 false 时进入。
    mutating func withdrawUnansweredTurn(userMessageId: String) {
        guard let userIndex = messages.lastIndex(where: {
            $0.role == .user && ($0.id == userMessageId || $0.identityKeys.contains(userMessageId))
        }) else {
            endStreaming()
            return
        }
        messages.removeSubrange(userIndex...)
        bubbleForMessage.removeAll()
        activeAssistantId = nil
        pendingOptimisticId = nil
        phase = nil
        systemNotice = nil
    }

    // MARK: - 历史回放

    /// 用历史消息播种列表（打开已存在会话时调用）。仅在当前为空且未在流式时生效，
    /// 避免覆盖已发出的乐观消息 / 进行中的流。
    mutating func seed(_ history: [ChatMessage]) {
        guard messages.isEmpty, !isStreamingActive else { return }
        messages = Self.orderedTimeline(Self.mainTimelineMessages(history))
    }

    /// 上拉加载更早历史用的游标：当前最旧一条**真实**消息（跳过本地 inline 提案卡）的服务端 id。
    var oldestServerId: String? {
        messages.first { $0.planProposal == nil && $0.modeSwitchProposal == nil }?.effectiveId
    }

    /// 历史对账：用服务端权威「最新页」校正消息列表（仅非流式时调用，本轮已收尾）。
    /// 返回是否真正改动了 `messages`——**内容全等时不动数组**，让上层跳过 publish，
    /// 缓存秒显后 HTTP 对账若一致即「零重渲染」，根治重复进会话的「刷一下」。
    ///
    /// 两条路径：
    /// - 常规（未上拉翻页，`真实消息数 <= 页大小`）→ **整体替换**：权威历史天然 dedup
    ///   乐观 user 气泡（id=client_event_id 与持久化 id 不一致，整体替换最简单且正确）。
    /// - 已上拉加载多页（真实消息数 > 本页）→ **按 effectiveId upsert 合并**：保住更早历史，
    ///   只把最新页覆盖进来（此时乐观气泡早已被前轮对账成持久化形态，无重复风险）。
    @discardableResult
    mutating func replaceWithHistory(_ history: [ChatMessage], allowWhileStreaming: Bool = false) -> Bool {
        guard allowWhileStreaming || !isStreamingActive else { return false }
        let mainHistory = Self.mainTimelineMessages(history)
        let localCards = messages.filter { $0.planProposal != nil || $0.modeSwitchProposal != nil }
        let realCount = messages.count - localCards.count

        let merged: [ChatMessage]
        if mainHistory.isEmpty {
            // 权威最新页为空：清掉陈旧缓存气泡，仅保留本地 proposal 卡。
            merged = localCards
        } else if realCount > mainHistory.count {
            merged = Self.upsertByIdentity(authoritative: mainHistory, into: messages)
        } else {
            var usedLocal = Set<Int>()
            var m = mainHistory.map { server -> ChatMessage in
                if let match = Self.findMatchingMessage(server: server, candidates: messages, used: usedLocal) {
                    usedLocal.insert(match.index)
                    // 与 mergeCommittedHistory 同口径：保住乐观 user 的更早 createdAt，
                    // 避免轮次收尾对账后 user 被甩到已上屏的 assistant 下面。
                    return Self.mergeServerMessageIntoLocal(
                        local: match.message,
                        server: server,
                        preserveOptimisticUserCreatedAt: true
                    )
                }
                return server
            }
            for card in localCards where !m.contains(where: { $0.sharesIdentity(with: card) || $0.id == card.id }) {
                m.append(card)
            }
            merged = Self.orderedTimeline(m)
        }

        guard merged != messages else { return false }
        messages = merged
        rebuildBubbleRoutingFromMessages()
        activeAssistantId = nil
        pendingOptimisticId = nil
        return true
    }

    /// 外部消息锚点跳转：用 around 返回的连续窗口替换当前可见历史，避免把相隔很远的
    /// 最新页与旧消息窗口拼成一条看似连续的时间线。
    @discardableResult
    mutating func replaceWithFocusedHistory(_ history: [ChatMessage]) -> Bool {
        guard !isStreamingActive else { return false }
        let focused = Self.orderedTimeline(Self.mainTimelineMessages(history))
        guard focused != messages else { return false }
        messages = focused
        rebuildBubbleRoutingFromMessages()
        activeAssistantId = nil
        pendingOptimisticId = nil
        return true
    }

    /// 历史增量对账：`updated_after` 返回的是一批变更消息，不代表完整最新页。
    /// 因此只能按 identity upsert 到当前列表，不能走整体替换分支。
    @discardableResult
    mutating func mergeHistoryDelta(_ delta: [ChatMessage], allowWhileStreaming: Bool = false) -> Bool {
        let mainDelta = Self.mainTimelineMessages(delta)
        guard !mainDelta.isEmpty else { return false }
        guard allowWhileStreaming || !isStreamingActive else { return false }
        let merged = Self.upsertByIdentity(authoritative: mainDelta, into: messages)
        guard merged != messages else { return false }
        messages = merged
        rebuildBubbleRoutingFromMessages()
        activeAssistantId = nil
        pendingOptimisticId = nil
        return true
    }

    /// message_committed 对账：后端已经确认某条 message 落库，允许在后续 message
    /// 仍流式时把历史事实按 identity 合并进当前列表。不同于 terminal reconcile，
    /// 这里不能整体替换，也不能整体重置 messageId → bubble 路由，否则会打断下一条
    /// 正在进行的 assistant message；只按 identity 修复被合并改写掉的那几条。
    @discardableResult
    mutating func mergeCommittedHistory(_ history: [ChatMessage]) -> Bool {
        let mainHistory = Self.mainTimelineMessages(history)
        // relay 的真实顺序允许 persist_message 先广播 message_committed，原始
        // message_start / content_block_delta 再在 ACK 后异步广播。此时把一个尚未
        // 被 live 认领的 assistant 历史行直接 append 到时间线，会先倾泻全文；随后
        // message_start 认领该行，delta 又在全文上 +=，直到终态对账才恢复。
        //
        // committed/ACK 对账在流进行中只允许更新**已经存在且身份闭合**的 assistant；
        // 未命中的 assistant 留给即将到达的 live 单写，若 live 永久缺失则由终态
        // replaceWithHistory 补齐。user 历史仍照常 upsert，用于确认乐观发送。
        let mergeableHistory = mainHistory.filter { server in
            guard server.isAssistant else { return true }
            return messages.contains { local in
                local.isAssistant && local.sharesIdentity(with: server)
            }
        }
        guard !mergeableHistory.isEmpty else { return false }
        let identitiesBeforeMerge = Self.identitySnapshot(messages)
        let merged = Self.upsertByIdentity(
            authoritative: mergeableHistory,
            into: messages,
            preserveOptimisticUserCreatedAt: true
        )
        guard merged != messages else { return false }
        messages = merged
        remapStaleBubbleRouting(identitiesBeforeMerge: identitiesBeforeMerge)
        return true
    }

    /// 上拉加载更早历史：把更早一页去重后**前插**，按时间线重排。返回新增条数（0=全是已有）。
    /// 仅追加更早消息，不触碰活跃气泡 / 路由状态（调用方保证非流式）。
    @discardableResult
    mutating func prependHistory(_ older: [ChatMessage]) -> Int {
        let mainOlder = Self.mainTimelineMessages(older)
        guard !mainOlder.isEmpty else { return 0 }
        let fresh = mainOlder.filter { old in !messages.contains(where: { $0.sharesIdentity(with: old) }) }
        guard !fresh.isEmpty else { return 0 }
        messages = Self.orderedTimeline((fresh + messages).sorted(by: Self.timelineOrder))
        return fresh.count
    }

    /// 按 effectiveId 把权威消息 upsert 进现有列表（权威覆盖同 id 行，保留现有未命中的更早消息），
    /// 结果按时间线升序。供 `replaceWithHistory` 的「已翻页」分支用。
    private struct IndexedMessage {
        let index: Int
        let message: ChatMessage
    }

    /// 时间线序：先 `createdAt`；相同时用户气泡排在助手前面，避免同秒入库把 user 甩到 assistant 后。
    private static func timelineOrder(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
        if a.isUser != b.isUser { return a.isUser && !b.isUser }
        return a.effectiveId < b.effectiveId
    }

    /// 保留调用方已有的时间线顺序，只让本地「消息已受理、暂未收到执行结果」卡遵守
    /// 更强的轮次语义：它必须紧随触发它的用户消息。这样既能抵抗服务端落库时间、
    /// 缓存读回顺序或时钟微小漂移，也不会改写 around 跳转等服务端给定窗口的顺序。
    private static func orderedTimeline(_ input: [ChatMessage]) -> [ChatMessage] {
        var timeline = input
        let errorCardIds = timeline.compactMap { message -> String? in
            localErrorSourceClientEventId(for: message) == nil ? nil : message.id
        }

        for errorCardId in errorCardIds {
            guard let errorIndex = timeline.firstIndex(where: { $0.id == errorCardId }),
                  let sourceClientEventId = localErrorSourceClientEventId(for: timeline[errorIndex]),
                  timeline.contains(where: {
                      $0.isUser && $0.identityKeys.contains(sourceClientEventId)
                  }) else {
                continue
            }

            let errorCard = timeline.remove(at: errorIndex)
            guard let refreshedUserIndex = timeline.firstIndex(where: {
                $0.isUser && $0.identityKeys.contains(sourceClientEventId)
            }) else {
                timeline.insert(errorCard, at: min(errorIndex, timeline.count))
                continue
            }

            // 同一轮若已有其他本地错误状态，保持它们原有先后关系；其它 assistant
            // 消息仍留在错误卡之后，避免把下一轮的消息夹进本轮 user/error 之间。
            var insertionIndex = refreshedUserIndex + 1
            while insertionIndex < timeline.count,
                  localErrorSourceClientEventId(for: timeline[insertionIndex]) == sourceClientEventId {
                insertionIndex += 1
            }
            timeline.insert(errorCard, at: insertionIndex)
        }
        return timeline
    }

    /// 新路径显式保存 `sourceClientEventId`；为已落盘的旧缓存兼容，仍可从稳定的
    /// `asst_pending_<client_event_id>` 本地 id 恢复关联。
    private static func localErrorSourceClientEventId(for message: ChatMessage) -> String? {
        guard message.isAssistant, message.errorMessage != nil else { return nil }
        if let source = message.sourceClientEventId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !source.isEmpty {
            return source
        }
        let prefix = "asst_pending_"
        guard message.id.hasPrefix(prefix) else { return nil }
        let source = String(message.id.dropFirst(prefix.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return source.isEmpty ? nil : source
    }

    private static func upsertByIdentity(
        authoritative: [ChatMessage],
        into current: [ChatMessage],
        preserveOptimisticUserCreatedAt: Bool = false
    ) -> [ChatMessage] {
        var merged = current
        var usedLocal = Set<Int>()
        for server in authoritative {
            if let match = findMatchingMessage(server: server, candidates: merged, used: usedLocal) {
                usedLocal.insert(match.index)
                merged[match.index] = mergeServerMessageIntoLocal(
                    local: match.message,
                    server: server,
                    preserveOptimisticUserCreatedAt: preserveOptimisticUserCreatedAt
                )
            } else {
                merged.append(server)
            }
        }
        return orderedTimeline(merged.sorted(by: timelineOrder))
    }

    private static func mainTimelineMessages(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter {
            !$0.isSubagentTranscript
                && !$0.isInternalContext
                && !$0.isRedundantAgentSwitchNotice
                && !$0.shouldHidePushNotification
                && !$0.isTimelineTransparent
        }
    }

    private static func findMatchingMessage(
        server: ChatMessage,
        candidates: [ChatMessage],
        used: Set<Int>
    ) -> IndexedMessage? {
        for (index, candidate) in candidates.enumerated()
            where !used.contains(index) && candidate.sharesIdentity(with: server) {
            return IndexedMessage(index: index, message: candidate)
        }
        for (index, candidate) in candidates.enumerated()
            where !used.contains(index) && candidate.isLegacyUserDuplicate(of: server) {
            return IndexedMessage(index: index, message: candidate)
        }
        return nil
    }

    private static func mergeServerMessageIntoLocal(
        local: ChatMessage,
        server: ChatMessage,
        preserveOptimisticUserCreatedAt: Bool = false
    ) -> ChatMessage {
        if local.isAssistant, server.isAssistant, local.isStreaming {
            return mergeSnapshotIntoStreamingAssistant(local: local, server: server)
        }
        guard local.isUser, server.isUser else { return server }
        // 乐观发出时刻通常早于服务端入库时刻；若收尾对账用后者覆盖，按 createdAt
        // 排序会把用户气泡甩到本轮已上屏的 assistant 后面（真机复现：user 在底、AI 在上）。
        let createdAt = preserveOptimisticUserCreatedAt
            ? min(local.createdAt, server.createdAt)
            : server.createdAt
        if local.id == server.id {
            let blocks = server.blocks.isEmpty && !local.blocks.isEmpty ? local.blocks : server.blocks
            return ChatMessage(
                id: server.id,
                serverId: server.serverId ?? local.serverId,
                persistedId: server.persistedId ?? local.persistedId,
                clientEventId: server.clientEventId ?? local.clientEventId,
                role: server.role,
                blocks: blocks,
                text: blocks.isEmpty ? (server.text.isEmpty ? local.text : server.text) : "",
                isStreaming: server.isStreaming,
                stopReason: server.stopReason,
                errorMessage: server.errorMessage,
                planProposal: server.planProposal,
                modeSwitchProposal: server.modeSwitchProposal,
                proposalResolved: server.proposalResolved,
                checkpointRecord: server.checkpointRecord,
                agentRunId: server.agentRunId,
                subagentRunId: server.subagentRunId,
                errorCategory: server.errorCategory,
                errorCode: server.errorCode,
                errorClass: server.errorClass,
                suggestedAction: server.suggestedAction,
                createdAt: createdAt
            )
        }
        let keepLocalBlocks = local.text.count > server.text.count && !local.blocks.isEmpty
        return ChatMessage(
            id: local.id,
            serverId: server.serverId ?? server.id,
            persistedId: server.persistedId ?? server.id,
            clientEventId: server.clientEventId ?? local.canonicalClientEventId,
            role: server.role,
            blocks: keepLocalBlocks ? local.blocks : server.blocks,
            text: keepLocalBlocks ? local.text : "",
            isStreaming: server.isStreaming,
            stopReason: server.stopReason,
            errorMessage: server.errorMessage,
            planProposal: server.planProposal,
            modeSwitchProposal: server.modeSwitchProposal,
            proposalResolved: server.proposalResolved,
            checkpointRecord: server.checkpointRecord,
            agentRunId: server.agentRunId,
            subagentRunId: server.subagentRunId,
            errorCategory: server.errorCategory,
            errorCode: server.errorCode,
            errorClass: server.errorClass,
            suggestedAction: server.suggestedAction,
            createdAt: createdAt
        )
    }

    /// 正在流式的 assistant 被 committed 历史命中时，服务端行只是**中途快照**。
    /// 整行替换会连本地气泡 id 一起换掉，`messageId → 气泡` 路由随即指向一条不存在的行，
    /// 后续 delta 被 `updateBubble` 静默丢弃，直到收尾对账才一次性灌入全文（ 倾泻根因）。
    /// 所以这里只回填服务端身份，气泡 id、流式态与内容都留在本地。
    ///
    /// 不能用「哪边文本更长」决定正文：可靠 message_committed / ACK 对账可能越过仍在
    /// WS 队列里的高频 delta。若先采用 HTTP 的较长快照，快照已包含的迟到 delta 随后
    /// 仍会 `+=`，形成瞬态重复；终态历史虽能校正，用户却会看到“先倾泻、再重放”。
    /// 流式期由 live 单写，真实 seq gap 统一在终态 `replaceWithHistory` 修复。
    private static func mergeSnapshotIntoStreamingAssistant(
        local: ChatMessage,
        server: ChatMessage
    ) -> ChatMessage {
        var merged = local
        merged.serverId = local.serverId ?? server.serverId ?? server.id
        merged.persistedId = server.persistedId ?? local.persistedId
        merged.clientEventId = local.clientEventId ?? server.clientEventId
        merged.agentId = local.agentId ?? server.agentId
        merged.agentRunId = local.agentRunId ?? server.agentRunId
        merged.checkpointRecord = local.checkpointRecord ?? server.checkpointRecord
        return merged
    }

    /// 合并前的「本地 id → identity」快照，用于合并后把被改写的路由找回来。
    private static func identitySnapshot(_ messages: [ChatMessage]) -> [String: Set<String>] {
        messages.reduce(into: [:]) { snapshot, message in
            snapshot[message.id] = message.identityKeys
        }
    }

    /// 历史合并可能把某条本地气泡整行换成服务端行（id 随之改变）。路由表里指向旧 id
    /// 的键会变成幽灵，后续 delta 全部落空。这里按合并前的 identity 找回新行并回填；
    /// 真的消失了就清掉该路由，让懒建路径重新认领，而不是留一条永远解析不到的映射。
    private mutating func remapStaleBubbleRouting(identitiesBeforeMerge: [String: Set<String>]) {
        let liveIds = Set(messages.map(\.id))
        func remapped(_ oldId: String) -> String? {
            if liveIds.contains(oldId) { return oldId }
            guard let identity = identitiesBeforeMerge[oldId] else { return nil }
            return messages.first { !$0.identityKeys.isDisjoint(with: identity) }?.id
        }

        for (messageId, bubbleId) in bubbleForMessage {
            guard let resolved = remapped(bubbleId) else {
                bubbleForMessage.removeValue(forKey: messageId)
                continue
            }
            if resolved != bubbleId { bubbleForMessage[messageId] = resolved }
        }
        activeAssistantId = activeAssistantId.flatMap(remapped)
        pendingOptimisticId = pendingOptimisticId.flatMap(remapped)
    }

    // MARK: - 轮次起手

    /// 追加用户消息（占位气泡），id 用 client_event_id 便于与 agent.stream.user 镜像对齐。
    mutating func appendUserMessage(
        id: String,
        text: String,
        attachments: [AttachmentBlock] = [],
        contextRefs: [ContextRefBlock] = [],
        createdAt: Date = .now
    ) {
        let identityProbe = ChatMessage(id: id, clientEventId: id, role: .user, createdAt: createdAt)
        guard !messages.contains(where: { $0.sharesIdentity(with: identityProbe) }) else { return }
        var blocks: [MessageBlock] = []
        if !text.isEmpty {
            blocks.append(.text(TextBlock(messageId: id, index: 0, text: text)))
        }
        blocks.append(contentsOf: attachments.enumerated().map { offset, attachment in
            .attachment(AttachmentBlock(
                messageId: id,
                index: blocks.count + offset,
                kind: attachment.kind,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                url: attachment.url,
                fileId: attachment.fileId
            ))
        })
        blocks.append(contentsOf: contextRefs.enumerated().map { offset, ref in
            .contextRef(ContextRefBlock(
                messageId: id,
                index: blocks.count + offset,
                type: ref.type,
                resourceId: ref.resourceId,
                url: ref.url,
                tableId: ref.tableId,
                docId: ref.docId,
                rowIds: ref.rowIds,
                fieldIds: ref.fieldIds,
                label: ref.label,
                preview: ref.preview,
                spaceId: ref.spaceId,
                spaceName: ref.spaceName,
                locationHint: ref.locationHint
            ))
        })
        messages.append(ChatMessage(id: id, clientEventId: id, role: .user, blocks: blocks, createdAt: createdAt))
    }

    /// `chat.send_message.ok/nak(delivery=persisted)` 回填：把本地 client id 与服务端 id 闭合。
    mutating func confirmUserMessage(
        clientEventId: String,
        serverMessageId: String?
    ) {
        guard let idx = messages.firstIndex(where: {
            $0.role == .user && ($0.identityKeys.contains(clientEventId) || $0.id == clientEventId)
        }) else { return }
        messages[idx].clientEventId = clientEventId
        if let serverMessageId, !serverMessageId.isEmpty {
            messages[idx].serverId = serverMessageId
            messages[idx].persistedId = serverMessageId
        }
    }

    /// 观察者镜像：追加别端发来的用户气泡。按 client_event_id 去重——本端自发的 user 气泡
    /// id 即 client_event_id，命中则跳过（避免自发消息被旁观通道重复渲染）。
    mutating func appendObservedUserMessage(
        id: String,
        text: String,
        senderUserId: String? = nil,
        senderDisplayName: String? = nil,
        triggeredBy: String? = nil,
        createdAt: Date = .now
    ) {
        if PushNotificationVisibility.shouldHideFromTimeline(triggeredBy: triggeredBy, text: text) {
            return
        }
        let observed = ChatMessage(
            id: id,
            clientEventId: id,
            role: .user,
            senderUserId: senderUserId,
            senderDisplayName: senderDisplayName,
            text: text,
            triggeredBy: triggeredBy,
            createdAt: createdAt
        )
        guard !messages.contains(where: { $0.sharesIdentity(with: observed) }) else { return }
        messages.append(observed)
        messages = Self.orderedTimeline(messages.sorted(by: Self.timelineOrder))
    }

    /// 起一条流式 assistant 乐观占位气泡，给即时 typing 反馈；首个 message_start 到达时认领它。
    /// `agentId` 写入当前会话执行身份，让头像/身份行在 message_start 前即可渲染。
    @discardableResult
    mutating func beginAssistant(
        id: String,
        sourceClientEventId: String? = nil,
        agentId: String? = nil,
        createdAt: Date = .now
    ) -> String {
        pendingOptimisticId = id
        activeAssistantId = id
        phase = nil
        if let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].isStreaming = true
            if let sourceClientEventId, !sourceClientEventId.isEmpty {
                messages[idx].sourceClientEventId = sourceClientEventId
            }
            if let agentId, !agentId.isEmpty {
                messages[idx].agentId = agentId
            }
            messages[idx].errorMessage = nil
            messages[idx].errorCategory = nil
            messages[idx].errorCode = nil
            messages[idx].errorClass = nil
            messages[idx].suggestedAction = nil
            return id
        }
        messages.append(ChatMessage(
            id: id,
            sourceClientEventId: sourceClientEventId,
            role: .assistant,
            agentId: agentId,
            isStreaming: true,
            createdAt: createdAt
        ))
        return id
    }

    // MARK: - 应用更新

    mutating func apply(_ update: StreamUpdate) {
        switch update {
        case let .accepted(serverMessageId):
            updateBubble(nil) { if let serverMessageId { $0.serverId = serverMessageId } }

        case let .lifecycle(phase):
            self.phase = phase

        case let .messageStarted(messageId, agentId, role):
            // 合成 mini-message（role="user" kind="llm"，如后台命令终结时 relay 的
            // tool_result 信封）不建气泡——它永远不会有 text 块，建了只会留下空的
            // 幽灵气泡；终态由 toolResult 按 toolUseId 跨气泡回填。对齐 Electron
            // contentBlockHandler 只对 role=='assistant' 建气泡的口径。role 缺失时
            // 保持旧行为，兼容历史 relay。
            if let role, role != "assistant" { break }
            beginOrClaimBubble(messageId: messageId, agentId: agentId)

        case let .appendText(messageId, index, text):
            updateBubble(messageId, createIfMissing: true) { msg in
                // 只在「同为 text 且同 (messageId, index)」的块上累加；找不到才在时间轴末尾新建。
                // 不跨 kind 匹配 → 不会因 index 撞上 thinking/tool 块而反复新建（旧 bug 根因）。
                if let i = msg.blocks.firstIndex(where: { Self.isText($0, messageId, index) }),
                   case var .text(b) = msg.blocks[i] {
                    b.text += text
                    msg.blocks[i] = .text(b)
                } else {
                    msg.blocks.append(.text(TextBlock(messageId: messageId, index: index, text: text)))
                }
            }

        case let .citation(messageId, index, citation):
            updateBubble(messageId, createIfMissing: true) { msg in
                if let i = msg.blocks.firstIndex(where: { Self.isText($0, messageId, index) }),
                   case var .text(b) = msg.blocks[i] {
                    guard !b.citations.contains(citation) else { return }
                    b.citations.append(citation)
                    msg.blocks[i] = .text(b)
                } else {
                    msg.blocks.append(.text(TextBlock(
                        messageId: messageId,
                        index: index,
                        text: "",
                        citations: [citation]
                    )))
                }
            }

        case let .thinking(messageId, index, text, completed):
            let timestamp = Date()
            updateBubble(messageId, createIfMissing: true) { msg in
                if let i = msg.blocks.firstIndex(where: { Self.isThinking($0, messageId, index) }),
                   case var .thinking(seg) = msg.blocks[i] {
                    seg.text = text
                    seg.completed = completed
                    if seg.startedAt == nil { seg.startedAt = timestamp }
                    if completed, seg.stoppedAt == nil { seg.stoppedAt = timestamp }
                    msg.blocks[i] = .thinking(seg)
                } else {
                    msg.blocks.append(.thinking(
                        ThinkingSegment(
                            messageId: messageId,
                            index: index,
                            text: text,
                            completed: completed,
                            startedAt: timestamp,
                            stoppedAt: completed ? timestamp : nil
                        )
                    ))
                }
            }

        case let .toolUseStarted(messageId, toolCallId, name, index):
            updateBubble(messageId, createIfMissing: true) { msg in
                if let i = msg.blocks.firstIndex(where: { Self.isTool($0, toolCallId) }),
                   case var .tool(existing) = msg.blocks[i] {
                    existing.name = name
                    msg.blocks[i] = .tool(existing)
                    return
                }
                msg.blocks.append(.tool(ToolCall(
                    toolCallId: toolCallId,
                    index: index,
                    name: name,
                    inputJson: "",
                    finalized: false,
                    executionPhase: .preparing
                )))
            }

        case let .toolUseFinalized(messageId, toolCallId, name, _, inputJson):
            updateBubble(messageId) { msg in
                if let i = msg.blocks.firstIndex(where: { Self.isTool($0, toolCallId) }),
                   case var .tool(t) = msg.blocks[i] {
                    t.name = name
                    t.inputJson = inputJson
                    t.finalized = true
                    msg.blocks[i] = .tool(t)
                }
            }

        case let .toolResult(_, toolUseId, text, isError, presentationKind, presentationPrompt):
            // tool_result 可能落在与 tool_use 不同的 message（W4.5），按 toolCallId 跨气泡全局回填，
            // 找到第一个匹配的工具卡即收手。
            for mi in messages.indices {
                if let bi = messages[mi].blocks.firstIndex(where: { Self.isTool($0, toolUseId) }),
                   case var .tool(t) = messages[mi].blocks[bi] {
                    let receipt = Self.extractApprovalReceipt(from: text)
                    t.resultText = receipt.displayText
                    if let approvalSource = receipt.source {
                        t.approvalSource = approvalSource
                    }
                    t.isError = isError
                    t.finalized = true
                    t.executionPhase = isError ? .failed : .succeeded
                    t.presentationKind = presentationKind ?? t.presentationKind
                    t.presentationPrompt = presentationPrompt ?? t.presentationPrompt
                    messages[mi].blocks[bi] = .tool(t)
                    return
                }
            }

        case let .toolExecution(event):
            applyToolExecution(event)

        case .runtimeStep:
            // 对齐 Electron：agent.stream.step 是兼容性的运行提示，不属于
            // 消息内容时间线。Thinking 由 thinking content block 呈现，工具
            // 只来自 tool_use/tool_result 与工具生命周期事件。
            break

        case let .monitorStatus(messageId, status):
            applyMonitorStatus(status, messageId: messageId)

        case let .sshOutput(messageId, output):
            applySSHOutput(output, messageId: messageId)

        case let .richContent(messageId, index, block):
            updateBubble(messageId, createIfMissing: true) { msg in
                var rendered = block
                rendered.messageId = messageId
                if let i = msg.blocks.firstIndex(where: { Self.isRichContent($0, messageId, index) }) {
                    msg.blocks[i] = .richContent(rendered)
                } else {
                    msg.blocks.append(.richContent(rendered))
                }
            }

        case let .contextRef(messageId, index, block):
            updateBubble(messageId, createIfMissing: true) { msg in
                var rendered = block
                rendered.messageId = messageId
                if let i = msg.blocks.firstIndex(where: { Self.isContextRef($0, messageId, index) }) {
                    msg.blocks[i] = .contextRef(rendered)
                } else {
                    msg.blocks.append(.contextRef(rendered))
                }
            }

        case let .messageStop(messageId, stopReason):
            let timestamp = Date()
            updateBubble(messageId) {
                $0.stopReason = stopReason
                if let messageId { $0.serverId = messageId }
                Self.finalizeThinking(in: &$0, at: timestamp)
                // 该条消息气泡定格：光标消失，但整轮可能还有后续 message。
                $0.isStreaming = false
            }
        case let .messagePersisted(messageId, persistedId, messageIds):
            applyMessageIdMappings(messageIds)
            updateBubble(messageId) { if let persistedId { $0.persistedId = persistedId } }

        case let .messageCommitted(messageId, serverId):
            guard let messageId else { break }
            updateBubble(messageId) {
                if let serverId {
                    $0.serverId = serverId
                    $0.persistedId = serverId
                }
            }

        case let .done(stopReason, errorInfo):
            updateBubble(nil) {
                if $0.stopReason == nil { $0.stopReason = stopReason }
                if let errorInfo {
                    Self.apply(errorInfo: errorInfo, to: &$0)
                }
            }
            endStreaming()

        case let .systemNotice(_, envelope):
            systemNotice = envelope.payloadString("content")
                ?? envelope.payloadString("message")

        case .hitl:
            // HITL 由 ConversationViewModel 在投射前拦截路由（coordinator / inline 卡），不落消息流。
            break

        case .subagent:
            // 子 Agent 事件由 ConversationViewModel 聚合进会话内联卡片，不作为普通消息落入主时间线。
            break

        case .subagentStream:
            // 子 Agent 内层 transcript 由 ConversationViewModel 按 runId 独立重放，不落主消息流。
            break

        case .todoUpdate, .checkpointHealth:
            // 会话级状态事件由 ConversationViewModel 消费，不落消息流。
            break

        case .connectionInterrupted, .connectionRestored, .sequenceGap:
            // 传输层信号：不改消息流，由 ConversationViewModel 驱动连接 banner / seq-gap 兑底。
            break

        case let .observedUserMessage(id, text, senderUserId, senderDisplayName, triggeredBy):
            appendObservedUserMessage(
                id: id,
                text: text,
                senderUserId: senderUserId,
                senderDisplayName: senderDisplayName,
                triggeredBy: triggeredBy
            )

        case let .error(errorInfo):
            updateBubble(nil) {
                Self.apply(errorInfo: errorInfo, to: &$0)
                $0.isStreaming = false
            }
            endStreaming()
        }
    }

    private mutating func applyToolExecution(_ event: ToolExecutionUpdate) {
        if let location = toolLocation(toolCallId: event.toolCallId) {
            guard case var .tool(tool) = messages[location.message].blocks[location.block] else { return }
            let current = tool.resolvedExecutionPhase
            if current.isTerminal, event.phase == .running {
                // 终态之后迟到的 tool_progress/tool_started 不得让卡片复活成运行中。
                return
            }

            tool.name = event.toolName
            tool.durationMs = event.durationMs ?? tool.durationMs
            tool.progressOutputBytes = event.outputBytes ?? tool.progressOutputBytes
            tool.progressIsTruncated = tool.progressIsTruncated || event.progressIsTruncated
            tool.hasSuspiciousOutput = tool.hasSuspiciousOutput || event.suspicious
            tool.approvalSource = event.approvalSource ?? tool.approvalSource
            tool.errorKind = event.errorKind ?? tool.errorKind
            tool.taskId = event.taskId ?? tool.taskId
            // lifecycle 可在 tool_result 之前带上 presentation（文生图生成中态依赖此路径）。
            tool.presentationKind = event.presentationKind ?? tool.presentationKind
            tool.presentationPrompt = event.presentationPrompt ?? tool.presentationPrompt

            switch event.phase {
            case .running:
                tool.executionPhase = .running
                if let outputText = event.outputText { tool.progressText = outputText }
            case .succeeded:
                guard current != .failed else { break }
                tool.executionPhase = .succeeded
                if let outputText = event.outputText {
                    let receipt = Self.extractApprovalReceipt(from: outputText)
                    tool.resultText = receipt.displayText
                    tool.approvalSource = receipt.source ?? tool.approvalSource
                }
            case .failed:
                tool.executionPhase = .failed
                tool.isError = true
                if let outputText = event.outputText { tool.resultText = outputText }
            }
            messages[location.message].blocks[location.block] = .tool(tool)
            return
        }

        updateBubble(nil, createIfMissing: true) { msg in
            let phase: ToolExecutionPhase
            switch event.phase {
            case .running: phase = .running
            case .succeeded: phase = .succeeded
            case .failed: phase = .failed
            }
            let receipt = Self.extractApprovalReceipt(from: event.outputText ?? "")
            msg.blocks.append(.tool(ToolCall(
                toolCallId: event.toolCallId,
                index: Self.nextSyntheticBlockIndex(in: msg),
                name: event.toolName,
                inputJson: "",
                finalized: true,
                resultText: phase.isTerminal ? receipt.displayText : nil,
                isError: phase == .failed,
                executionPhase: phase,
                progressText: phase.isRunning ? event.outputText : nil,
                progressOutputBytes: event.outputBytes,
                progressIsTruncated: event.progressIsTruncated,
                durationMs: event.durationMs,
                hasSuspiciousOutput: event.suspicious,
                approvalSource: receipt.source ?? event.approvalSource,
                errorKind: event.errorKind,
                taskId: event.taskId,
                presentationKind: event.presentationKind,
                presentationPrompt: event.presentationPrompt
            )))
        }
    }

    private mutating func applyMonitorStatus(_ status: AgentMonitorStatus, messageId: String?) {
        let locator = status.monitorId ?? status.taskId ?? status.command ?? status.description ?? "active"
        let toolCallId = "monitor:\(locator)"
        let normalized = status.status?.lowercased()
        let phase: ToolExecutionPhase
        switch normalized {
        case "failed", "error":
            phase = .failed
        case "stopped", "stream_ended", "completed", "success", "succeeded":
            phase = .succeeded
        default:
            phase = .running
        }

        let inputJson = Self.jsonString([
            "command": status.command,
            "notify_on": status.notifyOn,
        ])
        updateBubble(messageId, createIfMissing: true) { msg in
            if let index = msg.blocks.firstIndex(where: { Self.isTool($0, toolCallId) }),
               case var .tool(tool) = msg.blocks[index] {
                guard !tool.resolvedExecutionPhase.isTerminal || phase.isTerminal else { return }
                tool.executionPhase = phase
                tool.isError = phase == .failed
                tool.resultText = status.failReason ?? tool.resultText
                tool.errorKind = status.emitInterrupted == true ? "monitor_emit_interrupted" : tool.errorKind
                msg.blocks[index] = .tool(tool)
            } else {
                msg.blocks.append(.tool(ToolCall(
                    toolCallId: toolCallId,
                    index: Self.nextSyntheticBlockIndex(in: msg),
                    name: "monitor_status",
                    inputJson: inputJson,
                    finalized: true,
                    resultText: status.failReason,
                    isError: phase == .failed,
                    executionPhase: phase,
                    errorKind: status.emitInterrupted == true ? "monitor_emit_interrupted" : nil,
                    runtimeTitle: status.description ?? "监控任务",
                    taskId: status.taskId
                )))
            }
        }
    }

    private mutating func applySSHOutput(_ output: AgentSSHOutput, messageId: String?) {
        let location = sshToolLocation(output)
        if let location,
           case var .tool(tool) = messages[location.message].blocks[location.block] {
            guard !tool.resolvedExecutionPhase.isTerminal else { return }
            tool.executionPhase = .running
            tool.taskId = output.taskId ?? tool.taskId
            tool.progressText = Self.appendOutput(tool.progressText, output.output)
            messages[location.message].blocks[location.block] = .tool(tool)
            return
        }

        let locator = output.toolCallId ?? output.taskId ?? output.sessionId ?? UUID().uuidString
        updateBubble(messageId, createIfMissing: true) { msg in
            let initialOutput: String
            if let serverName = output.serverName, !serverName.isEmpty {
                initialOutput = "[\(serverName)] \(output.output)"
            } else {
                initialOutput = output.output
            }
            msg.blocks.append(.tool(ToolCall(
                toolCallId: output.toolCallId ?? "ssh:\(locator)",
                index: Self.nextSyntheticBlockIndex(in: msg),
                name: "ssh_execute",
                inputJson: "",
                finalized: true,
                executionPhase: .running,
                progressText: initialOutput,
                runtimeTitle: output.serverName,
                taskId: output.taskId
            )))
        }
    }

    // MARK: - 非阻断 HITL inline 卡（plan / mode_switch）

    /// 把 Plan / mode_switch 提案投射成独立 inline 卡消息（按稳定 id 去重）。
    mutating func appendProposalCard(_ prompt: HITLPrompt) {
        switch prompt {
        case let .planProposal(p):
            let id = "plan_\(p.planDocumentId)"
            guard !messages.contains(where: { $0.id == id }) else { return }
            messages.append(ChatMessage(id: id, role: .assistant, planProposal: p))
        case let .modeSwitch(m):
            let id = "mode_\(m.proposalId)"
            guard !messages.contains(where: { $0.id == id }) else { return }
            messages.append(ChatMessage(id: id, role: .assistant, modeSwitchProposal: m))
        default:
            break
        }
    }

    /// 标记某张 inline 卡已处理（执行 / 忽略后收起按钮）。
    mutating func markProposalResolved(id: String) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].proposalResolved = true
    }

    // MARK: - 收尾

    /// 强制结束当前流式态（流被取消 / AsyncStream 结束兜底）：所有未定格气泡收尾，清路由状态。
    mutating func endStreaming() {
        let timestamp = Date()
        for i in messages.indices {
            if messages[i].isStreaming {
                messages[i].isStreaming = false
            }
            Self.finalizeThinking(in: &messages[i], at: timestamp)
        }
        bubbleForMessage.removeAll()
        activeAssistantId = nil
        pendingOptimisticId = nil
        phase = nil
    }

    private static func finalizeThinking(in message: inout ChatMessage, at timestamp: Date) {
        for blockIndex in message.blocks.indices {
            guard case var .thinking(segment) = message.blocks[blockIndex],
                  !segment.completed else { continue }
            segment.completed = true
            if segment.startedAt == nil { segment.startedAt = timestamp }
            if segment.stoppedAt == nil { segment.stoppedAt = timestamp }
            message.blocks[blockIndex] = .thinking(segment)
        }
    }

    // MARK: - 私有

    private mutating func applyMessageIdMappings(_ mappings: [MessageIdMapping]) {
        for mapping in mappings {
            guard let idx = messages.firstIndex(where: {
                $0.identityKeys.contains(mapping.clientEventId) || $0.id == mapping.clientEventId
            }) else { continue }
            if messages[idx].serverId == nil { messages[idx].serverId = mapping.serverId }
            if messages[idx].persistedId == nil { messages[idx].persistedId = mapping.serverId }
            if messages[idx].clientEventId == nil { messages[idx].clientEventId = mapping.clientEventId }
        }
    }

    /// 历史对账后重建 messageId → 气泡路由，避免重连重放 message_start 时 map 空而新建双份。
    private mutating func rebuildBubbleRoutingFromMessages() {
        bubbleForMessage.removeAll()
        for message in messages where message.role == .assistant {
            if let serverId = message.serverId?.trimmingCharacters(in: .whitespacesAndNewlines),
               !serverId.isEmpty {
                bubbleForMessage[serverId] = message.id
            }
            if let persistedId = message.persistedId?.trimmingCharacters(in: .whitespacesAndNewlines),
               !persistedId.isEmpty {
                bubbleForMessage[persistedId] = message.id
            }
        }
    }

    /// message_start：首条认领乐观占位气泡，后续各自新建独立气泡（多气泡的核心）。
    /// 重连对账后 map 可能被清掉，但仍须按 identity 认领已有气泡，不能再新建。
    private mutating func beginOrClaimBubble(messageId: String?, agentId: String?) {
        guard let mid = messageId else { return }
        if let existing = bubbleForMessage[mid] {
            activeAssistantId = existing   // 幂等：重复 message_start
            if let agentId {
                updateBubble(mid) { $0.agentId = agentId }
            }
            return
        }
        if let idx = messages.firstIndex(where: {
            $0.role == .assistant && (
                $0.identityKeys.contains(mid)
                    || $0.serverId == mid
                    || $0.persistedId == mid
                    || $0.effectiveId == mid
            )
        }) {
            let localId = messages[idx].id
            bubbleForMessage[mid] = localId
            if messages[idx].serverId == nil { messages[idx].serverId = mid }
            if let agentId { messages[idx].agentId = agentId }
            activeAssistantId = localId
            return
        }
        if let opt = pendingOptimisticId {
            bubbleForMessage[mid] = opt
            if let idx = messages.firstIndex(where: { $0.id == opt }) {
                messages[idx].serverId = mid
                messages[idx].isStreaming = true
                if let agentId { messages[idx].agentId = agentId }
            }
            activeAssistantId = opt
            pendingOptimisticId = nil
            return
        }
        let localId = "asst_\(mid)"
        var msg = ChatMessage(id: localId, role: .assistant, agentId: agentId, isStreaming: true)
        msg.serverId = mid
        messages.append(msg)
        bubbleForMessage[mid] = localId
        activeAssistantId = localId
    }

    /// 把更新落到 messageId 对应的气泡；messageId 为空时落最近活动气泡。
    /// 中途加入会话可能错过 message_start，但后续 delta 仍带稳定 message_id；
    /// 可见内容事件允许按 message_id 懒建气泡，stop/persisted 等元事件不凭空造空白气泡。
    private mutating func updateBubble(
        _ messageId: String?,
        createIfMissing: Bool = false,
        _ mutate: (inout ChatMessage) -> Void
    ) {
        pruneStaleBubbleRouting(for: messageId)
        guard let id = resolveBubbleId(messageId, createIfMissing: createIfMissing),
              let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        var msg = messages[idx]
        mutate(&msg)
        messages[idx] = msg
    }

    /// 兜底：路由指向的气泡已不在列表里（历史合并换过行，或被回退截断）时，
    /// 先按 messageId 的 identity 找回真实行回填路由，找不到就清掉这条映射——
    /// 留着幽灵映射会让 `createIfMissing` 也失效，整段 delta 静默消失。
    private mutating func pruneStaleBubbleRouting(for messageId: String?) {
        guard let messageId,
              let routed = bubbleForMessage[messageId],
              !messages.contains(where: { $0.id == routed }) else { return }
        let recovered = messages.first {
            $0.role == .assistant && $0.identityKeys.contains(messageId)
        }
        if let recovered {
            bubbleForMessage[messageId] = recovered.id
        } else {
            bubbleForMessage.removeValue(forKey: messageId)
        }
        if activeAssistantId == routed { activeAssistantId = recovered?.id }
        if pendingOptimisticId == routed { pendingOptimisticId = recovered?.id }
    }

    private static func apply(errorInfo: ChatStreamErrorInfo, to message: inout ChatMessage) {
        if let value = errorInfo.message, !value.isEmpty { message.errorMessage = value }
        if let value = errorInfo.errorClass, !value.isEmpty { message.errorClass = value }
        if let value = errorInfo.suggestedAction, !value.isEmpty { message.suggestedAction = value }
        if let value = errorInfo.errorCategory, !value.isEmpty { message.errorCategory = value }
        if let value = errorInfo.errorCode, !value.isEmpty { message.errorCode = value }
        if message.errorMessage == nil, errorInfo.hasStructuredFields {
            message.errorMessage = ""
        }
    }

    private mutating func resolveBubbleId(_ messageId: String?, createIfMissing: Bool = false) -> String? {
        if let messageId, let id = bubbleForMessage[messageId] { return id }
        if createIfMissing, messageId != nil {
            // 中途加入只收到 delta 时没有 message_start 身份；先建无身份气泡，
            // 收尾历史对账再用持久化 message.agent_id 补齐。
            beginOrClaimBubble(messageId: messageId, agentId: nil)
            if let messageId, let id = bubbleForMessage[messageId] { return id }
        }
        if messageId != nil { return nil }
        return activeAssistantId ?? pendingOptimisticId
    }

    private func toolLocation(toolCallId: String) -> (message: Int, block: Int)? {
        for messageIndex in messages.indices.reversed() {
            if let blockIndex = messages[messageIndex].blocks.firstIndex(where: {
                Self.isTool($0, toolCallId)
            }) {
                return (messageIndex, blockIndex)
            }
        }
        return nil
    }

    private func sshToolLocation(_ output: AgentSSHOutput) -> (message: Int, block: Int)? {
        if let toolCallId = output.toolCallId,
           let exact = toolLocation(toolCallId: toolCallId) {
            return exact
        }
        for messageIndex in messages.indices.reversed() {
            for blockIndex in messages[messageIndex].blocks.indices.reversed() {
                guard case let .tool(tool) = messages[messageIndex].blocks[blockIndex],
                      tool.name == "ssh_execute" || tool.name == "ssh" else {
                    continue
                }
                if let taskId = output.taskId, tool.taskId == taskId {
                    return (messageIndex, blockIndex)
                }
                if output.taskId == nil, tool.isExecutionRunning {
                    return (messageIndex, blockIndex)
                }
            }
        }
        return nil
    }

    private struct ApprovalReceiptPresentation {
        let displayText: String?
        let source: ToolApprovalSource?
    }

    private static func extractApprovalReceipt(from raw: String) -> ApprovalReceiptPresentation {
        guard let start = raw.range(of: "<approval_note>"),
              let end = raw.range(of: "</approval_note>", range: start.upperBound..<raw.endIndex) else {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return ApprovalReceiptPresentation(displayText: trimmed.isEmpty ? nil : trimmed, source: nil)
        }

        let note = String(raw[start.upperBound..<end.lowerBound]).lowercased()
        let source: ToolApprovalSource? = note.contains("auto-approved")
            || note.contains("always allow")
            ? .standingRule
            : note.contains("user approved") ? .user : nil
        var cleaned = raw
        cleaned.removeSubrange(start.lowerBound..<end.upperBound)
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return ApprovalReceiptPresentation(displayText: trimmed.isEmpty ? nil : trimmed, source: source)
    }

    private static func nextSyntheticBlockIndex(in message: ChatMessage) -> Int {
        (message.blocks.map(\.index).max() ?? -1) + 1
    }

    private static func appendOutput(_ existing: String?, _ chunk: String) -> String? {
        guard !chunk.isEmpty else { return existing }
        return (existing ?? "") + chunk
    }

    private static func jsonString(_ values: [String: String?]) -> String {
        let object = values.reduce(into: [String: String]()) { result, pair in
            if let value = pair.value, !value.isEmpty {
                result[pair.key] = value
            }
        }
        guard !object.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return ""
        }
        return string
    }

    // MARK: - 同 kind 复合键匹配（绝不跨 kind，杜绝撞号反复新建）

    private static func isText(_ block: MessageBlock, _ messageId: String?, _ index: Int) -> Bool {
        if case let .text(b) = block { return b.messageId == messageId && b.index == index }
        return false
    }

    private static func isThinking(_ block: MessageBlock, _ messageId: String?, _ index: Int) -> Bool {
        if case let .thinking(s) = block { return s.messageId == messageId && s.index == index }
        return false
    }

    private static func isTool(_ block: MessageBlock, _ toolCallId: String) -> Bool {
        if case let .tool(t) = block { return t.toolCallId == toolCallId }
        return false
    }

    private static func isRichContent(_ block: MessageBlock, _ messageId: String?, _ index: Int) -> Bool {
        if case let .richContent(r) = block { return r.messageId == messageId && r.index == index }
        return false
    }

    private static func isContextRef(_ block: MessageBlock, _ messageId: String?, _ index: Int) -> Bool {
        if case let .contextRef(r) = block { return r.messageId == messageId && r.index == index }
        return false
    }
}

private extension ChatMessage {
    func sharesIdentity(with other: ChatMessage) -> Bool {
        !identityKeys.isDisjoint(with: other.identityKeys)
    }

    func isLegacyUserDuplicate(of server: ChatMessage) -> Bool {
        guard isUser, server.isUser else { return false }
        guard canonicalClientEventId != nil || server.canonicalClientEventId != nil else { return false }
        let lhs = String(text.prefix(100))
        let rhs = String(server.text.prefix(100))
        guard !lhs.isEmpty, lhs == rhs else { return false }
        return abs(createdAt.timeIntervalSince1970 - server.createdAt.timeIntervalSince1970) < 5
    }
}
