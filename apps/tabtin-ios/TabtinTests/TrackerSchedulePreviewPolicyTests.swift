import XCTest
@testable import Tabtin

/// 排期预览：按天分组、日内升序、过期剔除、每天折叠上限。
final class TrackerSchedulePreviewPolicyTests: XCTestCase {
    private let calendar = Calendar(identifier: .gregorian)
    private lazy var now: Date = calendar.date(
        from: DateComponents(year: 2026, month: 8, day: 3, hour: 9)
    )!

    private func occurrence(_ name: String, hoursFromNow: Double, trackerId: String? = nil)
        -> TrackerScheduleOccurrence {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let payload: [String: Any] = [
            "tracker_id": trackerId ?? name,
            "name": name,
            "scheduled_at": formatter.string(from: now.addingTimeInterval(hoursFromNow * 3600)),
            "status": "active",
            "trigger_type": "cron",
            "timezone": "Asia/Shanghai",
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(TrackerScheduleOccurrence.self, from: data)
    }

    // MARK: - 分组

    func testGroupsByCalendarDayInChronologicalOrder() {
        let days = TrackerSchedulePreviewPolicy.days(
            from: [
                occurrence("后天", hoursFromNow: 48),
                occurrence("今天下午", hoursFromNow: 4),
                occurrence("明早", hoursFromNow: 24),
            ],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(days.count, 3)
        XCTAssertEqual(days.map { $0.occurrences.first?.name }, ["今天下午", "明早", "后天"])
    }

    func testOccurrencesInsideDayAreSortedByTime() {
        let days = TrackerSchedulePreviewPolicy.days(
            from: [
                occurrence("晚一点", hoursFromNow: 6),
                occurrence("马上", hoursFromNow: 1),
                occurrence("中间", hoursFromNow: 3),
            ],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(days.first?.occurrences.map(\.name), ["马上", "中间", "晚一点"])
    }

    /// 服务端按请求时刻算窗口，返回途中可能已经跑过去了——过期的不该继续挂在「接下来」。
    func testPastOccurrencesAreDropped() {
        let days = TrackerSchedulePreviewPolicy.days(
            from: [occurrence("刚跑完", hoursFromNow: -1), occurrence("待跑", hoursFromNow: 2)],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days.first?.occurrences.map(\.name), ["待跑"])
    }

    /// 一天几十次的高频任务不能把清单刷爆。
    func testPerDayOverflowIsCollapsed() {
        let many = (1...9).map { occurrence("第\($0)次", hoursFromNow: Double($0)) }
        let days = TrackerSchedulePreviewPolicy.days(from: many, now: now, calendar: calendar)
        let today = days.first!
        XCTAssertEqual(today.occurrences.count, TrackerSchedulePreviewPolicy.maxOccurrencesPerDay)
        XCTAssertEqual(today.hiddenCount, 9 - TrackerSchedulePreviewPolicy.maxOccurrencesPerDay)
    }

    func testNoHiddenCountWhenWithinLimit() {
        let days = TrackerSchedulePreviewPolicy.days(
            from: [occurrence("唯一一次", hoursFromNow: 2)],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(days.first?.hiddenCount, 0)
    }

    // MARK: - 身份

    /// 同一个自动化在窗口里出现多次，`tracker_id` 不唯一——ForEach 拿它当 id 会掉行。
    func testOccurrenceIdIncludesScheduledTime() {
        let first = occurrence("每小时", hoursFromNow: 1, trackerId: "t-1")
        let second = occurrence("每小时", hoursFromNow: 2, trackerId: "t-1")
        XCTAssertNotEqual(first.id, second.id)
    }

    // MARK: - 窗口与解析

    func testWindowCoversConfiguredDays() {
        let window = TrackerSchedulePreviewPolicy.window(now: now, calendar: calendar)
        let days = calendar.dateComponents([.day], from: window.from, to: window.to).day
        XCTAssertEqual(days, TrackerSchedulePreviewPolicy.windowDays)
    }

    func testParsesBothISOForms() {
        XCTAssertNotNil(TrackerSchedulePreviewPolicy.parseISO("2026-08-03T10:00:00Z"))
        XCTAssertNotNil(TrackerSchedulePreviewPolicy.parseISO("2026-08-03T10:00:00.500Z"))
        XCTAssertNil(TrackerSchedulePreviewPolicy.parseISO("下周一"))
    }

    /// 解析不出时间的执行点没有任何意义，直接丢掉而不是排在某个默认位置。
    func testUnparsableOccurrenceIsDropped() {
        let broken = try! JSONDecoder().decode(
            TrackerScheduleOccurrence.self,
            from: Data(#"{"tracker_id":"t","name":"坏的","scheduled_at":"不是时间","status":"active","trigger_type":"cron","timezone":"UTC"}"#.utf8)
        )
        let days = TrackerSchedulePreviewPolicy.days(from: [broken], now: now, calendar: calendar)
        XCTAssertTrue(days.isEmpty)
    }

    // MARK: - 日期标题

    func testDayTitleUsesRelativeWordsForTodayAndTomorrow() {
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now)!
        XCTAssertEqual(
            TrackerSchedulePreviewPolicy.dayTitle(for: now, now: now, calendar: calendar),
            L10n.Common.today
        )
        XCTAssertEqual(
            TrackerSchedulePreviewPolicy.dayTitle(for: tomorrow, now: now, calendar: calendar),
            L10n.Automation.tomorrow
        )
    }

    /// 只有周几没有日期，跨周时会指向错的那天。
    func testDayTitleBeyondTomorrowCarriesDate() {
        let later = calendar.date(byAdding: .day, value: 4, to: now)!
        let title = TrackerSchedulePreviewPolicy.dayTitle(
            for: later, now: now, calendar: calendar, locale: Locale(identifier: "zh_CN")
        )
        XCTAssertNotEqual(title, L10n.Common.today)
        XCTAssertNotEqual(title, L10n.Automation.tomorrow)
        XCTAssertTrue(title.contains("7") || title.contains("8"), "应带上月/日，实际: \(title)")
    }
}
