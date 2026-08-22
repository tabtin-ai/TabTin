import Foundation
import os

private let logger = Logger(subsystem: "com.tabtin.mobile", category: "VoiceRecordingSession")

@MainActor @Observable
final class VoiceRecordingSession {
    private(set) var transcribedText = ""
    private(set) var isASRDone = false
    private(set) var asrError: String?
    private(set) var latestEmotion: ASREmotionTag?

    /// Fired on every ASR transcript update (text, isFinal).
    var onTextUpdate: ((String, Bool) -> Void)?
    /// Fired when emotion tag is detected from ASR utterances.
    var onEmotion: ((ASREmotionTag) -> Void)?
    /// Fired when ASR ends with an error so the owning recorder can release the microphone.
    var onASRError: ((String) -> Void)?

    private var asrClient: ASRStreamClient?
    private var doneContinuation: CheckedContinuation<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    func startASR(config: VoiceConfig) async throws -> String {
        let client = ASRStreamClient()
        self.asrClient = client

        client.onTranscript = { [weak self] text, isFinal in
            guard let self else { return }
            if !text.isEmpty {
                let processed = VoiceSettings.shared.applyReplacements(text)
                self.transcribedText = processed
            }
            if isFinal {
                self.markDone()
            }
            self.onTextUpdate?(self.transcribedText, isFinal)
        }

        client.onError = { [weak self] errorMsg in
            guard let self else { return }
            self.receiveASRError(errorMsg)
        }

        client.onEmotion = { [weak self] tag in
            guard let self else { return }
            self.latestEmotion = tag
            self.onEmotion?(tag)
        }

        let streamId = try await client.start(config: config)
        return streamId
    }

    /// ASR-client callback entry point. Kept separate so the terminal hand-off is unit-testable
    /// with a fake ASR source without opening a real WebSocket stream.
    func receiveASRError(_ errorMsg: String) {
        asrError = errorMsg
        markDone()
        onASRError?(errorMsg)
    }

    /// 等待 ASR 完成（isFinal 或 error），带超时保护。
    ///
    /// W5：从 `withTaskGroup` race 模式重写为 `withCheckedContinuation` + 独立 timeout Task。
    /// 旧 task group 写法在 swift6 region-based isolation checker 触发 "pattern not understand
    /// Please file a bug" 编译器内部 panic（W3 反思已识别为 SDK 局限）。
    ///
    /// W5 三视角 Review 用户 M1 + 技术 M4 共识发现 race regression：旧 task group 写法在 race
    /// 完成的瞬间 `cancelAll()` 立即取消 timeout child task；新模式如果不显式 cancel，timeout
    /// Task 会跑满 5s 才退出，期间 `doneContinuation` 字段已被新一轮 `awaitDone` 改写——会出现
    /// 跨实例错误 resume 新 continuation 的 race window（用户 5s 内连续"停录-新录-停录"触发概率非零）。
    ///
    /// 修复：用 `timeoutTask` 字段持有当前 timeout Task 引用，`markDone()` / 下一次 `awaitDone()`
    /// 入口 / `cleanup()` / `reset()` 都先 `cancel()` 再创建新 task；timeout closure 内
    /// `Task.isCancelled` 检查避免误 resume。语义恢复到旧 task group `cancelAll()` 等价 +
    /// runtime 行为：5s 超时 / 完成事件优先返回 + 早完成立即取消 timer。
    func awaitDone(timeout: TimeInterval = 5) async {
        if isASRDone { return }

        // 关键：清理上一轮可能仍在 sleep 的 timeout task，避免它 5s 后误 resume 新 continuation
        timeoutTask?.cancel()
        timeoutTask = nil

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if self.isASRDone {
                continuation.resume()
                return
            }
            self.doneContinuation = continuation
            // timeout 兜底：到点后若 continuation 还未被 markDone() 消费，主动 resume 防止永久挂起。
            // `Task.isCancelled` 检查避免被 markDone()/下轮 awaitDone() cancel 后误 resume。
            self.timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled, let self else { return }
                if let pending = self.doneContinuation {
                    self.doneContinuation = nil
                    self.timeoutTask = nil
                    pending.resume()
                }
            }
        }
    }

    func sendAudio(_ data: Data) {
        asrClient?.sendAudio(data)
    }

    func stopASR() {
        asrClient?.stop()
    }

    func cleanup() {
        timeoutTask?.cancel()
        timeoutTask = nil
        if let cont = doneContinuation {
            doneContinuation = nil
            cont.resume()
        }
        asrClient?.cleanup()
        asrClient = nil
    }

    func reset() {
        timeoutTask?.cancel()
        timeoutTask = nil
        transcribedText = ""
        isASRDone = false
        asrError = nil
        latestEmotion = nil
        doneContinuation = nil
        onASRError = nil
    }

    private func markDone() {
        isASRDone = true
        // 早完成立即取消 timeout task，避免它 5s 后误 resume 跨实例 continuation（W5 review M1/M4 race fix）
        timeoutTask?.cancel()
        timeoutTask = nil
        if let cont = doneContinuation {
            doneContinuation = nil
            cont.resume()
        }
    }

    // MARK: - Preconnect

    private static var _preconnected: VoiceRecordingSession?
    private static var _preconnectedScenario: VoiceConfig.Scenario?
    private static var _preconnectTask: Task<Void, Never>?
    private static var _preconnectCleanupTask: Task<Void, Never>?

    /// 预连接 ASR。在用户按下麦克风时调用，提前建立 ASR 通道和预热音频会话。
    /// AI 数据共享同意必须先于任何音频上行；未同意时直接拒绝。
    @MainActor
    static func preconnect(config: VoiceConfig) {
        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            logger.info("Skip ASR preconnect: AI data sharing consent missing")
            return
        }
        guard _preconnected == nil, _preconnectTask == nil else { return }
        _preconnectedScenario = config.scenario

        _preconnectCleanupTask?.cancel()

        _preconnectTask = Task {
            let session = VoiceRecordingSession()

            async let audioPrep: Void = {
                try? await AudioRecordingService.shared.prepareSession()
            }()

            var asrOk = false
            do {
                _ = try await session.startASR(config: config)
                asrOk = true
            } catch {
                logger.warning("Preconnect ASR failed: \(error.localizedDescription)")
            }

            _ = await audioPrep

            guard !Task.isCancelled else {
                _ = VoiceRecordingTerminationCoordinator.cancelPreconnectedSession(
                    stopASR: { session.stopASR() },
                    cleanupASR: { session.cleanup() },
                    cancelAudio: { await AudioRecordingService.shared.cancelRecording() }
                )
                _preconnectTask = nil
                return
            }

            _preconnectTask = nil

            if asrOk {
                _preconnected = session
                _preconnectCleanupTask = Task {
                    try? await Task.sleep(for: .seconds(8))
                    guard !Task.isCancelled else { return }
                    cancelPreconnect()
                }
            } else {
                session.cleanup()
                _ = VoiceRecordingTerminationCoordinator.cancelPreconnectedSession(
                    cancelAudio: { await AudioRecordingService.shared.cancelRecording() }
                )
            }
        }
    }

    /// 消费预连接的 session。仅当场景匹配时返回，防止跨场景污染。
    static func consumePreconnected(for scenario: VoiceConfig.Scenario) -> VoiceRecordingSession? {
        guard _preconnectedScenario == scenario else { return nil }
        _preconnectCleanupTask?.cancel()
        _preconnectCleanupTask = nil
        _preconnectedScenario = nil
        let session = _preconnected
        _preconnected = nil
        return session
    }

    /// 取消正在进行或已完成的预连接。
    static func cancelPreconnect() {
        _preconnectTask?.cancel()
        _preconnectTask = nil
        _preconnectCleanupTask?.cancel()
        _preconnectCleanupTask = nil
        _preconnectedScenario = nil
        let session = _preconnected
        _preconnected = nil
        _ = VoiceRecordingTerminationCoordinator.cancelPreconnectedSession(
            stopASR: { session?.stopASR() },
            cleanupASR: { session?.cleanup() },
            cancelAudio: { await AudioRecordingService.shared.cancelRecording() }
        )
    }
}
