import XCTest
@testable import Tabtin

/// 任务列表分段：语义段永远压时间段，时间桶与排序依据同源。
final class TaskHomeSessionGroupingTests: XCTestCase {
    private let calendar = Calendar(identifier: .gregorian)
    /// 钉在本地时间正午：用小时级偏移造「今天」的样本时不会跨过午夜。
    private lazy var now: Date = calendar.date(
        from: DateComponents(year: 2026, month: 2, day: 2, hour: 12)
    )!

    private func session(id: String, hoursAgo: Double? = nil, raw: String? = nil) -> RecentSession {
        let stamp: String?
        if let raw {
            stamp = raw
        } else if let hoursAgo {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            stamp = formatter.string(from: now.addingTimeInterval(-hoursAgo * 3_600))
        } else {
            stamp = nil
        }
        return RecentSession(id: id, lastMessageAt: stamp)
    }

    func testSemanticBandsComeBeforeTimeBands() {
        let groups = TaskHomeSessionGrouping.groups(
            pinned: [session(id: "p", hoursAgo: 20 * 24)],
            needsYou: [session(id: "n", hoursAgo: 20 * 24)],
            rest: [session(id: "r", hoursAgo: 1)],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(groups.map(\.band), [.pinned, .needsYou, .today])
    }

    func testEmptyBandsAreDropped() {
        let groups = TaskHomeSessionGrouping.groups(
            pinned: [],
            needsYou: [],
            rest: [session(id: "r", hoursAgo: 1)],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(groups.map(\.band), [.today])
    }

    func testRestFallsIntoTimeBucketsInFixedOrder() {
        let groups = TaskHomeSessionGrouping.groups(
            pinned: [],
            needsYou: [],
            rest: [
                session(id: "earlier", hoursAgo: 90 * 24),
                session(id: "today", hoursAgo: 1),
                session(id: "month", hoursAgo: 20 * 24),
                session(id: "yesterday", hoursAgo: 24),
                session(id: "week", hoursAgo: 4 * 24),
            ],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(groups.map(\.band), [.today, .yesterday, .last7Days, .last30Days, .earlier])
        XCTAssertEqual(groups.map { $0.sessions.map(\.id) }, [
            ["today"], ["yesterday"], ["week"], ["month"], ["earlier"],
        ])
    }

    /// 同一桶内保持调用方传入的活跃倒序，分段不重排。
    func testOrderInsideBandIsPreserved() {
        let groups = TaskHomeSessionGrouping.groups(
            pinned: [],
            needsYou: [],
            rest: [
                session(id: "a", hoursAgo: 1),
                session(id: "b", hoursAgo: 2),
                session(id: "c", hoursAgo: 3),
            ],
            now: now,
            calendar: calendar
        )
        XCTAssertEqual(groups.first?.sessions.map(\.id), ["a", "b", "c"])
    }

    /// 解析不出时间的会话宁可沉底，也不能伪装成「今天」污染最新一屏。
    func testUnparsableTimestampSinksToEarlier() {
        XCTAssertEqual(
            TaskHomeSessionGrouping.timeBand(
                for: session(id: "bad", raw: "not-a-date"),
                now: now,
                calendar: calendar
            ),
            .earlier
        )
        XCTAssertEqual(
            TaskHomeSessionGrouping.timeBand(for: session(id: "none"), now: now, calendar: calendar),
            .earlier
        )
    }

    /// 带毫秒与不带毫秒的 ISO-8601 都要认，后端两种都发过。
    func testActivityDateAcceptsBothISOForms() {
        XCTAssertNotNil(TaskHomeSessionGrouping.activityDate(
            for: session(id: "frac", raw: "2026-02-01T10:00:00.123Z")
        ))
        XCTAssertNotNil(TaskHomeSessionGrouping.activityDate(
            for: session(id: "plain", raw: "2026-02-01T10:00:00Z")
        ))
    }

    /// 分段依据必须和 `RecentSessionActivityPolicy.sortKey` 同源，否则会出现
    /// 「排在今天段里、时间显示三天前」的错位。
    func testActivityDateFollowsSortKeyPrecedence() {
        let session = RecentSession(
            id: "s",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-15T00:00:00Z",
            lastMessageAt: "2026-02-01T00:00:00Z"
        )
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        XCTAssertEqual(
            TaskHomeSessionGrouping.activityDate(for: session),
            formatter.date(from: "2026-02-01T00:00:00Z")
        )
    }
}
