import AVFoundation
import XCTest
@testable import Tabtin

final class CameraAccessPolicyTests: XCTestCase {
    func testAuthorizedCameraCanBePresented() {
        XCTAssertEqual(
            cameraAccessAction(cameraAvailable: true, authorizationStatus: .authorized),
            .presentCamera
        )
    }

    func testUndeterminedCameraPermissionIsRequested() {
        XCTAssertEqual(
            cameraAccessAction(cameraAvailable: true, authorizationStatus: .notDetermined),
            .requestPermission
        )
    }

    func testDeniedCameraPermissionShowsRecovery() {
        XCTAssertEqual(
            cameraAccessAction(cameraAvailable: true, authorizationStatus: .denied),
            .showPermissionDenied
        )
    }

    func testRestrictedCameraPermissionIsExplained() {
        XCTAssertEqual(
            cameraAccessAction(cameraAvailable: true, authorizationStatus: .restricted),
            .showRestricted
        )
    }

    func testMissingCameraTakesPrecedenceOverPermission() {
        XCTAssertEqual(
            cameraAccessAction(cameraAvailable: false, authorizationStatus: .authorized),
            .showUnavailable
        )
    }
}
