import XCTest
@testable import Tabtin

final class MobileEnvironmentQRCodeTests: XCTestCase {
    func testParsesVersionedDesktopPayload() throws {
        let payload = "tabtin://mobile-environment?v=1&api=https%3A%2F%2Fapi.example.com%2Fapi&ws=wss%3A%2F%2Fapi.example.com%2Fws%2Fv1%2Fgateway&web=https%3A%2F%2Fapp.example.com&centrifugo=wss%3A%2F%2Fapi.example.com%2Fconnection%2Fwebsocket"

        XCTAssertEqual(
            try MobileEnvironmentQRCode.parse(payload),
            MobileEnvironmentConfiguration(
                apiURL: "https://api.example.com/api",
                websocketURL: "wss://api.example.com/ws/v1/gateway",
                webURL: "https://app.example.com",
                centrifugoURL: "wss://api.example.com/connection/websocket"
            )
        )
    }

    func testRejectsUnsupportedVersion() {
        let payload = "tabtin://mobile-environment?v=2&api=https://api.example.com/api&ws=wss://api.example.com/ws&web=https://app.example.com&centrifugo=wss://api.example.com/connection/websocket"
        XCTAssertThrowsError(try MobileEnvironmentQRCode.parse(payload))
    }

    func testRejectsMissingEndpoint() {
        let payload = "tabtin://mobile-environment?v=1&api=https://api.example.com/api&ws=wss://api.example.com/ws&web=https://app.example.com"
        XCTAssertThrowsError(try MobileEnvironmentQRCode.parse(payload))
    }
}
