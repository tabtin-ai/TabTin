import XCTest
@testable import Tabtin

final class IMMessageTimelineTests: XCTestCase {
    func testFailedRecallProducesUserVisibleFeedback() {
        XCTAssertEqual(imRecallFeedbackMessage(success: false), "消息撤回失败，请稍后重试")
        XCTAssertNil(imRecallFeedbackMessage(success: true))
    }

    private func localISO(year: Int, month: Int, day: Int, hour: Int, minute: Int) -> String {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        let date = Calendar.current.date(from: components)!
        return ISO8601DateFormatter().string(from: date)
    }

    private func message(
        id: Int,
        senderId: String = "user-a",
        senderType: String = "user",
        createdAt: String
    ) -> IMMessage {
        IMMessage(
            id: id,
            seq: id,
            conversationId: "conv-1",
            senderId: senderId,
            senderType: senderType,
            content: "hello",
            messageType: IMMessageType.text.rawValue,
            createdAt: createdAt
        )
    }

    func testIsSameCalendarDay() {
        XCTAssertTrue(IMMessageTimeline.isSameCalendarDay(
            localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0),
            localISO(year: 2026, month: 8, day: 1, hour: 22, minute: 0)
        ))
        XCTAssertFalse(IMMessageTimeline.isSameCalendarDay(
            localISO(year: 2026, month: 8, day: 1, hour: 23, minute: 0),
            localISO(year: 2026, month: 8, day: 2, hour: 1, minute: 0)
        ))
    }

    func testShouldShowDateDividerOnFirstMessage() {
        let current = message(id: 1, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        XCTAssertTrue(IMMessageTimeline.shouldShowDateDivider(for: current, previous: nil))
    }

    func testShouldShowDateDividerWhenCrossDay() {
        let previous = message(id: 1, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 23, minute: 50))
        let current = message(id: 2, createdAt: localISO(year: 2026, month: 8, day: 2, hour: 0, minute: 10))
        XCTAssertTrue(IMMessageTimeline.shouldShowDateDivider(for: current, previous: previous))
    }

    func testShouldNotShowDateDividerSameDay() {
        let previous = message(id: 1, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let current = message(id: 2, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 4))
        XCTAssertFalse(IMMessageTimeline.shouldShowDateDivider(for: current, previous: previous))
    }

    func testShouldShowTimestampGapAfterFiveMinutes() {
        let previous = message(id: 1, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let current = message(id: 2, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 6))
        XCTAssertTrue(IMMessageTimeline.shouldShowTimestampGap(current: current, previous: previous))
    }

    func testShouldNotShowTimestampGapWithinFiveMinutes() {
        let previous = message(id: 1, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let current = message(id: 2, createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 4))
        XCTAssertFalse(IMMessageTimeline.shouldShowTimestampGap(current: current, previous: previous))
    }

    func testIsGroupStartWhenSenderChanges() {
        let previous = message(id: 1, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let current = message(id: 2, senderId: "user-b", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 1))
        XCTAssertTrue(IMMessageTimeline.isGroupStart(current: current, previous: previous))
    }

    func testIsNotGroupStartForSameSenderWithinGap() {
        let previous = message(id: 1, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let current = message(id: 2, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 2))
        XCTAssertFalse(IMMessageTimeline.isGroupStart(current: current, previous: previous))
    }

    func testRecalledMessageBreaksVisualGroupForSameSender() {
        var previous = message(id: 1, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        previous.isDeleted = true
        let current = message(id: 2, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 1))

        XCTAssertTrue(IMMessageTimeline.isGroupStart(current: current, previous: previous))
        XCTAssertTrue(IMMessageTimeline.showsIncomingAvatar(for: current, previous: previous, currentUserId: "me"))
    }

    func testIncomingAvatarOnlyShowsAtMessageGroupStart() {
        let first = message(id: 1, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        let grouped = message(id: 2, senderId: "user-a", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 1))

        XCTAssertTrue(IMMessageTimeline.showsIncomingAvatar(for: first, previous: nil, currentUserId: "me"))
        XCTAssertFalse(IMMessageTimeline.showsIncomingAvatar(for: grouped, previous: first, currentUserId: "me"))
    }

    func testOutgoingMessageDoesNotShowAvatar() {
        let message = message(id: 1, senderId: "me", createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0))
        XCTAssertFalse(IMMessageTimeline.showsIncomingAvatar(for: message, previous: nil, currentUserId: "me"))
    }

    func testOnlyHumanSenderAvatarInGroupCanOpenDirectMessage() {
        let human = message(
            id: 1,
            senderId: "user-a",
            createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 0)
        )
        let agent = message(
            id: 2,
            senderId: "agent-a",
            senderType: "agent",
            createdAt: localISO(year: 2026, month: 8, day: 1, hour: 10, minute: 1)
        )

        XCTAssertTrue(IMMessageTimeline.canOpenSenderDirectMessage(
            for: human,
            isDirectMessage: false,
            currentUserId: "me"
        ))
        XCTAssertFalse(IMMessageTimeline.canOpenSenderDirectMessage(
            for: human,
            isDirectMessage: true,
            currentUserId: "me"
        ))
        XCTAssertFalse(IMMessageTimeline.canOpenSenderDirectMessage(
            for: agent,
            isDirectMessage: false,
            currentUserId: "me"
        ))
    }

    func testOnlyGroupAdminOrOwnerCanEditAvatar() {
        let members = [
            IMMember(userId: "member", role: 1),
            IMMember(userId: "admin", role: 2),
            IMMember(userId: "owner", role: 3),
            IMMember(memberType: IMMemberType.agent.rawValue, agentId: "agent", role: 3),
        ]
        let group = IMConversationDetail(
            id: "group-1",
            organizationId: "org-1",
            type: IMConversationType.group.rawValue,
            members: members
        )
        let directMessage = IMConversationDetail(
            id: "dm-1",
            organizationId: "org-1",
            type: IMConversationType.dm.rawValue,
            members: members
        )

        XCTAssertFalse(IMConversationAvatarPolicy.canEditGroupAvatar(group, currentUserId: "member"))
        XCTAssertTrue(IMConversationAvatarPolicy.canEditGroupAvatar(group, currentUserId: "admin"))
        XCTAssertTrue(IMConversationAvatarPolicy.canEditGroupAvatar(group, currentUserId: "owner"))
        XCTAssertFalse(IMConversationAvatarPolicy.canEditGroupAvatar(group, currentUserId: "agent"))
        XCTAssertFalse(IMConversationAvatarPolicy.canEditGroupAvatar(directMessage, currentUserId: "admin"))
    }

    func testRemoteAvatarDoesNotShowTextWhileImageIsLoading() {
        XCTAssertEqual(
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage: true,
                hasCachedImage: false,
                didFail: false
            ),
            .loading
        )
        XCTAssertEqual(
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage: true,
                hasCachedImage: true,
                didFail: false
            ),
            .image
        )
        XCTAssertEqual(
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage: true,
                hasCachedImage: false,
                didFail: true
            ),
            .fallback
        )
    }

    func testFormatDateDividerTodayAndYesterday() {
        let calendar = Calendar.current
        let now = Date()
        let todayISO = ISO8601DateFormatter().string(from: now)
        XCTAssertEqual(IMMessageTimeline.formatDateDivider(todayISO, now: now), L10n.Common.today)

        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: now) else {
            return XCTFail("missing yesterday")
        }
        let yesterdayISO = ISO8601DateFormatter().string(from: yesterday)
        XCTAssertEqual(IMMessageTimeline.formatDateDivider(yesterdayISO, now: now), L10n.Common.yesterday)
    }

    func testFormatMessageClock() {
        let raw = localISO(year: 2026, month: 8, day: 1, hour: 14, minute: 30)
        let clock = IMMessageTimeline.formatMessageClock(raw)
        XCTAssertFalse(clock.isEmpty)
        // 本地化时分模板，至少应包含小时与分钟数字。
        XCTAssertTrue(clock.contains("14") || clock.contains("2"))
        XCTAssertTrue(clock.contains("30"))
    }
}
