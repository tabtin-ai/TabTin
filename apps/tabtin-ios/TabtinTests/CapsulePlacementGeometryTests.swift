import CoreGraphics
import XCTest
@testable import Tabtin

final class CapsulePlacementGeometryTests: XCTestCase {
    func testDefaultPlacementIsBottomRight() {
        let viewport = CGSize(width: 390, height: 844)
        let capsule = CGSize(width: 160, height: 48)
        let point = CapsulePlacementGeometry.position(
            for: .default,
            viewport: viewport,
            capsuleSize: capsule
        )
        let bounds = CapsulePlacementGeometry.resolveBounds(
            viewport: viewport,
            capsuleSize: capsule
        )
        XCTAssertEqual(point.x, bounds.maxX, accuracy: 0.01)
        XCTAssertEqual(point.y, bounds.maxY, accuracy: 0.01)
    }

    func testDockSnapsToNearestSide() {
        let viewport = CGSize(width: 390, height: 844)
        let capsule = CGSize(width: 160, height: 48)
        let leftish = CGPoint(x: 40, y: 400)
        let docked = CapsulePlacementGeometry.dockedPosition(
            from: leftish,
            viewport: viewport,
            capsuleSize: capsule
        )
        let placement = CapsulePlacementGeometry.placement(
            from: leftish,
            viewport: viewport,
            capsuleSize: capsule
        )
        XCTAssertEqual(placement.side, .left)
        XCTAssertEqual(docked.x, CapsulePlacementGeometry.resolveBounds(
            viewport: viewport,
            capsuleSize: capsule
        ).minX, accuracy: 0.01)
    }

    func testYRatioClamped() {
        let viewport = CGSize(width: 390, height: 844)
        let capsule = CGSize(width: 48, height: 48)
        let top = CapsulePlacementGeometry.position(
            for: CapsulePlacement(side: .right, yRatio: -1),
            viewport: viewport,
            capsuleSize: capsule
        )
        let bottom = CapsulePlacementGeometry.position(
            for: CapsulePlacement(side: .right, yRatio: 2),
            viewport: viewport,
            capsuleSize: capsule
        )
        let bounds = CapsulePlacementGeometry.resolveBounds(
            viewport: viewport,
            capsuleSize: capsule
        )
        XCTAssertEqual(top.y, bounds.minY, accuracy: 0.01)
        XCTAssertEqual(bottom.y, bounds.maxY, accuracy: 0.01)
    }

    func testHITLBubbleAnchorsToCapsuleSideWithoutMovingCapsuleAndStaysSafe() {
        let viewport = CGRect(x: 0, y: 0, width: 390, height: 844)
        let bubbleSize = CGSize(width: 288, height: 170)
        let bottomRightCapsule = CGRect(x: 228, y: 782, width: 148, height: 48)

        let right = CapsuleHITLBubbleGeometry.placement(
            viewport: viewport,
            capsuleFrame: bottomRightCapsule,
            bubbleSize: bubbleSize,
            side: .right
        )

        XCTAssertEqual(right.edge, .above)
        XCTAssertEqual(right.frame.maxX, bottomRightCapsule.maxX, accuracy: 0.01)
        XCTAssertGreaterThanOrEqual(right.frame.minX, CapsulePlacementMetrics.safeMargin)
        XCTAssertLessThanOrEqual(right.frame.maxY, bottomRightCapsule.minY)

        let topLeftCapsule = CGRect(x: 14, y: 14, width: 148, height: 48)
        let left = CapsuleHITLBubbleGeometry.placement(
            viewport: viewport,
            capsuleFrame: topLeftCapsule,
            bubbleSize: bubbleSize,
            side: .left
        )

        XCTAssertEqual(left.edge, .below)
        XCTAssertEqual(left.frame.minX, topLeftCapsule.minX, accuracy: 0.01)
        XCTAssertGreaterThanOrEqual(left.frame.minY, topLeftCapsule.maxY)
        XCTAssertLessThanOrEqual(
            left.frame.maxY,
            viewport.maxY - CapsulePlacementMetrics.safeMargin
        )
    }

    func testHITLBubbleGeometryConstrainsOversizedDynamicTypeContentToAvailableSide() {
        let viewport = CGRect(x: 0, y: 0, width: 320, height: 420)
        let capsule = CGRect(x: 158, y: 350, width: 148, height: 48)

        let maximum = CapsuleHITLBubbleGeometry.maximumSize(
            viewport: viewport,
            capsuleFrame: capsule
        )
        let placement = CapsuleHITLBubbleGeometry.placement(
            viewport: viewport,
            capsuleFrame: capsule,
            bubbleSize: CGSize(width: 600, height: 900),
            side: .right
        )

        XCTAssertEqual(maximum.width, 288, accuracy: 0.01)
        XCTAssertEqual(placement.frame.size, maximum)
        XCTAssertGreaterThanOrEqual(
            placement.frame.minX,
            viewport.minX + CapsulePlacementMetrics.safeMargin
        )
        XCTAssertGreaterThanOrEqual(
            placement.frame.minY,
            viewport.minY + CapsulePlacementMetrics.safeMargin
        )
        XCTAssertLessThanOrEqual(
            placement.frame.maxX,
            viewport.maxX - CapsulePlacementMetrics.safeMargin
        )
        XCTAssertLessThanOrEqual(
            placement.frame.maxY,
            capsule.minY - CapsuleHITLBubbleGeometry.gap
        )
    }

    func testHITLBubbleUsesSafeBootstrapSizeBeforeSwiftUIMeasurementArrives() {
        let maximum = CGSize(width: 288, height: 319)

        let bootstrap = CapsuleHITLAccessoryMeasurement.resolvedSize(
            measured: .zero,
            maximum: maximum
        )

        XCTAssertEqual(bootstrap.width, 288, accuracy: 0.01)
        XCTAssertGreaterThan(bootstrap.height, 1)
        XCTAssertLessThanOrEqual(bootstrap.height, maximum.height)
    }

    func testHITLBubblePrefersMeasuredSizeAfterBootstrap() {
        let measured = CGSize(width: 288, height: 146)

        XCTAssertEqual(
            CapsuleHITLAccessoryMeasurement.resolvedSize(
                measured: measured,
                maximum: CGSize(width: 288, height: 319)
            ),
            measured
        )
    }
}
