import XCTest
@testable import Tabtin

final class IOSDiagnosticUploadStateTests: XCTestCase {
    func testAwaitingCompletionStateSurvivesRoundTripWithoutSignedURL() throws {
        let state = IOSDiagnosticUploadState(
            phase: .awaitingCompletion,
            serverBundleId: "server-bundle-1",
            sha256: String(repeating: "a", count: 64),
            size: 42
        )

        let encoded = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(IOSDiagnosticUploadState.self, from: encoded)

        XCTAssertEqual(decoded, state)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("https://"))
    }

    func testPendingDiagnosticCanBackfillOrganizationAfterLogin() throws {
        let pending = IOSPendingDiagnostic(
            diagnosticBundleId: UUID(),
            organizationId: "",
            clientInstallId: "install-1"
        )

        let updated = pending.backfilled(organizationId: "org-after-login")

        XCTAssertEqual(updated.organizationId, "org-after-login")
        XCTAssertEqual(updated.clientInstallId, pending.clientInstallId)
        XCTAssertEqual(updated.diagnosticBundleId, pending.diagnosticBundleId)
    }

    func testMissingBackgroundTaskFallsBackToIdempotentCompletion() {
        let uploading = IOSDiagnosticUploadState(
            phase: .uploading,
            serverBundleId: "server-bundle-1",
            sha256: String(repeating: "b", count: 64),
            size: 84
        )

        let recovered = uploading.awaitingCompletionAfterTaskLoss()

        XCTAssertEqual(recovered.phase, .awaitingCompletion)
        XCTAssertEqual(recovered.serverBundleId, uploading.serverBundleId)
        XCTAssertEqual(recovered.sha256, uploading.sha256)
        XCTAssertEqual(recovered.size, uploading.size)
    }

    func testMissingUploadedObjectIsRecoverable() {
        let body = Data(#"{"detail":"uploaded object not found"}"#.utf8)

        XCTAssertEqual(
            diagnosticCompletionDisposition(statusCode: 409, responseBody: body),
            .recoverable
        )
        XCTAssertEqual(
            diagnosticCompletionDisposition(statusCode: 404, responseBody: Data()),
            .recoverable
        )
    }

    func testOtherConflictIsTerminal() {
        let body = Data(#"{"detail":"bundle is not pending upload"}"#.utf8)

        XCTAssertEqual(
            diagnosticCompletionDisposition(statusCode: 409, responseBody: body),
            .terminal
        )
    }
}
