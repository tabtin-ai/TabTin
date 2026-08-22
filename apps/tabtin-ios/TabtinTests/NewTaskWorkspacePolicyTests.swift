import XCTest
@testable import Tabtin

final class NewTaskWorkspacePolicyTests: XCTestCase {
    private func workspace(
        id: String,
        isDefault: Bool? = nil
    ) throws -> Space {
        var payload: [String: Any] = [
            "id": id,
            "organization_id": "org-1",
            "type": "workspace",
            "name": id,
            "status": "active",
        ]
        if let isDefault { payload["is_default"] = isDefault }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(Space.self, from: data)
    }

    func testSelectedWorkspaceWinsOverRecentAndDefault() throws {
        let selected = try workspace(id: "selected")
        let recent = try workspace(id: "recent")
        let fallback = try workspace(id: "default", isDefault: true)

        XCTAssertEqual(
            NewTaskWorkspacePolicy.resolve(
                workspaces: [recent, fallback, selected],
                selectedWorkspaceId: "selected",
                recentWorkspaceId: "recent"
            )?.id,
            "selected"
        )
    }

    func testRecentThenDefaultThenFirstAreUsedAsStableFallbacks() throws {
        let first = try workspace(id: "first")
        let recent = try workspace(id: "recent")
        let fallback = try workspace(id: "default", isDefault: true)

        XCTAssertEqual(
            NewTaskWorkspacePolicy.resolve(
                workspaces: [first, fallback, recent],
                selectedWorkspaceId: nil,
                recentWorkspaceId: "recent"
            )?.id,
            "recent"
        )
        XCTAssertEqual(
            NewTaskWorkspacePolicy.resolve(
                workspaces: [first, fallback],
                selectedWorkspaceId: nil,
                recentWorkspaceId: nil
            )?.id,
            "default"
        )
        XCTAssertEqual(
            NewTaskWorkspacePolicy.resolve(
                workspaces: [first],
                selectedWorkspaceId: nil,
                recentWorkspaceId: nil
            )?.id,
            "first"
        )
    }

    func testNoExecutionWorkspaceDoesNotProduceATarget() {
        XCTAssertNil(
            NewTaskWorkspacePolicy.resolve(
                workspaces: [],
                selectedWorkspaceId: nil,
                recentWorkspaceId: nil
            )
        )
    }
}
