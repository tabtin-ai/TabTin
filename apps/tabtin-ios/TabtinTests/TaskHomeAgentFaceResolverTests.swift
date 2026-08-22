import XCTest
@testable import Tabtin

final class TaskHomeAgentFaceResolverTests: XCTestCase {
    func testStoreAvatarKeyWinsOverStaleSessionAvatar() {
        let raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: "agent-new",
            sessionAvatar: "code-engineer",
            storeAvatarURL: nil,
            storeAvatarKey: "web-researcher"
        )
        XCTAssertEqual(raw, "web-researcher")
    }

    func testStoreAvatarURLWinsOverKeyAndSession() {
        let raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: "agent-new",
            sessionAvatar: "code-engineer",
            storeAvatarURL: "https://cdn.example.test/a.png",
            storeAvatarKey: "web-researcher"
        )
        XCTAssertEqual(raw, "https://cdn.example.test/a.png")
    }

    func testFallsBackToSessionWhenStoreMissing() {
        let raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: "agent-new",
            sessionAvatar: "doc-writer",
            storeAvatarURL: nil,
            storeAvatarKey: nil
        )
        XCTAssertEqual(raw, "doc-writer")
    }

    func testAgentIdentityWithoutAnyAvatarUsesGeneralAssistant() {
        let raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: "agent-new",
            sessionAvatar: nil,
            storeAvatarURL: nil,
            storeAvatarKey: nil
        )
        XCTAssertEqual(raw, AgentAvatarPreset.generalAssistant.rawValue)
    }

    func testNoAgentIdentityReturnsNil() {
        let raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId: nil,
            sessionAvatar: nil,
            storeAvatarURL: nil,
            storeAvatarKey: nil
        )
        XCTAssertNil(raw)
    }

    func testDisplayNamePrefersStore() {
        let name = TaskHomeAgentFaceResolver.resolveDisplayName(
            agentId: "agent-new",
            sessionAgentName: "旧名",
            storeDisplayName: "冲浪版",
            locationName: "Workspace"
        )
        XCTAssertEqual(name, "冲浪版")
    }
}
