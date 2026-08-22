import XCTest
@testable import Tabtin

final class PushNotificationVisibilityTests: XCTestCase {
    private let shellXML = """
    A background command completed while you were doing other work:

    <task-notification>
    <command>sleep 7</command>
    <description>等待一会儿</description>
    <exit-code>0</exit-code>
    <exited-by>normal_exit</exited-by>
    <duration-ms>1000</duration-ms>
    </task-notification>
    """

    private let subagentXML = """
    A background sub-agent finished while you were doing other work:

    <task-notification kind="subagent-completed">
    <label>抓取竞品价格</label>
    <status>completed</status>
    <summary>已完成</summary>
    </task-notification>
    """

    private func decode(_ json: String) throws -> MessageHistoryResponse {
        try JSONDecoder().decode(MessageHistoryResponse.self, from: Data(json.utf8))
    }

    func testTriggeredByMarksPushNotification() {
        XCTAssertTrue(PushNotificationVisibility.isPushNotification(
            triggeredBy: "push-notification",
            text: "hello"
        ))
        XCTAssertFalse(PushNotificationVisibility.isPushNotification(
            triggeredBy: "user",
            text: "hello"
        ))
    }

    func testContentFallbackWithoutTriggeredBy() {
        XCTAssertTrue(PushNotificationVisibility.isPushNotification(
            triggeredBy: nil,
            text: shellXML
        ))
    }

    func testShellSummaryAndKeepOnTimeline() {
        XCTAssertFalse(PushNotificationVisibility.shouldHideFromTimeline(
            triggeredBy: "push-notification",
            text: shellXML
        ))
        XCTAssertEqual(
            PushNotificationVisibility.displaySummary(triggeredBy: "push-notification", text: shellXML),
            "后台命令完成：等待一会儿"
        )
    }

    func testSubagentOnlyHiddenFromTimeline() {
        XCTAssertTrue(PushNotificationVisibility.shouldHideFromTimeline(
            triggeredBy: "push-notification",
            text: subagentXML
        ))
    }

    func testChatMessageFlags() {
        let push = ChatMessage(
            id: "p1",
            role: .system,
            text: shellXML,
            triggeredBy: "push-notification"
        )
        XCTAssertTrue(push.isPushNotification)
        XCTAssertFalse(push.shouldHidePushNotification)

        let subagent = ChatMessage(
            id: "p2",
            role: .system,
            text: subagentXML,
            triggeredBy: "push-notification"
        )
        XCTAssertTrue(subagent.isPushNotification)
        XCTAssertTrue(subagent.shouldHidePushNotification)
    }

    func testHistoryKeepsShellPushAndDropsSubagentOnly() throws {
        let shellEscaped = shellXML
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        let subEscaped = subagentXML
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        let resp = try decode("""
        {"messages":[
          {"id":"shell","role":"system","content":"\(shellEscaped)",
           "metadata":{"triggered_by":"push-notification"}},
          {"id":"sub","role":"system","content":"\(subEscaped)",
           "metadata":{"triggered_by":"push-notification"}},
          {"id":"assistant","role":"assistant","content":"ok"}
        ]}
        """)
        let mapped = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(mapped.map(\.id), ["shell", "assistant"])
        XCTAssertTrue(mapped[0].isPushNotification)
        XCTAssertEqual(mapped[0].triggeredBy, "push-notification")
    }
}
