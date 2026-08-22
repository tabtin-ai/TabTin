import SwiftUI

/// 任务列表行头像解析：跟**执行 Agent**走，不跟会话上可能过期的 `agent_avatar` 死字段走。
///
/// 真机常连 api-test：列表 `agent_avatar` 可能为空 / 仍是旧脸；但切换后 `agent_id` 会变。
/// 只要组织 Agent 缓存里有这份身份，就按缓存画脸——返回任务页时不用赌列表接口有没有带头像。
enum TaskHomeAgentFaceResolver {
    /// 解析用于列表展示的头像 raw（预置 key 或 http(s) URL）。
    ///
    /// 优先级：组织 Agent 的 url → key → 会话字段 → 有 Agent 身份时 `general-assistant`。
    static func resolveAvatarRaw(
        agentId: String?,
        sessionAvatar: String?,
        storeAvatarURL: String?,
        storeAvatarKey: String?
    ) -> String? {
        if let url = nonEmpty(storeAvatarURL) { return url }
        if let key = nonEmpty(storeAvatarKey) { return key }
        if let session = nonEmpty(sessionAvatar) { return session }
        if nonEmpty(agentId) != nil {
            return AgentAvatarPreset.generalAssistant.rawValue
        }
        return nil
    }

    static func resolveDisplayName(
        agentId: String?,
        sessionAgentName: String?,
        storeDisplayName: String?,
        locationName: String?
    ) -> String {
        if let name = nonEmpty(storeDisplayName) { return name }
        if let name = nonEmpty(sessionAgentName) { return name }
        if let name = nonEmpty(locationName) { return name }
        return nonEmpty(agentId) != nil ? "Agent" : "?"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 任务行头像：会话所属 Agent 的头像，运行态画在头像四周。
///
/// 参考 OpenMinis 会话列表的做法——状态长在头像上，一眼就知道「谁在跑、跑到哪」，
/// 不用再去标题旁边找小圆点。区别在于圆里放的不是分类图标：任务是**某个 Agent**
/// 在替你跑，头像比抽象气泡更能回答「这是谁的活」。
///
/// 信号分三层，互不打架：
/// - 光环：正在跑 = 旋转弧；暂停 = 虚线圈（Agent 自己停下，比「等你」弱一档）
/// - 右下角标：失败 / 等你确认，二选一，按紧迫度取最高
/// - 右上圆点：跑完了但你还没看
///
/// 「已归档」刻意不上角标：归档会话只在「已归档」范围里成片出现，
/// 给每个头像都挂一个同样的标只是噪音；第二行的「已归档」文字已经说清楚了。
struct TaskHomeSessionAvatar: View {
    let session: RecentSession
    let state: AgentRunPresentationState
    var size: CGFloat = 44

    /// 组织 Agent 缓存：切换执行 Agent 后以这里的脸为准，避免被列表旧 `agent_avatar` 盖住。
    @State private var myAgentsStore = MyAgentsStore.shared

    private var badge: TaskRowStatusPresentation.Badge {
        TaskRowStatusPresentation.resolve(from: state)
    }

    private var isPaused: Bool {
        if case .paused = state.phase { return true }
        return false
    }

    private var isWaitingForUser: Bool {
        if case .waitingForUser = state.phase { return true }
        return false
    }

    /// 完成但未读——Agent 干完了，你还没看。已读完成不留痕迹。
    private var hasUnreadReply: Bool {
        if case .completed(let unread) = state.phase { return unread }
        return false
    }

    var body: some View {
        avatar
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay { ring }
            .overlay(alignment: .bottomTrailing) { cornerBadge }
            .overlay(alignment: .topTrailing) { unreadDot }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
    }

    // MARK: - 头像本体

    @ViewBuilder
    private var avatar: some View {
        if let preset = avatarPreset {
            Image(preset.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
        } else if let remoteAvatarURL {
            // 自定义 URL（无预置 key 时）。
            IdentityColorAvatar(
                name: agentDisplayName,
                seed: seed,
                imageUrl: remoteAvatarURL,
                size: size
            )
        } else if hasAgentIdentity {
            // 有 Agent 但后端未下发头像（旧响应 / 空 settings）：品牌默认图，不落首字。
            Image(AgentAvatarPreset.generalAssistant.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
        } else {
            // 连 Agent 身份都没有时，才用彩色首字（归属名 / ?）。
            IdentityColorAvatar(
                name: agentDisplayName,
                seed: seed,
                imageUrl: nil,
                size: size
            )
        }
    }

    private var storeAgent: OrganizationAgent? {
        guard let agentId = session.normalizedAgentId else { return nil }
        return myAgentsStore.agents.first(where: { $0.id == agentId })
    }

    private var storeDeactivatedAgent: DeactivatedOrganizationAgent? {
        guard let agentId = session.normalizedAgentId else { return nil }
        return myAgentsStore.deactivatedAgents.first(where: { $0.id == agentId })
    }

    /// 最终展示用的头像 raw：组织缓存优先，会话字段兜底。
    private var resolvedAvatarRaw: String? {
        TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: session.normalizedAgentId,
            sessionAvatar: session.agentAvatar,
            storeAvatarURL: storeAgent?.settings?.avatarURL
                ?? storeDeactivatedAgent?.settings?.avatarURL,
            storeAvatarKey: storeAgent?.settings?.avatarKey
                ?? storeDeactivatedAgent?.settings?.avatarKey
        )
    }

    /// 后端 / 缓存既可能是预置 key，也可能是自定义 URL；key 优先，和 Electron 一致。
    private var avatarPreset: AgentAvatarPreset? {
        guard let raw = normalized(resolvedAvatarRaw) else { return nil }
        return AgentAvatarPreset(rawValue: raw)
    }

    /// 会话已挂 Agent 时，缺图不应退化成「名字首字」——那会让整表看起来都没头像。
    private var hasAgentIdentity: Bool {
        session.normalizedAgentId != nil
            || normalized(session.agentName) != nil
            || storeAgent != nil
            || storeDeactivatedAgent != nil
    }

    private var remoteAvatarURL: String? {
        guard let raw = normalized(resolvedAvatarRaw),
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return raw
    }

    /// 首字兜底认「谁」，不认「这条任务叫什么」——拿任务标题首字当头像，
    /// 同一个 Agent 的多条任务会出现五颜六色的头像，反而更难扫。
    /// 口径与「最近」列表一致：Agent 名 → 归属名 → `?`。
    private var agentDisplayName: String {
        TaskHomeAgentFaceResolver.resolveDisplayName(
            agentId: session.normalizedAgentId,
            sessionAgentName: session.agentName,
            storeDisplayName: storeAgent?.displayName ?? storeDeactivatedAgent?.name,
            locationName: TaskRowContentPolicy.locationName(session: session)
        )
    }

    /// 同一个 Agent 在列表里必须始终同色；没有 agent 身份时才退回归属 / 会话自身。
    private var seed: String {
        session.normalizedAgentId
            ?? normalized(agentDisplayName)
            ?? session.id
    }

    // MARK: - 状态层

    @ViewBuilder
    private var ring: some View {
        if badge == .running {
            // 在跑就该动——静态描边没法把「此刻正在推进」和「停在那儿」区分开。
            TaskHomeSpinningRing(color: .tt.bgRunning)
                .frame(width: size + ringInset, height: size + ringInset)
        } else if isPaused {
            Circle()
                .strokeBorder(
                    Color.tt.bgWarning.opacity(0.7),
                    style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])
                )
                .frame(width: size + ringInset, height: size + ringInset)
        }
    }

    private var ringInset: CGFloat { 5 }

    @ViewBuilder
    private var cornerBadge: some View {
        if let corner {
            Image(systemName: corner.symbol)
                .font(.tt.iconCaption)
                .foregroundStyle(Color.tt.textOnAccent)
                .frame(width: badgeSize, height: badgeSize)
                .background(Circle().fill(corner.tint))
                .overlay(Circle().strokeBorder(Color.tt.bgCanvasDefault, lineWidth: 1.5))
                .offset(x: 3, y: 3)
        }
    }

    private var badgeSize: CGFloat { 18 }

    /// 角标只挂一个：紧迫度高的赢。
    private var corner: (symbol: String, tint: Color)? {
        if badge == .failed { return ("xmark", .tt.bgCritical) }
        if isWaitingForUser { return ("exclamationmark", .tt.bgWarning) }
        return nil
    }

    @ViewBuilder
    private var unreadDot: some View {
        if hasUnreadReply {
            // 蓝色而非红色：红色在这一列已经是「失败」，未读只是「有新东西」。
            Circle()
                .fill(Color.tt.bgRunning)
                .frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(Color.tt.bgCanvasDefault, lineWidth: 1.5))
                .offset(x: -1, y: 1)
        }
    }

    private var accessibilityLabel: String {
        var parts = [agentDisplayName]
        switch state.phase {
        case .failed:
            parts.append(L10n.RunStatus.failed)
        case .waitingForUser(let count):
            parts.append(L10n.RunStatus.waitingForUser(count))
        case .paused:
            parts.append(L10n.RunStatus.paused)
        case .preparing, .planning, .executing, .responding, .recoveringConnection:
            parts.append(L10n.Home.sessionStatusRunning)
        case .completed(let unread):
            parts.append(unread ? L10n.Home.sessionStatusUnread : L10n.RunStatus.completed)
        case .idle:
            break
        }
        return parts.joined(separator: "，")
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 运行中的旋转弧。用 `TimelineView` 驱动而非 `repeatForever` 动画：
/// 列表行会被 SwiftUI 反复复用，隐式动画在复用时容易卡在半截角度上。
struct TaskHomeSpinningRing: View {
    let color: Color

    var body: some View {
        TimelineView(.animation) { timeline in
            let angle = timeline.date.timeIntervalSinceReferenceDate
                .remainder(dividingBy: 1.0) * 360
            Circle()
                .trim(from: 0, to: 0.3)
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .rotationEffect(.degrees(angle))
        }
    }
}
