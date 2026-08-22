import Foundation

enum MemoAppHomeViewKind: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case today
    case agentDiary

    var id: String { rawValue }

    /// 生产 UI 可见的预设；Agent 日记由 feature flag 控制。
    static var visibleCases: [MemoAppHomeViewKind] {
        var cases: [MemoAppHomeViewKind] = [.all, .today]
        if MemoAppHomeFeatureFlags.isOrganizationAgentDiaryEnabled {
            cases.append(.agentDiary)
        }
        return cases
    }
}

enum MemoTimelineSectionKind: String, Hashable, Sendable {
    case pinned
    case today
    case yesterday
    case thisWeek
    case older
}

struct MemoTimelineSection: Identifiable, Hashable, Sendable {
    let kind: MemoTimelineSectionKind
    let title: String
    let items: [CloudMemoSummary]

    var id: String { kind.rawValue }
}

/// 置顶与时间分组是纯投影，不改变服务端 cursor 顺序语义。
enum MemoTimelineProjector {
    static func project(
        memos: [CloudMemoSummary],
        now: Date = Date(),
        calendar: Calendar = .current,
        titles: SectionTitles = .localized
    ) -> [MemoTimelineSection] {
        let pinned = memos.filter(\.isPinned)
        let unpinned = memos.filter { !$0.isPinned }

        let startOfToday = calendar.startOfDay(for: now)
        guard let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: startOfToday),
              let startOfWeek = calendar.date(byAdding: .day, value: -6, to: startOfToday) else {
            return makeSections(
                pinned: pinned,
                today: unpinned,
                yesterday: [],
                thisWeek: [],
                older: [],
                titles: titles
            )
        }

        var todayItems: [CloudMemoSummary] = []
        var yesterdayItems: [CloudMemoSummary] = []
        var weekItems: [CloudMemoSummary] = []
        var olderItems: [CloudMemoSummary] = []

        for memo in unpinned {
            guard let date = memo.createdDate else {
                todayItems.append(memo)
                continue
            }
            if date >= startOfToday {
                todayItems.append(memo)
            } else if date >= startOfYesterday {
                yesterdayItems.append(memo)
            } else if date >= startOfWeek {
                weekItems.append(memo)
            } else {
                olderItems.append(memo)
            }
        }

        return makeSections(
            pinned: pinned,
            today: todayItems,
            yesterday: yesterdayItems,
            thisWeek: weekItems,
            older: olderItems,
            titles: titles
        )
    }

    /// 本地日界线半开区间 `[start, end)`，供今日回顾 / 热力格筛选。
    static func localDayBounds(
        for date: Date,
        calendar: Calendar = .current
    ) -> (after: Date, before: Date) {
        let start = calendar.startOfDay(for: date)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
        return (start, end)
    }

    static func iso8601String(from date: Date) -> String {
        isoFractional.string(from: date)
    }

    /// 本月条数：对 heatmap 桶中属于当前本地月份的 count 求和。
    static func monthCount(
        from buckets: [MemoHeatmapBucket],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Int {
        let comps = calendar.dateComponents([.year, .month], from: now)
        guard let year = comps.year, let month = comps.month else { return 0 }
        let prefix = String(format: "%04d-%02d-", year, month)
        return buckets
            .filter { $0.date.hasPrefix(prefix) }
            .reduce(0) { $0 + max(0, $1.count) }
    }

    /// 将服务端 `YYYY-MM-DD` 解析为本地日起点。
    static func date(fromServerDay day: String, calendar: Calendar = .current) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        return calendar.date(from: components)
    }

    struct SectionTitles: Sendable {
        let pinned: String
        let today: String
        let yesterday: String
        let thisWeek: String
        let older: String

        static let localized = SectionTitles(
            pinned: L10n.MemoAppHome.sectionPinned,
            today: L10n.MemoAppHome.sectionToday,
            yesterday: L10n.MemoAppHome.sectionYesterday,
            thisWeek: L10n.MemoAppHome.sectionThisWeek,
            older: L10n.MemoAppHome.sectionOlder
        )

        static let english = SectionTitles(
            pinned: "Pinned",
            today: "Today",
            yesterday: "Yesterday",
            thisWeek: "This week",
            older: "Earlier"
        )
    }

    private static func makeSections(
        pinned: [CloudMemoSummary],
        today: [CloudMemoSummary],
        yesterday: [CloudMemoSummary],
        thisWeek: [CloudMemoSummary],
        older: [CloudMemoSummary],
        titles: SectionTitles
    ) -> [MemoTimelineSection] {
        var sections: [MemoTimelineSection] = []
        if !pinned.isEmpty {
            sections.append(MemoTimelineSection(kind: .pinned, title: titles.pinned, items: pinned))
        }
        if !today.isEmpty {
            sections.append(MemoTimelineSection(kind: .today, title: titles.today, items: today))
        }
        if !yesterday.isEmpty {
            sections.append(MemoTimelineSection(kind: .yesterday, title: titles.yesterday, items: yesterday))
        }
        if !thisWeek.isEmpty {
            sections.append(MemoTimelineSection(kind: .thisWeek, title: titles.thisWeek, items: thisWeek))
        }
        if !older.isEmpty {
            sections.append(MemoTimelineSection(kind: .older, title: titles.older, items: older))
        }
        return sections
    }

    private nonisolated(unsafe) static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
