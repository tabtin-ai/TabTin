import Foundation
import XCTest
@testable import Tabtin

final class DiagnosticRecorderTests: XCTestCase {
    func testTargetDropsQueryAndTemplatesIdentifiers() throws {
        let url = try XCTUnwrap(URL(
            string: "https://api.example.com/api/docs/550e8400-e29b-41d4-a716-446655440000?token=secret&prompt=hello"
        ))
        let target = DiagnosticTarget(url: url)

        XCTAssertEqual(target.hostClass, "tabtin-api")
        XCTAssertEqual(target.pathTemplate, "/api/docs/:id")
        XCTAssertFalse(target.pathTemplate.contains("secret"))
        XCTAssertFalse(target.pathTemplate.contains("prompt"))

        let objectStorage = DiagnosticTarget(url: URL(
            string: "https://bucket.oss-cn-shanghai.aliyuncs.com/private/customer-contract.pdf?signature=secret"
        ))
        XCTAssertEqual(objectStorage.hostClass, "object-storage")
        XCTAssertEqual(objectStorage.pathTemplate, "/:object")
    }

    func testDiagnosticsCapabilityIsVisibleBesideDebugEntry() {
        let capabilities = SettingsHomeCapabilityResolver.visibleCapabilities()
        let destinations = capabilities.compactMap(\.destination)

        let diagnostics = destinations.firstIndex(of: .settingsDeviceDiagnostics)
        let debug = destinations.firstIndex(of: .settingsDeviceDebugEnvironment)
        XCTAssertNotNil(diagnostics)
        XCTAssertNotNil(debug)
        XCTAssertLessThan(try! XCTUnwrap(diagnostics), try! XCTUnwrap(debug))
    }

    func testStoredZipContainsNamedEntriesAndEndRecord() throws {
        let destination = FileManager.default.temporaryDirectory
            .appending(path: "diagnostic-zip-test-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: destination) }

        try StoredZipArchive.write(
            entries: [
                .init(name: "meta.json", data: Data("{}".utf8)),
                .init(name: "http-events.jsonl", data: Data()),
            ],
            to: destination
        )

        let archive = try Data(contentsOf: destination)
        XCTAssertEqual(Array(archive.prefix(4)), [0x50, 0x4B, 0x03, 0x04])
        XCTAssertNotNil(archive.range(of: Data("meta.json".utf8)))
        XCTAssertNotNil(archive.range(of: Data("http-events.jsonl".utf8)))
        XCTAssertNotNil(archive.range(of: Data([0x50, 0x4B, 0x05, 0x06])))
    }
}
