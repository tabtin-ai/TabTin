import Foundation

/// 「接下来要跑什么」——把服务端返回的未来执行点整理成手机上能一眼扫完的形状。
///
/// 桌面端用月历 / 周历回答这个问题；390pt 宽的手机上格子点不准、信息密度也上不去。
/// 手机端换一种问法：**按天分组的近期清单**，今天/明天优先，只覆盖一个短窗口。
/// 用户在手机上关心的是「等下、今晚、明早有什么要跑」，不是「这个月的全貌」。
enum TrackerSchedulePreviewPolicy {
    /// 预览窗口。7 天足够回答「这几天有什么」，再长就该去桌面端看日历了；
    /// 窗口越大服务端展开的执行点越多，也越容易触发 truncated。
    static let windowDays = 7

    /// 每天最多列几条。一天几十次的高频任务会把清单刷爆，超出部分折叠成「还有 N 次」。
    static let maxOccurrencesPerDay = 4

    struct Day: Identifiable, Equatable {
        let date: Date
        let occurrences: [TrackerScheduleOccurrence]
        /// 超出 `maxOccurrencesPerDay` 被折叠的条数。
        let hiddenCount: Int

        var id: TimeInterval { date.timeIntervalSince1970 }
    }

    /// 查询窗口 `[from, to)`。
    static func window(now: Date = Date(), calendar: Calendar = .current) -> (from: Date, to: Date) {
        let to = calendar.date(byAdding: .day, value: windowDays, to: now) ?? now
        return (now, to)
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// 按自然日分组，日内按时间升序；解析不出时间的条目直接丢弃——
    /// 一条不知道什么时候跑的「未来执行点」对用户没有任何意义。
    static func days(
        from occurrences: [TrackerScheduleOccurrence],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [Day] {
        let parsed = occurrences.compactMap { occurrence -> (Date, TrackerScheduleOccurrence)? in
            guard let date = parseISO(occurrence.scheduledAt) else { return nil }
            // 服务端窗口以请求时刻为准，返回途中可能已经跑过去了；过期的不再展示。
            guard date >= now else { return nil }
            return (date, occurrence)
        }

        let grouped = Dictionary(grouping: parsed) { calendar.startOfDay(for: $0.0) }

        return grouped.keys.sorted().map { day in
            let sorted = (grouped[day] ?? [])
                .sorted { $0.0 < $1.0 }
                .map(\.1)
            let visible = Array(sorted.prefix(maxOccurrencesPerDay))
            return Day(
                date: day,
                occurrences: visible,
                hiddenCount: max(0, sorted.count - visible.count)
            )
        }
    }

    /// 日期标题：今天 / 明天用相对词，其余给「周几 · M月d日」——
    /// 只有周几没有日期，跨周时会指向错的那天。
    static func dayTitle(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = LanguageManager.shared.effectiveLocale
    ) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return L10n.Common.today }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) {
            return L10n.Automation.tomorrow
        }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("EEEE Md")
        return formatter.string(from: date)
    }

    /// 执行点的时刻,例如 `09:00`。
    static func timeLabel(
        for occurrence: TrackerScheduleOccurrence,
        locale: Locale = LanguageManager.shared.effectiveLocale
    ) -> String? {
        guard let date = parseISO(occurrence.scheduledAt) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("Hm")
        return formatter.string(from: date)
    }

    static func parseISO(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}
