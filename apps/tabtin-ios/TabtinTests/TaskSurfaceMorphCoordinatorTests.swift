import XCTest
@testable import Tabtin

@MainActor
final class TaskSurfaceMorphCoordinatorTests: XCTestCase {
    private var morph: TaskSurfaceMorphCoordinator!

    override func setUp() {
        super.setUp()
        morph = TaskSurfaceMorphCoordinator()
    }

    override func tearDown() {
        morph = nil
        super.tearDown()
    }

    func testTimingMatchesElectron() {
        XCTAssertEqual(TaskSurfaceMorphTiming.durationMs, 420)
        XCTAssertEqual(TaskSurfaceMorphTiming.ghostFadeMs, 140)
        XCTAssertEqual(TaskSurfaceMorphTiming.pendingTTLMs, 1000)
        XCTAssertEqual(TaskSurfaceMorphTiming.phoneCapsuleMorphMs, 260)
        XCTAssertEqual(TaskSurfaceMorphTiming.easingControlPoints.0, 0.77, accuracy: 0.001)
        XCTAssertEqual(TaskSurfaceMorphTiming.easingControlPoints.1, 0, accuracy: 0.001)
        XCTAssertEqual(TaskSurfaceMorphTiming.easingControlPoints.2, 0.175, accuracy: 0.001)
        XCTAssertEqual(TaskSurfaceMorphTiming.easingControlPoints.3, 1, accuracy: 0.001)
    }

    func testSplitToAppFocusCapturesRailAndHidesCapsule() {
        let now = Date(timeIntervalSince1970: 1_000)
        let rail = CGRect(x: 0, y: 0, width: 400, height: 800)
        let direction = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: rail,
            capsuleRect: nil,
            reduceMotion: false,
            now: now
        )
        XCTAssertEqual(direction, .toCapsule)
        XCTAssertTrue(morph.shouldHideCapsule(at: now))
        // toCapsule：源 rail 也隐藏，只留 ghost 单实体。
        XCTAssertTrue(morph.shouldHideRail(at: now))
        XCTAssertTrue(morph.hasPending(direction: .toCapsule, at: now))
        XCTAssertEqual(morph.pendingFromRect, rail)
    }

    func testAppFocusToSplitCapturesCapsuleAndHidesRail() {
        let now = Date(timeIntervalSince1970: 1_000)
        let capsule = CGRect(x: 700, y: 700, width: 48, height: 48)
        let direction = morph.beginTransition(
            from: .appFocus,
            to: .split,
            railRect: nil,
            capsuleRect: capsule,
            reduceMotion: false,
            now: now
        )
        XCTAssertEqual(direction, .toRail)
        XCTAssertTrue(morph.shouldHideRail(at: now))
        // toRail：源胶囊也隐藏，只留 ghost 单实体。
        XCTAssertTrue(morph.shouldHideCapsule(at: now))
        XCTAssertTrue(morph.hasPending(direction: .toRail, at: now))
    }

    func testActiveGhostHidesBothChromeEntities() {
        let now = Date(timeIntervalSince1970: 1_100)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: now
        )
        XCTAssertTrue(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: now
            )
        )
        XCTAssertTrue(morph.hasActiveGhost)
        XCTAssertTrue(morph.shouldHideCapsule(at: now))
        XCTAssertTrue(morph.shouldHideRail(at: now))
    }

    func testConsumeWrongDirectionKeepsPending() {
        let now = Date(timeIntervalSince1970: 1_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: now
        )
        XCTAssertFalse(
            morph.consume(
                direction: .toRail,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: now
            )
        )
        XCTAssertTrue(morph.hasPending(direction: .toCapsule, at: now))
        XCTAssertTrue(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: now
            )
        )
        XCTAssertFalse(morph.hasPending(direction: .toCapsule, at: now.addingTimeInterval(0.01)))
        XCTAssertTrue(morph.hasActiveGhost)
    }

    func testPendingExpiresByTTL() {
        let now = Date(timeIntervalSince1970: 1_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: now
        )
        let expired = now.addingTimeInterval(Double(TaskSurfaceMorphTiming.pendingTTLMs) / 1000 + 0.05)
        XCTAssertFalse(morph.hasPending(direction: .toCapsule, at: expired))
        XCTAssertFalse(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: expired
            )
        )
        XCTAssertFalse(morph.hasActiveGhost)
    }

    func testReduceMotionSkipsCaptureAndClearsActive() {
        let now = Date(timeIntervalSince1970: 1_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: now
        )
        _ = morph.consume(
            direction: .toCapsule,
            targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
            now: now
        )
        XCTAssertTrue(morph.hasActiveGhost)

        let direction = morph.beginTransition(
            from: .appFocus,
            to: .split,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: CGRect(x: 700, y: 700, width: 48, height: 48),
            reduceMotion: true,
            now: now.addingTimeInterval(0.1)
        )
        XCTAssertNil(direction)
        XCTAssertFalse(morph.hasActiveGhost)
        XCTAssertFalse(morph.hasPending(direction: .toRail, at: now.addingTimeInterval(0.1)))
        XCTAssertFalse(morph.shouldHideCapsule(at: now.addingTimeInterval(0.1)))
        XCTAssertFalse(morph.shouldHideRail(at: now.addingTimeInterval(0.1)))
    }

    func testMidFlightReverseUsesInterruptedRectAndLeavesNoResidue() {
        let t0 = Date(timeIntervalSince1970: 2_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: t0
        )
        XCTAssertTrue(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: t0
            )
        )

        let mid = t0.addingTimeInterval(Double(TaskSurfaceMorphTiming.durationMs) / 2000)
        let interrupted = morph.cancelActiveMorph(at: mid)
        XCTAssertNotNil(interrupted)
        XCTAssertFalse(morph.hasActiveGhost)
        // 中途 rect 应介于起终点之间
        XCTAssertGreaterThan(interrupted!.origin.x, 0)
        XCTAssertLessThan(interrupted!.origin.x, 700)

        let reverseAt = mid
        let direction = morph.beginTransition(
            from: .appFocus,
            to: .split,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: interrupted,
            reduceMotion: false,
            now: reverseAt
        )
        XCTAssertEqual(direction, .toRail)
        XCTAssertEqual(morph.pendingFromRect, interrupted)
        XCTAssertTrue(
            morph.consume(
                direction: .toRail,
                targetRect: CGRect(x: 0, y: 0, width: 400, height: 800),
                now: reverseAt
            )
        )

        let finished = reverseAt.addingTimeInterval(
            Double(TaskSurfaceMorphTiming.durationMs + TaskSurfaceMorphTiming.ghostFadeMs) / 1000 + 0.01
        )
        morph.completeGhost(at: finished)
        XCTAssertFalse(morph.hasActiveGhost)
        XCTAssertFalse(morph.shouldHideRail(at: finished))
        XCTAssertFalse(morph.shouldHideCapsule(at: finished))
    }

    func testGhostPresentationIdentityChangesOnReverse() {
        let t0 = Date(timeIntervalSince1970: 4_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: t0
        )
        XCTAssertTrue(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: t0
            )
        )
        let first = morph.activeGhostSnapshot!
        let ghostA = TaskSurfaceMorphGhostPresentation(
            id: "\(first.direction.rawValue)-\(first.startedAt.timeIntervalSince1970)",
            direction: first.direction,
            from: first.from,
            to: first.to
        )

        let mid = t0.addingTimeInterval(0.1)
        let interrupted = morph.cancelActiveMorph(at: mid)
        _ = morph.beginTransition(
            from: .appFocus,
            to: .split,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: interrupted,
            reduceMotion: false,
            now: mid
        )
        XCTAssertTrue(
            morph.consume(
                direction: .toRail,
                targetRect: CGRect(x: 0, y: 0, width: 400, height: 800),
                now: mid
            )
        )
        let second = morph.activeGhostSnapshot!
        let ghostB = TaskSurfaceMorphGhostPresentation(
            id: "\(second.direction.rawValue)-\(second.startedAt.timeIntervalSince1970)",
            direction: second.direction,
            from: second.from,
            to: second.to
        )
        XCTAssertNotEqual(ghostA.id, ghostB.id)
        XCTAssertNotEqual(ghostA.direction, ghostB.direction)
    }

    func testChatFocusTransitionsDoNotCaptureMorph() {
        let now = Date(timeIntervalSince1970: 3_000)
        XCTAssertNil(
            morph.beginTransition(
                from: .chatFocus,
                to: .split,
                railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
                capsuleRect: nil,
                reduceMotion: false,
                now: now
            )
        )
        XCTAssertNil(
            morph.beginTransition(
                from: .split,
                to: .chatFocus,
                railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
                capsuleRect: nil,
                reduceMotion: false,
                now: now
            )
        )
    }

    func testSwitchingToThirdStateClearsHideAndInvalidatesOldGeneration() {
        let t0 = Date(timeIntervalSince1970: 5_000)
        _ = morph.beginTransition(
            from: .split,
            to: .appFocus,
            railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
            capsuleRect: nil,
            reduceMotion: false,
            now: t0
        )
        let generation = morph.transitionGeneration
        XCTAssertTrue(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: t0,
                generation: generation
            )
        )
        XCTAssertTrue(morph.shouldHideCapsule(at: t0))

        // 快速切到 chat-focus：必须清 active/pending/hide，旧回调不得把 rail 长期透明。
        let mid = t0.addingTimeInterval(0.05)
        XCTAssertNil(
            morph.beginTransition(
                from: .appFocus,
                to: .chatFocus,
                railRect: CGRect(x: 0, y: 0, width: 400, height: 800),
                capsuleRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                reduceMotion: false,
                now: mid
            )
        )
        XCTAssertFalse(morph.isCurrentTransition(generation))
        XCTAssertFalse(morph.hasActiveGhost)
        XCTAssertFalse(morph.shouldHideCapsule(at: mid))
        XCTAssertFalse(morph.shouldHideRail(at: mid))
        XCTAssertFalse(
            morph.consume(
                direction: .toCapsule,
                targetRect: CGRect(x: 700, y: 700, width: 48, height: 48),
                now: mid,
                generation: generation
            )
        )
        morph.completeGhost(at: mid, generation: generation)
        XCTAssertFalse(morph.shouldHideRail(at: mid))
    }
}
