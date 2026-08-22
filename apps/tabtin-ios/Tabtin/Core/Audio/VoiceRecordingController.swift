import AVFoundation
import os
import SwiftUI
import UIKit

private let logger = Logger(subsystem: "com.tabtin.mobile", category: "VoiceRecordingController")

/// preparing 中断门禁：松手 / stop 抬 generation 后，旧 start 不得进入 recording。
enum VoiceRecordingPreparingCancelPolicy {
    static func mayEnterRecording(
        stateIsPreparing: Bool,
        startGeneration: Int,
        observedGeneration: Int
    ) -> Bool {
        stateIsPreparing && startGeneration == observedGeneration
    }
}

/// Testable terminal transition for an ASR failure.
///
/// The controller must synchronously leave the recordable states before awaiting the audio actor:
/// otherwise a late start/observer callback can revive a recorder whose ASR stream has already
/// failed. The closure boundary makes the exclusive audio-session release independently testable.
@MainActor
final class VoiceRecordingTerminationCoordinator {
    private let canTerminate: () -> Bool
    private let markProcessing: () -> Void
    private let isProcessing: () -> Bool
    private let stopTimer: () -> Void
    private let removeObservers: () -> Void
    private let cancelAudio: () async -> Void
    private let currentTranscription: () -> String
    private let setTranscription: (String) -> Void
    private let setError: (String) -> Void
    private let markError: () -> Void
    private let cleanupASR: () -> Void

    init(
        canTerminate: @escaping () -> Bool,
        markProcessing: @escaping () -> Void,
        isProcessing: @escaping () -> Bool,
        stopTimer: @escaping () -> Void,
        removeObservers: @escaping () -> Void,
        cancelAudio: @escaping () async -> Void,
        currentTranscription: @escaping () -> String,
        setTranscription: @escaping (String) -> Void,
        setError: @escaping (String) -> Void,
        markError: @escaping () -> Void,
        cleanupASR: @escaping () -> Void
    ) {
        self.canTerminate = canTerminate
        self.markProcessing = markProcessing
        self.isProcessing = isProcessing
        self.stopTimer = stopTimer
        self.removeObservers = removeObservers
        self.cancelAudio = cancelAudio
        self.currentTranscription = currentTranscription
        self.setTranscription = setTranscription
        self.setError = setError
        self.markError = markError
        self.cleanupASR = cleanupASR
    }

    /// Starts the error transition and returns the finalizer so tests can await the terminal state.
    @discardableResult
    func terminateForASRError(_ message: String) -> Task<Void, Never>? {
        guard canTerminate() else { return nil }

        markProcessing()
        stopTimer()
        removeObservers()

        return Task { @MainActor [weak self] in
            guard let self else { return }
            await self.cancelAudio()
            guard self.isProcessing() else { return }
            self.setTranscription(self.currentTranscription())
            self.setError(message)
            self.markError()
            self.cleanupASR()
        }
    }

    /// Releases a preheated audio session even when AVAudioEngine has not started recording yet.
    @discardableResult
    static func cancelPreconnectedSession(
        stopASR: (() -> Void)? = nil,
        cleanupASR: (() -> Void)? = nil,
        cancelAudio: @escaping () async -> Void
    ) -> Task<Void, Never> {
        stopASR?()
        cleanupASR?()
        return Task { await cancelAudio() }
    }
}

/// Shared recording lifecycle controller used by both Chat voice input and TabMemo voice recorder.
/// Manages: state machine, ASR session, AudioRecordingService, timer, audio levels, permission check.
///
/// 通过 `VoiceConfig` 驱动不同场景的参数差异（Chat vs Memo vs 其他）。
@MainActor @Observable
final class VoiceRecordingController {
    enum State: Equatable {
        case idle, preparing, recording, processing, done, error
    }

    private(set) var state: State = .idle
    private(set) var transcribedText = ""
    private(set) var recordingDuration: TimeInterval = 0
    private(set) var audioLevels: [CGFloat] = Array(repeating: 0.05, count: 30)
    private(set) var errorMessage: String?
    private(set) var isPermissionError = false
    private(set) var retryCount = 0
    private(set) var lastFileURL: URL?
    private(set) var userHasEdited = false
    private(set) var latestEmotion: ASREmotionTag?

    private var voiceSession = VoiceRecordingSession()

    /// 语音模块配置，决定 ASR 参数、录制行为等。
    var voiceConfig: VoiceConfig = .chat()

    /// 由 voiceConfig 驱动的最大录音时长。
    var maxDuration: TimeInterval { voiceConfig.maxDuration }

    /// **`@Sendable`**：会被 AudioRecordingService 的 audio thread tap callback 真实跨线程
    /// 调用（写盘失败超阈值时触发），必须 Sendable。caller（如 MemoVoiceRecorderOverlay）端
    /// closure 内一般用 `Task { @MainActor in ... }` hop 回 main actor 域。
    var onWriteError: (@Sendable () -> Void)?

    /// 实时 ASR 文本回调（主线程）；胶囊 Voice HUD / Composer 可订阅。
    var onTranscriptUpdate: ((String) -> Void)?

    private(set) var isNearTimeLimit = false
    private(set) var didReachTimeLimit = false

    private var durationTimer: Task<Void, Never>?
    private var interruptionObserver: (any NSObjectProtocol)?
    private var backgroundObserver: (any NSObjectProtocol)?
    /// preparing 期间松手 / stop / cancel 时递增，废止后续 startRecording 续跑。
    private var startGeneration = 0
    @ObservationIgnored private var terminationCoordinator: VoiceRecordingTerminationCoordinator!

    init() {
        terminationCoordinator = VoiceRecordingTerminationCoordinator(
            canTerminate: { [weak self] in
                guard let self else { return false }
                return self.state == .preparing || self.state == .recording
            },
            markProcessing: { [weak self] in self?.state = .processing },
            isProcessing: { [weak self] in self?.state == .processing },
            stopTimer: { [weak self] in self?.stopTimer() },
            removeObservers: { [weak self] in self?.removeInterruptionObserver() },
            cancelAudio: { await AudioRecordingService.shared.cancelRecording() },
            currentTranscription: { [weak self] in self?.voiceSession.transcribedText ?? "" },
            setTranscription: { [weak self] in self?.transcribedText = $0 },
            setError: { [weak self] in self?.errorMessage = $0 },
            markError: { [weak self] in self?.state = .error },
            cleanupASR: { [weak self] in self?.voiceSession.cleanup() }
        )
    }

    // MARK: - Computed

    /// Single source of truth for displayed transcription text.
    /// During recording: shows live ASR text. After done: shows resolved/user-edited text.
    var effectiveText: String {
        if state == .done || state == .error {
            return transcribedText
        }
        return voiceSession.transcribedText.isEmpty ? transcribedText : voiceSession.transcribedText
    }

    var hasText: Bool {
        !effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var formattedDuration: String {
        let mins = Int(recordingDuration) / 60
        let secs = Int(recordingDuration) % 60
        return String(format: "%d:%02d", mins, secs)
    }

    /// 当前情绪的 emoji（来自 ASR 情绪检测）
    var emotionEmoji: String? {
        latestEmotion?.emoji
    }

    // MARK: - Text Editing (for Memo text editor)

    /// Update transcription text from user edits. Sets `userHasEdited` to prevent late ASR overwrites.
    func updateText(_ text: String) {
        transcribedText = text
        userHasEdited = true
    }

    // MARK: - Recording Lifecycle

    func startRecording() async {
        startGeneration += 1
        let generation = startGeneration
        state = .preparing
        errorMessage = nil
        isPermissionError = false
        transcribedText = ""
        recordingDuration = 0
        audioLevels = Array(repeating: 0.05, count: 30)
        userHasEdited = false
        latestEmotion = nil

        let preSession = VoiceRecordingSession.consumePreconnected(for: voiceConfig.scenario)

        if let pre = preSession {
            voiceSession = pre
        } else {
            voiceSession.reset()
        }

        await AudioRecordingService.shared.cleanupFile()
        guard isCurrentStart(generation) else { return }

        voiceSession.onTextUpdate = { [weak self] text, _ in
            guard let self else { return }
            // 录音中 / processing / done 都推送，驱动实时转写 UI；用户手改后不再覆盖。
            guard !self.userHasEdited else { return }
            self.transcribedText = text
            self.onTranscriptUpdate?(text)
        }

        voiceSession.onEmotion = { [weak self] tag in
            guard let self else { return }
            self.latestEmotion = tag
        }

        voiceSession.onASRError = { [weak self] message in
            self?.handleASRError(message)
        }

        if let asrError = voiceSession.asrError {
            handleASRError(asrError)
            return
        }

        guard await Self.checkMicrophonePermission() else {
            guard isCurrentStart(generation) else { return }
            isPermissionError = true
            state = .error
            if preSession != nil {
                let cancellation = VoiceRecordingTerminationCoordinator.cancelPreconnectedSession(
                    stopASR: { [weak self] in self?.voiceSession.stopASR() },
                    cleanupASR: { [weak self] in self?.voiceSession.cleanup() },
                    cancelAudio: { await AudioRecordingService.shared.cancelRecording() }
                )
                await cancellation.value
            }
            return
        }

        guard isCurrentStart(generation), state == .preparing else { return }

        do {
            if preSession == nil {
                async let asrStart: String = voiceSession.startASR(config: voiceConfig)
                try? await AudioRecordingService.shared.prepareSession()
                _ = try await asrStart
            }

            guard isCurrentStart(generation), state == .preparing else {
                await AudioRecordingService.shared.cancelRecording()
                return
            }

            let session = voiceSession
            let writeErrHandler = onWriteError
            try await AudioRecordingService.shared.startRecording(
                onChunk: { data in
                    Task { @MainActor in session.sendAudio(data) }
                },
                onLevel: { [weak self] level in
                    Task { @MainActor in
                        guard let self else { return }
                        withAnimation(.easeOut(duration: 0.08)) {
                            self.audioLevels.removeFirst()
                            self.audioLevels.append(CGFloat(level))
                        }
                    }
                },
                onWriteError: {
                    Task { @MainActor in writeErrHandler?() }
                }
            )

            // preparing 松手已抬 generation / 离态时，禁止迟到的 start 进入 recording。
            guard VoiceRecordingPreparingCancelPolicy.mayEnterRecording(
                stateIsPreparing: state == .preparing,
                startGeneration: startGeneration,
                observedGeneration: generation
            ) else {
                await AudioRecordingService.shared.cancelRecording()
                return
            }

            state = .recording
            retryCount = 0
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            isNearTimeLimit = false
            didReachTimeLimit = false
            startTimer()
            observeInterruptions()
            observeAppLifecycle()
        } catch {
            guard isCurrentStart(generation) else {
                await AudioRecordingService.shared.cancelRecording()
                return
            }
            await AudioRecordingService.shared.cancelRecording()
            logger.error("Recording start failed: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            state = .error
            voiceSession.cleanup()
        }
    }

    func stopRecording() async {
        // preparing 时松手：废止本轮 start，禁止 await 结束后又进入 recording。
        if state == .preparing {
            await cancelPreparingStart()
            return
        }
        guard state == .recording else { return }
        state = .processing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        stopTimer()

        voiceSession.stopASR()

        do {
            let result = try await AudioRecordingService.shared.stopRecording()
            lastFileURL = result.fileURL

            await voiceSession.awaitDone(timeout: 5)
            transcribedText = voiceSession.transcribedText

            if let emotion = voiceSession.latestEmotion {
                latestEmotion = emotion
            }

            if let asrErr = voiceSession.asrError, transcribedText.isEmpty {
                errorMessage = asrErr
                state = .error
            } else {
                state = .done
            }
        } catch {
            logger.error("Recording stop error: \(error.localizedDescription)")
            transcribedText = voiceSession.transcribedText
            state = .done
        }
    }

    /// preparing 中断：同步抬 generation + 离开 preparing，再释放音频。
    private func cancelPreparingStart() async {
        startGeneration += 1
        state = .idle
        stopTimer()
        removeInterruptionObserver()
        voiceSession.stopASR()
        voiceSession.cleanup()
        transcribedText = ""
        latestEmotion = nil
        await AudioRecordingService.shared.cancelRecording()
    }

    private func isCurrentStart(_ generation: Int) -> Bool {
        generation == startGeneration
    }

    /// ASR may fail while audio capture is still active. Move to a terminal error state before
    /// awaiting the audio actor so a concurrent start cannot revive the recorder afterwards.
    private func handleASRError(_ message: String) {
        _ = terminationCoordinator.terminateForASRError(message)
    }

    func cancelRecording() async {
        // **#L87 race window 闭合**（W2b.续 #L77 同款 state machine 严密化模式）：
        //
        // race 路径（之前未闭合）：
        //   T+0: state=.recording
        //   T+1: handleInterruption(.began) → Task A1 enqueue stopRecording 还没跑
        //   T+2: 用户点 cancel → cancelRecording 同步进入 → 跑到 await（第一个 await 是
        //        AudioRecordingService.cancelRecording()），让出 main actor
        //   T+3: Task A1 (stopRecording) 现在跑 → guard `state == .recording` **通过**
        //        （state 在 cancelRecording 内未被改）→ state = .processing → 错误地
        //        进入 stop 流程 → 最终 state=.done 而不是 .idle，与"用户已取消"语义不符
        //
        // 闭合方式：cancelRecording 入口**第一时间** `state = .idle`（同步语句，不是
        // await 后），让随后的 stopRecording guard 在嵌套调用时直接 return。这与 W3
        // 反思 §7.4 ConsumeFlag 论证粒度对齐 —— 真 race vs 注解漏标判定：本处是
        // **真 race window**（系统通知到达 + 用户操作 + 异步 Task 三方时序竞态），
        // 不是注解漏标，必须用同步 state flip 闭合。
        // 同时抬 startGeneration：preparing 中途 cancel 也必须废止后续 start。
        startGeneration += 1
        state = .idle
        stopTimer()
        removeInterruptionObserver()
        voiceSession.stopASR()
        voiceSession.cleanup()
        transcribedText = ""
        latestEmotion = nil
        await AudioRecordingService.shared.cancelRecording()
    }

    func cleanup() async {
        stopTimer()
        removeInterruptionObserver()
        voiceSession.cleanup()
        await AudioRecordingService.shared.cancelRecording()
    }

    func retry() {
        retryCount += 1
        Task { await startRecording() }
    }

    func cleanupOldFile() {
        if let oldURL = lastFileURL {
            try? FileManager.default.removeItem(at: oldURL)
            lastFileURL = nil
        }
    }

    /// Restore to done state with pre-existing text (e.g. draft recovery).
    func restoreAsDone(text: String) {
        transcribedText = text
        state = .done
    }

    // MARK: - Audio Interruption

    private func observeInterruptions() {
        removeInterruptionObserver()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { [weak self] notification in
            // 同步入口提取 Sendable UInt：NotificationCenter `queue: nil` 不保证 main thread
            // delivery，`notification` 本身不 Sendable 不能跨 actor capture。先在同步 closure
            // 入口提取 typeRaw，handleInterruption 接受 UInt。**与 W2b.续 #L77 + 技术 Review
            // 必修 #3 闭合 race window 同模式**：所有依赖系统通知瞬时状态的字段都应在同步入口
            // 读取并捕获到本地，避免"通知到达后到 Task 跑期间状态已变"的真 race。
            let typeRaw = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? UInt.max
            Task { @MainActor [weak self] in
                self?.handleInterruption(typeRaw: typeRaw)
            }
        }
    }

    private func removeInterruptionObserver() {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        if let observer = backgroundObserver {
            NotificationCenter.default.removeObserver(observer)
            backgroundObserver = nil
        }
    }

    private func observeAppLifecycle() {
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.state == .recording else { return }
                logger.info("App entered background, auto-stopping recording")
                await self.stopRecording()
            }
        }
    }

    /// 处理音频中断。**只接受 Sendable UInt**（不接受 Notification）—— 真 race vs 注解漏标
    /// 判定：`state == .recording` 守卫读的是 main actor 隔离字段，Task wrapper 内重新读取
    /// 本就是 main actor 串行调度域内的最新值；如用户在 .began 触发后到 Task 跑期间手动停录
    /// → state 已变 → 守卫拦住 noop（这是正确决策，不是 race）。**这条不属于"真 race
    /// 必须同步入口提取所有依赖状态"** —— 不读 player.timeControlStatus 等可变设备状态。
    private func handleInterruption(typeRaw: UInt) {
        guard state == .recording,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw)
        else { return }

        switch type {
        case .began:
            logger.info("Audio session interrupted, auto-stopping recording")
            Task { await stopRecording() }
        case .ended:
            break
        @unknown default:
            break
        }
    }

    // MARK: - Timer

    private func startTimer() {
        durationTimer?.cancel()
        durationTimer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { break }
                recordingDuration += 1
                let remaining = maxDuration - recordingDuration
                if remaining <= 30 && !isNearTimeLimit {
                    isNearTimeLimit = true
                }
                if recordingDuration >= maxDuration {
                    didReachTimeLimit = true
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    await stopRecording()
                    break
                }
            }
        }
    }

    private func stopTimer() {
        durationTimer?.cancel()
    }

    // MARK: - Permission

    static func checkMicrophonePermission() async -> Bool {
        let status = AVAudioApplication.shared.recordPermission
        switch status {
        case .granted:
            return true
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        default:
            return false
        }
    }
}
