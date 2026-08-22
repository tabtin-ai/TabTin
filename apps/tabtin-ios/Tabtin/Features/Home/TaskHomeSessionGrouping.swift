import Foundation

/// 任务列表分段：置顶 / 需要你 / 按时间落桶。
///
/// 时间是用户回忆一条任务的第一索引——「昨天那个爬数据的」比「第 14 条」好找得多。
/// 平铺一长条列表时，滚过三屏就失去坐标；分段让每一屏都自带时间锚点。
///
/// 置顶与「需要你」是语义段，永远压在时间段之上：它们回答的是「现在该管哪条」，
/// 优先级高于「什么时候动过」。
enum TaskHomeSessionGrouping {
    enum Band: String, Hashable, Identifiable, CaseIterable {
        case pinned
        case needsYou
        case today
        case yesterday
        case last7Days
        case last30Days
        case earlier

        var id: String { rawValue }

        var title: String {
            switch self {
            case .pinned: return L10n.Home.segmentPinned
            case .needsYou: return L10n.Home.bandNeedsYou
            case .today: return L10n.Common.today
            case .yesterday: return L10n.Common.yesterday
            case .last7Days: return L10n.Home.groupLast7Days
            case .last30Days: return L10n.Home.groupLast30Days
            case .earlier: return L10n.Home.groupEarlier
            }
        }

        /// 置顶段带图钉字形，和行尾的图钉呼应；时间段不带任何装饰。
        var showsPinGlyph: Bool { self == .pinned }
    }

    struct Group: Identifiable, Hashable {
        let band: Band
        let sessions: [RecentSession]

        var id: String { band.rawValue }
    }

    /// - Parameters:
    ///   - pinned/needsYou: 已由调用方按语义挑出且互斥的两段，保持传入顺序。
    ///   - rest: 其余会话，已按活跃时间倒序；这里只负责落时间桶，不重新排序。
    static func groups(
        pinned: [RecentSession],
        needsYou: [RecentSession],
        rest: [RecentSession],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [Group] {
        var result: [Group] = []
        if !pinned.isEmpty { result.append(Group(band: .pinned, sessions: pinned)) }
        if !needsYou.isEmpty { result.append(Group(band: .needsYou, sessions: needsYou)) }

        var buckets: [Band: [RecentSession]] = [:]
        for session in rest {
            buckets[timeBand(for: session, now: now, calendar: calendar), default: []].append(session)
        }
        for band in [Band.today, .yesterday, .last7Days, .last30Days, .earlier] {
            if let sessions = buckets[band], !sessions.isEmpty {
                result.append(Group(band: band, sessions: sessions))
            }
        }
        return result
    }

    /// 时间戳解析不出来时归入「更早」——宁可排在最后，也不要伪造成「今天」把最新一屏搅乱。
    static func timeBand(
        for session: RecentSession,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Band {
        guard let date = activityDate(for: session) else { return .earlier }
        // 一律以传入的 `now` 为基准，不用 `isDateInToday`——后者永远读系统当下，
        // 会让「今天」在注入时间的场景（单测 / 回放）里静默错桶。
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return .yesterday
        }
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        if date > weekAgo { return .last7Days }
        let monthAgo = calendar.date(byAdding: .month, value: -1, to: now) ?? now
        if date > monthAgo { return .last30Days }
        return .earlier
    }

    /// 与 `RecentSessionActivityPolicy.sortKey` 同源：分段依据必须和排序依据一致，
    /// 否则会出现「排在今天段里、时间显示三天前」的错位。
    static func activityDate(for session: RecentSession) -> Date? {
        guard let raw = session.lastMessageAt ?? session.updatedAt ?? session.createdAt else {
            return nil
        }
        return fractionalISO.date(from: raw) ?? plainISO.date(from: raw)
    }

    private nonisolated(unsafe) static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let plainISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
