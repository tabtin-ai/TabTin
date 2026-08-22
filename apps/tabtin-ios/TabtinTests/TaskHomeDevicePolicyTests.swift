import XCTest
@testable import Tabtin

final class TaskHomeDevicePolicyTests: XCTestCase {
    func testItemsOnlyIncludeDevicesUsedByExecutionWorkspaces() {
        let items = TaskHomeDevicePolicy.items(
            workspaceDeviceIds: ["device-a", "device-a"],
            devices: [
                (id: "device-a", name: "Mac", isOffline: false),
                (id: "device-unused", name: "Unused", isOffline: true),
            ],
            fallbackName: "Unnamed"
        )

        XCTAssertEqual(items.map(\.id), ["device-a"])
    }

    func testOfflineDevicesSortAfterOnlineDevices() {
        let items = TaskHomeDevicePolicy.items(
            workspaceDeviceIds: ["offline", "online"],
            devices: [
                (id: "offline", name: "A", isOffline: true),
                (id: "online", name: "Z", isOffline: false),
            ],
            fallbackName: "Unnamed"
        )

        XCTAssertEqual(items.map(\.id), ["online", "offline"])
    }

    func testSingleOnlineDeviceDoesNotConsumeAStatusRow() {
        let online = TaskHomeDevicePolicy.DeviceItem(
            id: "online",
            fullName: "Mac",
            shortName: "Mac",
            isOffline: false
        )
        let offline = TaskHomeDevicePolicy.DeviceItem(
            id: "offline",
            fullName: "PC",
            shortName: "PC",
            isOffline: true
        )

        XCTAssertFalse(TaskHomeDevicePolicy.shouldShowRail(items: [online]))
        XCTAssertTrue(TaskHomeDevicePolicy.shouldShowRail(items: [offline]))
        XCTAssertTrue(TaskHomeDevicePolicy.shouldShowRail(items: [online, offline]))
    }
}
