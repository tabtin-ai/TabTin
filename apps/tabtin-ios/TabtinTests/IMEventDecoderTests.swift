import XCTest
@testable import Tabtin

/// 校验 Centrifugo publication 信封 → 类型化事件的解码（Phase E 新增：编辑/撤回/表情/已读）。
final class IMEventDecoderTests: XCTestCase {
    func testDecodesAgentMessageProjectionEvents() {
        let stream = IMEventDecoder.decode(Data("""
        {"type":"im.agent.message.stream","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"你","stream_seq":2,"created_at":"2026-08-22T10:00:00Z"}}
        """.utf8))
        guard case let .agentMessageStream(payload) = stream else {
            return XCTFail("应为 agentMessageStream")
        }
        XCTAssertEqual(payload.messageRef, "job-1")
        XCTAssertEqual(payload.delta, "你")
        XCTAssertEqual(payload.streamSeq, 2)

        let final = IMEventDecoder.decode(Data("""
        {"type":"im.agent.message.final","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","content":"完整回答","message_type":1,"metadata":{"kind":"tabtin_ref"},"created_at":"2026-08-22T10:00:01Z"}}
        """.utf8))
        guard case let .agentMessageFinal(payload) = final else {
            return XCTFail("应为 agentMessageFinal")
        }
        XCTAssertEqual(payload.content, "完整回答")
        XCTAssertEqual(payload.metadata?.kind, "tabtin_ref")

        let error = IMEventDecoder.decode(Data("""
        {"type":"im.agent.message.error","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":""}}
        """.utf8))
        guard case let .agentMessageError(payload) = error else {
            return XCTFail("应为 agentMessageError")
        }
        XCTAssertEqual(payload.agentSessionRef, "session-1")
    }

    func testDecodesPersonalAgentFeedbackEvents() {
        XCTAssertEqual(
            IMEventDecoder.decode(Data("""
            {"type":"im.ai.error","data":{"agent_name":"研究员","reason":"请重新指定执行现场"}}
            """.utf8)),
            .aiError(agentName: "研究员", reason: "请重新指定执行现场")
        )
        XCTAssertEqual(
            IMEventDecoder.decode(Data("""
            {"type":"im.ai.suggest_task","data":{"conversation_id":"c1","message_id":9,"agent_name":"研究员"}}
            """.utf8)),
            .aiSuggestTask(conversationId: "c1", messageId: 9, agentName: "研究员")
        )
    }

    func testDecodesUserProfileUpdated() {
        let event = IMEventDecoder.decode(Data("""
        {"type":"im.user.profile.updated","data":{"id":"user-2","nickname":"新昵称","username":"alice","avatar":"https://cdn.example/avatar.png","avatar_version":"7","revision":7}}
        """.utf8))

        guard case let .userProfileUpdated(profile) = event else {
            return XCTFail("应为 userProfileUpdated")
        }
        XCTAssertEqual(profile.userId, "user-2")
        XCTAssertEqual(profile.displayName, "新昵称")
        XCTAssertEqual(profile.avatar, "https://cdn.example/avatar.png")
        XCTAssertEqual(profile.revision, 7)
    }

    private func decode(_ json: String) -> IMRealtimeEvent? {
        IMEventDecoder.decode(Data(json.utf8))
    }

    func testMessageEditedDecodesFullMessage() {
        let event = decode("""
        {
          "type": "im.message.edited", "event_id": "e1",
          "data": {
            "id": 9, "seq": 9, "conversation_id": "c1", "sender_id": "u2",
            "sender_type": "user", "sender_name": "张三", "content": "改后的内容",
            "message_type": 1, "edited_at": "2026-07-20T10:00:00Z", "metadata": {}
          }
        }
        """)
        guard case let .messageEdited(msg) = event else { return XCTFail("应为 messageEdited") }
        XCTAssertEqual(msg.id, 9)
        XCTAssertEqual(msg.content, "改后的内容")
        XCTAssertTrue(msg.isEdited)
    }

    func testMessageDeletedDecodes() {
        let event = decode("""
        {"type": "im.message.deleted", "event_id": "e2",
         "data": {"message_id": 42, "conversation_id": "c1", "sender_id": "u2"}}
        """)
        guard case let .messageDeleted(messageId) = event else { return XCTFail("应为 messageDeleted") }
        XCTAssertEqual(messageId, 42)
    }

    func testPinnedAndUnpinnedMessagesDecode() {
        let pinned = decode("""
        {"type":"im.message.pinned","data":{"id":12,"seq":12,
         "conversation_id":"c1","sender_id":"u1","content":"重点",
         "message_type":1,"is_pinned":true,"metadata":{}}}
        """)
        guard case let .messagePinned(message) = pinned else { return XCTFail("应为 messagePinned") }
        XCTAssertEqual(message.id, 12)
        XCTAssertTrue(message.isPinned)

        let unpinned = decode("""
        {"type":"im.message.unpinned","data":{"message_id":12,"conversation_id":"c1"}}
        """)
        guard case let .messageUnpinned(messageId) = unpinned else { return XCTFail("应为 messageUnpinned") }
        XCTAssertEqual(messageId, 12)
    }

    func testReactionAddedDecodes() {
        let event = decode("""
        {"type": "im.reaction.added", "event_id": "e3",
         "data": {"message_id": 7, "conversation_id": "c1", "user_id": "u5", "emoji": "👍"}}
        """)
        guard case let .reaction(messageId, userId, emoji, added) = event else { return XCTFail("应为 reaction") }
        XCTAssertEqual(messageId, 7)
        XCTAssertEqual(userId, "u5")
        XCTAssertEqual(emoji, "👍")
        XCTAssertTrue(added)
    }

    func testReactionRemovedDecodesAsNotAdded() {
        let event = decode("""
        {"type": "im.reaction.removed", "event_id": "e4",
         "data": {"message_id": 7, "conversation_id": "c1", "user_id": "u5", "emoji": "❤️"}}
        """)
        guard case let .reaction(_, _, emoji, added) = event else { return XCTFail("应为 reaction") }
        XCTAssertEqual(emoji, "❤️")
        XCTAssertFalse(added)
    }

    func testReadReceiptDecodes() {
        let event = decode("""
        {"type": "im.read.receipt", "event_id": "e5",
         "data": {"conversation_id": "c1", "user_id": "u2",
                  "last_read_message_id": 30, "last_read_seq": 30, "previous_last_read_seq": 10}}
        """)
        guard case let .readReceipt(receipt) = event else { return XCTFail("应为 readReceipt") }
        XCTAssertEqual(receipt.userId, "u2")
        XCTAssertEqual(receipt.lastReadSeq, 30)
        XCTAssertEqual(receipt.lastReadMessageId, 30)
    }

    func testTypingDecodesTopLevelUserId() {
        // typing 由客户端 publish，字段平铺在顶层（无 data 层）。
        let event = decode("""
        {"type": "im.typing", "user_id": "u2"}
        """)
        guard case let .typing(userId) = event else { return XCTFail("应为 typing") }
        XCTAssertEqual(userId, "u2")
    }

    func testHandoffUpdateDecodesPackageId() {
        let event = decode("""
        {"type": "im.handoff.update", "event_id": "handoff-event-1",
         "data": {"handoff_id": "handoff-1", "version": 3}}
        """)
        guard case let .handoffUpdate(handoffId) = event else { return XCTFail("应为 handoffUpdate") }
        XCTAssertEqual(handoffId, "handoff-1")
    }

    func testConversationAndSessionShareUpdatesDecode() {
        guard case .conversationChanged = decode("""
        {"type":"im.member.joined","data":{"conversation_id":"c1","member_count":3}}
        """) else { return XCTFail("成员变化应触发会话刷新") }

        let share = decode("""
        {"type":"im.session_share.update","data":{"conversation_id":"c1","share_id":"share-1"}}
        """)
        guard case let .sessionShareUpdate(shareId) = share else { return XCTFail("应为 sessionShareUpdate") }
        XCTAssertEqual(shareId, "share-1")
    }

    func testUnknownTypePreservesName() {
        let event = decode("""
        {"type": "im.something.new", "data": {}}
        """)
        guard case let .unknown(type) = event else { return XCTFail("应为 unknown") }
        XCTAssertEqual(type, "im.something.new")
    }
}
