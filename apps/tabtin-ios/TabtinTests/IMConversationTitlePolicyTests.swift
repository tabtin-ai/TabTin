import XCTest
@testable import Tabtin

final class IMConversationTitlePolicyTests: XCTestCase {
    func testDirectMessagePrefersPeerNameOverProviderFallback() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "TabTin private conversation",
                isDirectMessage: true,
                peerDisplayName: "沈庚涛"
            ),
            "沈庚涛"
        )
    }

    func testDirectMessageDoesNotExposeProviderFallbackWithoutPeer() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "TabTin private conversation",
                isDirectMessage: true,
                peerDisplayName: nil
            ),
            "私信"
        )
    }

    func testDirectMessageDoesNotExposeUUIDWithoutPeer() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "1325c2ff-175e-4751-8f0c-cac5a6676384",
                isDirectMessage: true,
                peerDisplayName: nil
            ),
            "私信"
        )
    }

    func testDirectMessageDoesNotExposeUUIDPeerName() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "1325c2ff-175e-4751-8f0c-cac5a6676384",
                isDirectMessage: true,
                peerDisplayName: "1325c2ff-175e-4751-8f0c-cac5a6676384"
            ),
            "私信"
        )
    }

    func testDirectMessagePrefersReadablePeerOverUUIDConversationName() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "1325c2ff-175e-4751-8f0c-cac5a6676384",
                isDirectMessage: true,
                peerDisplayName: "沈庚涛"
            ),
            "沈庚涛"
        )
    }

    func testGroupKeepsItsConversationName() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "项目群",
                isDirectMessage: false,
                peerDisplayName: nil
            ),
            "项目群"
        )
    }

    func testGroupKeepsUUIDConversationName() {
        XCTAssertEqual(
            IMConversationTitlePolicy.resolve(
                conversationName: "1325c2ff-175e-4751-8f0c-cac5a6676384",
                isDirectMessage: false,
                peerDisplayName: nil
            ),
            "1325c2ff-175e-4751-8f0c-cac5a6676384"
        )
    }
}
