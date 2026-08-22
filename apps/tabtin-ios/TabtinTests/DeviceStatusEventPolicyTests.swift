import XCTest
@testable import Tabtin

/// `device.status` 实时事件落地：解析、范围过滤、幂等。
final class DeviceStatusEventPolicyTests: XCTestCase {

    private func envelope(
        type: String = "device.status",
        payload: [String: Any]
    ) -> WSEnvelope {
        WSEnvelope(
            v: 1,
            type: type,
            requestId: "req-1",
            ts: 0,
            deviceId: "sender",
            role: "user",
            payload: payload.mapValues { AnyCodable($0) }
        )
    }

    private func device(
        id: String,
        name: String? = "进宝的Mac",
        status: String? = "online"
    ) -> RuntimeDevice {
        RuntimeDevice(
            id: id,
            name: name,
            deviceType: "desktop",
            status: status,
            lastHeartbeatAt: "2026-08-02T10:00:00Z"
        )
    }

    // MARK: - 解析

    func testParsesDeviceStatusEvent() {
        let update = DeviceStatusEventPolicy.update(from: envelope(payload: [
            "device_id": "mac", "status": "offline", "name": "进宝的Mac",
        ]))
        XCTAssertEqual(update, DeviceStatusEventPolicy.Update(
            deviceId: "mac", status: "offline", name: "进宝的Mac"
        ))
    }

    func testIgnoresOtherEventTypes() {
        XCTAssertNil(DeviceStatusEventPolicy.update(from: envelope(
            type: "agent.stream.message_delta",
            payload: ["device_id": "mac", "status": "offline"]
        )))
    }

    func testIgnoresEventsMissingRequiredFields() {
        XCTAssertNil(DeviceStatusEventPolicy.update(from: envelope(payload: ["status": "offline"])))
        XCTAssertNil(DeviceStatusEventPolicy.update(from: envelope(payload: ["device_id": "mac"])))
        XCTAssertNil(DeviceStatusEventPolicy.update(from: envelope(payload: [
            "device_id": "  ", "status": "offline",
        ])))
    }

    func testStatusIsCaseInsensitive() {
        let update = DeviceStatusEventPolicy.update(from: envelope(payload: [
            "device_id": "mac", "status": "OFFLINE",
        ]))
        XCTAssertEqual(update?.status, "offline")
    }

    // MARK: - 应用

    func testAppliesStatusToKnownDevice() {
        var devices = ["mac": device(id: "mac", status: "online")]
        let changed = DeviceStatusEventPolicy.apply(
            .init(deviceId: "mac", status: "offline", name: nil),
            to: &devices
        )
        XCTAssertTrue(changed)
        XCTAssertEqual(devices["mac"]?.status, "offline")
        XCTAssertFalse(devices["mac"]!.isAvailableForExecution)
    }

    /// 只更新已知设备：devicesById 已是当前组织范围，事件里的陌生设备一律忽略——
    /// 这天然挡掉跨组织串扰，不需要再比对 organization_id。
    func testIgnoresUnknownDevice() {
        var devices = ["mac": device(id: "mac")]
        let changed = DeviceStatusEventPolicy.apply(
            .init(deviceId: "other-org-device", status: "offline", name: nil),
            to: &devices
        )
        XCTAssertFalse(changed)
        XCTAssertEqual(devices["mac"]?.status, "online")
        XCTAssertNil(devices["other-org-device"])
    }

    /// 状态没变就不写回，避免无谓的 @Observable 失效风暴。
    func testNoOpWhenNothingChanged() {
        var devices = ["mac": device(id: "mac", status: "online")]
        XCTAssertFalse(DeviceStatusEventPolicy.apply(
            .init(deviceId: "mac", status: "online", name: "进宝的Mac"),
            to: &devices
        ))
    }

    func testRenameArrivesWithStatusEvent() {
        var devices = ["mac": device(id: "mac", name: "旧名字", status: "online")]
        let changed = DeviceStatusEventPolicy.apply(
            .init(deviceId: "mac", status: "online", name: "新名字"),
            to: &devices
        )
        XCTAssertTrue(changed)
        XCTAssertEqual(devices["mac"]?.name, "新名字")
    }

    /// busy 仍算可执行，别把「在忙」画成「离线」。
    func testBusyStaysAvailableForExecution() {
        var devices = ["mac": device(id: "mac", status: "online")]
        _ = DeviceStatusEventPolicy.apply(
            .init(deviceId: "mac", status: "busy", name: nil),
            to: &devices
        )
        XCTAssertTrue(devices["mac"]!.isAvailableForExecution)
    }

    /// 心跳时间不在事件里，不能拿事件到达时间冒充。
    func testHeartbeatTimestampIsPreserved() {
        var devices = ["mac": device(id: "mac", status: "online")]
        _ = DeviceStatusEventPolicy.apply(
            .init(deviceId: "mac", status: "offline", name: nil),
            to: &devices
        )
        XCTAssertEqual(devices["mac"]?.lastHeartbeatAt, "2026-08-02T10:00:00Z")
    }
}
