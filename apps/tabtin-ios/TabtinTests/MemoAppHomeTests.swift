import XCTest
@testable import Tabtin

final class MemoAppHomeTests: XCTestCase {

    func testVisibleViewKindsHideAgentDiaryWhenFlagOff() {
        XCTAssertFalse(MemoAppHomeFeatureFlags.isOrganizationAgentDiaryEnabled)
        XCTAssertEqual(MemoAppHomeViewKind.visibleCases, [.all, .today])
    }

    func testTimelineProjectsPinnedAndDayBuckets() {
        let calendar = Calendar(identifier: .gregorian)
        let comps = DateComponents(year: 2026, month: 7, day: 31, hour: 15)
        let now = calendar.date(from: comps)!
        let today = iso(calendar.date(byAdding: .hour, value: -1, to: now)!)
        let yesterday = iso(calendar.date(byAdding: .day, value: -1, to: now)!)
        let week = iso(calendar.date(byAdding: .day, value: -3, to: now)!)
        let older = iso(calendar.date(byAdding: .day, value: -20, to: now)!)

        let memos = [
            memo(id: "p", pinned: true, createdAt: older),
            memo(id: "t", createdAt: today),
            memo(id: "y", createdAt: yesterday),
            memo(id: "w", createdAt: week),
            memo(id: "o", createdAt: older),
        ]

        let sections = MemoTimelineProjector.project(
            memos: memos,
            now: now,
            calendar: calendar,
            titles: .english
        )

        XCTAssertEqual(sections.map(\.kind), [.pinned, .today, .yesterday, .thisWeek, .older])
        XCTAssertEqual(sections[0].items.map(\.id), ["p"])
        XCTAssertEqual(sections[1].items.map(\.id), ["t"])
        XCTAssertEqual(sections[2].items.map(\.id), ["y"])
        XCTAssertEqual(sections[3].items.map(\.id), ["w"])
        XCTAssertEqual(sections[4].items.map(\.id), ["o"])
    }

    func testLocalDayBoundsAreHalfOpen() {
        let calendar = Calendar(identifier: .gregorian)
        let day = calendar.date(from: DateComponents(year: 2026, month: 7, day: 31, hour: 18))!
        let bounds = MemoTimelineProjector.localDayBounds(for: day, calendar: calendar)
        XCTAssertEqual(calendar.component(.hour, from: bounds.after), 0)
        XCTAssertEqual(calendar.component(.day, from: bounds.after), 31)
        XCTAssertEqual(calendar.component(.day, from: bounds.before), 1)
        XCTAssertEqual(calendar.component(.month, from: bounds.before), 8)
        XCTAssertEqual(bounds.before.timeIntervalSince(bounds.after), 86_400, accuracy: 0.001)
    }

    func testMonthCountSumsCurrentMonthBucketsOnly() {
        let calendar = Calendar(identifier: .gregorian)
        let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 15))!
        let buckets = [
            MemoHeatmapBucket(date: "2026-07-01", count: 2),
            MemoHeatmapBucket(date: "2026-07-31", count: 5),
            MemoHeatmapBucket(date: "2026-06-30", count: 9),
            MemoHeatmapBucket(date: "2026-08-01", count: 4),
        ]
        XCTAssertEqual(MemoTimelineProjector.monthCount(from: buckets, now: now, calendar: calendar), 7)
    }

    func testDecodeHeatmapAndDiaryFeedContracts() throws {
        let heatmapJSON = """
        {"buckets":[{"date":"2026-07-31","count":3}],"total":3,"days":84}
        """.data(using: .utf8)!
        let heatmap = try JSONDecoder().decode(MemoHeatmapResponse.self, from: heatmapJSON)
        XCTAssertEqual(heatmap.buckets.first?.date, "2026-07-31")
        XCTAssertEqual(heatmap.total, 3)

        let diaryJSON = """
        {"items":[{"id":"d1","agent_id":"a1","agent_name":"Ada","memory_type":"diary","content":"hi","tags":[],"created_at":"2026-07-31T01:00:00Z","updated_at":"2026-07-31T01:00:00Z"}],"next_cursor":"c1","has_more":true}
        """.data(using: .utf8)!
        let diary = try JSONDecoder().decode(AgentDiaryFeedResponse.self, from: diaryJSON)
        XCTAssertEqual(diary.items.count, 1)
        XCTAssertEqual(diary.nextCursor, "c1")
        XCTAssertTrue(diary.hasMore)
    }

    func testDecodeMemoSummaryIncludesColorAndPin() throws {
        let json = """
        {"id":"m1","content_plaintext":"hello","tags":["x"],"ai_tags":["y"],"color":"pink","is_pinned":true,"created_at":"2026-07-31T10:00:00.000Z","updated_at":"2026-07-31T11:00:00.000Z"}
        """.data(using: .utf8)!
        let memo = try JSONDecoder().decode(CloudMemoSummary.self, from: json)
        XCTAssertEqual(memo.memoColor, .pink)
        XCTAssertTrue(memo.isPinned)
        XCTAssertEqual(memo.allTags, ["x", "y"])
    }

    func testRequestGateDropsStaleGeneration() async {
        let gate = MemoListRequestGate()
        let stale = await gate.begin()
        let current = await gate.begin()
        let staleStillCurrent = await gate.isCurrent(stale)
        let currentStillCurrent = await gate.isCurrent(current)
        XCTAssertFalse(staleStillCurrent)
        XCTAssertTrue(currentStillCurrent)
    }

    @MainActor
    func testRemoveMemoAndApplyPinnedWriteBack() {
        let vm = MemoAppHomeViewModel(organizationId: "org-1")
        vm.replaceMemosForTesting([
            memo(id: "a", pinned: false, createdAt: "2026-07-31T10:00:00.000Z"),
            memo(id: "b", pinned: false, createdAt: "2026-07-31T09:00:00.000Z"),
        ])
        vm.applyPinned(id: "b", pinned: true)
        XCTAssertEqual(vm.memos.first(where: { $0.id == "b" })?.isPinned, true)
        vm.removeMemo(id: "a")
        XCTAssertEqual(vm.memos.map(\.id), ["b"])
    }

    @MainActor
    func testDraftAttachmentSelectionKeepsPhaseWithoutUploading() {
        let vm = MemoAppHomeViewModel(organizationId: "org-1")
        vm.attachDraftFile(data: Data("hi".utf8), fileName: "note.txt", contentType: "text/plain")
        XCTAssertEqual(vm.draftAttachmentName, "note.txt")
        XCTAssertEqual(vm.attachmentPhase, .selected)
        vm.clearDraftAttachment()
        XCTAssertNil(vm.draftAttachmentName)
        XCTAssertEqual(vm.attachmentPhase, .idle)
    }

    func testSaveBusyRecognizedFromResponseErrorPayloadNotBare409() {
        let busyData = Data(
            #"{"success":false,"code":"SAVE_BUSY","message":"这条笔记正在保存，请稍后重试"}"#.utf8
        )
        let busy = APIClient.responseError(statusCode: 409, data: busyData)
        XCTAssertTrue(MemoAppHomeViewModel.isSaveBusyForTesting(busy))
        XCTAssertEqual(MemoAppHomeViewModel.userMessageForTesting(busy), L10n.MemoAppHome.saveBusy)

        let coded = APIError.apiErrorWithCode(code: "SAVE_BUSY", message: "busy")
        XCTAssertTrue(MemoAppHomeViewModel.isSaveBusyForTesting(coded))

        let other409 = APIClient.responseError(
            statusCode: 409,
            data: Data(#"{"success":false,"code":"PUBLIC_EXPOSURE_ACK_REQUIRED","message":"ack"}"#.utf8)
        )
        XCTAssertFalse(MemoAppHomeViewModel.isSaveBusyForTesting(other409))

        let bare409 = APIError.serverError(409, "conflict")
        XCTAssertFalse(MemoAppHomeViewModel.isSaveBusyForTesting(bare409))
    }

    // MARK: - Helpers

    private func memo(id: String, pinned: Bool = false, createdAt: String) -> CloudMemoSummary {
        CloudMemoSummary(
            id: id,
            contentPlaintext: id,
            isPinned: pinned,
            createdAt: createdAt,
            updatedAt: createdAt
        )
    }

    private func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}
