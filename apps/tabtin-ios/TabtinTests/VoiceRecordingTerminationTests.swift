import XCTest
@testable import Tabtin

@MainActor
final class VoiceRecordingTerminationTests: XCTestCase {
    func testVoiceOverlayOnlyInterruptsAfterPermissionWasGranted() {
        XCTAssertFalse(
            shouldInterruptVoiceOverlayAfterPermissionRequest(
                permissionWasUndetermined: false,
                permissionIsGranted: false
            ),
            "已拒绝权限时必须保留弹窗，用户才能点击设置"
        )
        XCTAssertFalse(
            shouldInterruptVoiceOverlayAfterPermissionRequest(
                permissionWasUndetermined: true,
                permissionIsGranted: false
            ),
            "首次拒绝后必须保留弹窗，用户才能点击设置"
        )
        XCTAssertTrue(
            shouldInterruptVoiceOverlayAfterPermissionRequest(
                permissionWasUndetermined: true,
                permissionIsGranted: true
            ),
            "首次授权成功后结束本次按住手势，要求用户重新触发录音"
        )
    }

    func testPreparingASRErrorCancelsAudioTimerAndObserversThenReachesError() async {
        await assertASRErrorTransition(from: .preparing)
    }

    func testRecordingASRErrorCancelsAudioTimerAndObserversThenReachesError() async {
        await assertASRErrorTransition(from: .recording)
    }

    func testPreconnectedSessionCancellationReleasesPreparedAudioWithoutAnActiveRecorder() async {
        let log = EventLog()
        let fakeASR = FakeASR(log: log)
        let fakeAudio = FakeAudioSession(log: log, isRecording: false)

        let task = VoiceRecordingTerminationCoordinator.cancelPreconnectedSession(
            stopASR: { fakeASR.stop() },
            cleanupASR: { fakeASR.cleanup() },
            cancelAudio: { await fakeAudio.cancel() }
        )
        await task.value

        XCTAssertFalse(fakeAudio.isRecording)
        XCTAssertEqual(fakeAudio.cancelCalls, 1)
        XCTAssertEqual(log.events, ["asr-stopped", "asr-cleaned", "audio-cancelled"])
    }

    func testVoiceRecordingSessionForwardsASRErrorToControllerHandoff() {
        let session = VoiceRecordingSession()
        var receivedError: String?
        session.onASRError = { receivedError = $0 }

        session.receiveASRError("stream lost")

        XCTAssertEqual(session.asrError, "stream lost")
        XCTAssertTrue(session.isASRDone)
        XCTAssertEqual(receivedError, "stream lost")
    }

    func testPreparingStopInvalidatesStartGeneration() {
        // preparing 松手必须抬 generation，禁止迟到的 start 再进入 recording。
        var startGeneration = 1
        let preparingGeneration = startGeneration
        startGeneration += 1 // stop/cancel during preparing
        XCTAssertFalse(
            preparingGeneration == startGeneration,
            "preparing 中断后旧 start 世代必须失效"
        )
        XCTAssertTrue(
            VoiceRecordingPreparingCancelPolicy.mayEnterRecording(
                stateIsPreparing: true,
                startGeneration: startGeneration,
                observedGeneration: startGeneration
            )
        )
        XCTAssertFalse(
            VoiceRecordingPreparingCancelPolicy.mayEnterRecording(
                stateIsPreparing: true,
                startGeneration: startGeneration,
                observedGeneration: preparingGeneration
            )
        )
        XCTAssertFalse(
            VoiceRecordingPreparingCancelPolicy.mayEnterRecording(
                stateIsPreparing: false,
                startGeneration: startGeneration,
                observedGeneration: startGeneration
            )
        )
    }

    private func assertASRErrorTransition(from phase: Phase) async {
        let log = EventLog()
        let lifecycle = Lifecycle(phase: phase, log: log)
        let fakeAudio = FakeAudioSession(log: log, isRecording: phase == .recording)
        let fakeASR = FakeASR(log: log)
        let terminator = makeTerminator(lifecycle: lifecycle, audio: fakeAudio)
        fakeASR.onError = { terminator.terminateForASRError($0) }

        let finalizer = fakeASR.emitError("ASR failed")

        XCTAssertNotNil(finalizer)
        XCTAssertEqual(lifecycle.phase, .processing)
        XCTAssertFalse(lifecycle.timerActive)
        XCTAssertFalse(lifecycle.observersActive)
        XCTAssertFalse(fakeAudio.didCancel)

        await finalizer?.value

        XCTAssertTrue(fakeAudio.didCancel)
        XCTAssertEqual(lifecycle.phase, .error)
        XCTAssertEqual(lifecycle.errorMessage, "ASR failed")
        XCTAssertEqual(lifecycle.transcription, "partial result")
        XCTAssertEqual(
            log.events,
            ["timer-stopped", "observers-removed", "audio-cancelled", "asr-cleaned"],
            "ASR 失败必须先同步撤销本轮 UI/观察者资源，再释放音频会话并收尾 ASR",
        )
    }

    private func makeTerminator(
        lifecycle: Lifecycle,
        audio: FakeAudioSession,
    ) -> VoiceRecordingTerminationCoordinator {
        VoiceRecordingTerminationCoordinator(
            canTerminate: { lifecycle.phase == .preparing || lifecycle.phase == .recording },
            markProcessing: { lifecycle.phase = .processing },
            isProcessing: { lifecycle.phase == .processing },
            stopTimer: {
                lifecycle.timerActive = false
                lifecycle.log.events.append("timer-stopped")
            },
            removeObservers: {
                lifecycle.observersActive = false
                lifecycle.log.events.append("observers-removed")
            },
            cancelAudio: { await audio.cancel() },
            currentTranscription: { lifecycle.transcription },
            setTranscription: { lifecycle.transcription = $0 },
            setError: { lifecycle.errorMessage = $0 },
            markError: { lifecycle.phase = .error },
            cleanupASR: { lifecycle.log.events.append("asr-cleaned") }
        )
    }

    private enum Phase: Equatable {
        case preparing
        case recording
        case processing
        case error
    }

    private final class EventLog {
        var events: [String] = []
    }

    private final class Lifecycle {
        let log: EventLog
        var phase: Phase
        var timerActive = true
        var observersActive = true
        var transcription = "partial result"
        var errorMessage: String?

        init(phase: Phase, log: EventLog) {
            self.phase = phase
            self.log = log
        }
    }

    private final class FakeAudioSession {
        let log: EventLog
        var isRecording: Bool
        var didCancel = false
        var cancelCalls = 0

        init(log: EventLog, isRecording: Bool) {
            self.log = log
            self.isRecording = isRecording
        }

        func cancel() async {
            isRecording = false
            didCancel = true
            cancelCalls += 1
            log.events.append("audio-cancelled")
        }
    }

    private final class FakeASR {
        let log: EventLog
        var onError: ((String) -> Task<Void, Never>?)?

        init(log: EventLog) {
            self.log = log
        }

        func emitError(_ message: String) -> Task<Void, Never>? {
            onError?(message)
        }

        func stop() {
            log.events.append("asr-stopped")
        }

        func cleanup() {
            log.events.append("asr-cleaned")
        }
    }
}
