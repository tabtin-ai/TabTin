import Foundation
import os

/// ASR 流式识别客户端，通过 Gateway WebSocket 与后端 ASR 服务通信。
///
/// 协议流程：
///   1. 发送 `asr.stream.start` → 收到 `asr.stream.started`（含 stream_id）
///   2. 发送 `asr.stream.audio`（base64 音频块） → 收到 `asr.stream.event`（实时文本）
///   3. 发送 `asr.stream.stop` → 收到 `asr.stream.done`（最终文本）
@MainActor
final class ASRStreamClient {
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ASRStream")
    private let ws = RealtimeGateway.shared

    private var streamId: String?
    private var handlerKey = "asr_stream_\(UUID().uuidString)"
    private var startContinuation: CheckedContinuation<String, Error>?
    private var startTimeoutTask: Task<Void, Never>?
    private var staleWatchdog: Task<Void, Never>?
    private var isActive = false
    private var lastEventTime = Date()

    /// 无事件超时阈值（秒）。超过此时长未收到任何 ASR 事件则视为连接断开。
    private let staleTimeoutSeconds: TimeInterval = 30

    /// 文本回调 (text, isFinal)
    var onTranscript: ((String, Bool) -> Void)?
    /// 错误回调
    var onError: ((String) -> Void)?
    /// 情绪回调 (emotion tag, emoji)
    var onEmotion: ((ASREmotionTag) -> Void)?

    // MARK: - Public API

    func start(config: VoiceConfig) async throws -> String {
        guard !isActive else { throw ASRError.alreadyActive }

        let wsReady = await ws.ensureConnected(timeout: 10)
        guard wsReady else { throw ASRError.wsNotConnected }

        registerHandler()

        let streamId: String = try await withCheckedThrowingContinuation { continuation in
            self.startContinuation = continuation

            let deviceId = KeychainService.shared.getOrCreateDeviceId()
            let wsId = WorkspaceStore.shared.selectedOrganizationId ?? ""
            let payload = config.buildASRPayload()

            let envelope = WSEnvelope.build(
                type: "asr.stream.start",
                deviceId: deviceId,
                payload: payload,
                organizationId: wsId
            )
            ws.sendASR(envelope)

            startTimeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                guard let self, let cont = self.startContinuation else { return }
                self.startContinuation = nil
                cont.resume(throwing: ASRError.startTimeout)
                self.cleanup()
            }
        }

        startTimeoutTask?.cancel()
        startTimeoutTask = nil

        self.streamId = streamId
        self.isActive = true
        self.lastEventTime = Date()
        startStaleWatchdog()
        logger.info("ASR stream started: \(streamId)")
        return streamId
    }

    func sendAudio(_ data: Data) {
        guard let streamId, isActive else {
            logger.debug("sendAudio dropped: streamId=\(self.streamId ?? "nil"), active=\(self.isActive)")
            return
        }

        let base64 = data.base64EncodedString()
        let deviceId = KeychainService.shared.getOrCreateDeviceId()
        let wsId = WorkspaceStore.shared.selectedOrganizationId ?? ""

        let envelope = WSEnvelope.build(
            type: "asr.stream.audio",
            deviceId: deviceId,
            payload: [
                "stream_id": streamId,
                "data": base64,
            ],
            organizationId: wsId
        )
        ws.sendASR(envelope)
    }

    func stop() {
        guard let streamId, isActive else { return }

        let deviceId = KeychainService.shared.getOrCreateDeviceId()
        let wsId = WorkspaceStore.shared.selectedOrganizationId ?? ""

        let envelope = WSEnvelope.build(
            type: "asr.stream.stop",
            deviceId: deviceId,
            payload: ["stream_id": streamId],
            organizationId: wsId
        )
        ws.sendASR(envelope)
        logger.info("ASR stream stop sent: \(streamId)")
    }

    func cleanup() {
        isActive = false
        streamId = nil
        startTimeoutTask?.cancel()
        startTimeoutTask = nil
        staleWatchdog?.cancel()
        staleWatchdog = nil
        ws.removeEnvelopeListener(key: handlerKey)
        onTranscript = nil
        onError = nil
        onEmotion = nil

        if let cont = startContinuation {
            startContinuation = nil
            cont.resume(throwing: ASRError.cancelled)
        }
    }

    // MARK: - WebSocket Handler

    private func registerHandler() {
        ws.addEnvelopeListener(key: handlerKey) { [weak self] envelope in
            self?.handleEnvelope(envelope)
        }
    }

    private func handleEnvelope(_ envelope: WSEnvelope) {
        lastEventTime = Date()

        switch envelope.type {
        case "asr.stream.started":
            if let sid = envelope.payloadString("stream_id"),
               let cont = startContinuation {
                startContinuation = nil
                cont.resume(returning: sid)
            }

        case "asr.stream.event":
            guard let sid = envelope.payloadString("stream_id"),
                  sid == streamId else { return }
            let text = envelope.payloadString("text") ?? ""
            onTranscript?(text, false)
            extractEmotionFromPayload(envelope)

        case "asr.stream.done":
            guard let sid = envelope.payloadString("stream_id"),
                  sid == streamId else { return }
            let text = envelope.payloadString("text") ?? ""
            onTranscript?(text, true)
            extractEmotionFromPayload(envelope)
            isActive = false
            staleWatchdog?.cancel()
            staleWatchdog = nil
            ws.removeEnvelopeListener(key: handlerKey)

        case "asr.stream.error":
            guard let sid = envelope.payloadString("stream_id"),
                  sid == streamId else { return }
            let errorMsg = envelope.payloadString("error") ?? "语音识别暂时不可用，请稍后重试"
            logger.error("ASR error: \(errorMsg)")
            onError?(errorMsg)
            isActive = false
            staleWatchdog?.cancel()
            staleWatchdog = nil
            ws.removeEnvelopeListener(key: handlerKey)

        default:
            break
        }
    }

    // MARK: - Stale Stream Watchdog

    /// 长录音场景下，如果后端连接静默断开，定期检测是否有事件到达。
    private func startStaleWatchdog() {
        staleWatchdog?.cancel()
        staleWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self, self.isActive else { break }
                let elapsed = Date().timeIntervalSince(self.lastEventTime)
                if elapsed >= self.staleTimeoutSeconds {
                    self.logger.warning("ASR stream stale for \(Int(elapsed))s, triggering error")
                    self.onError?("语音识别暂时不可用，请稍后重试")
                    self.isActive = false
                    self.staleWatchdog = nil
                    self.ws.removeEnvelopeListener(key: self.handlerKey)
                    break
                }
            }
        }
    }

    // MARK: - Emotion Extraction

    /// 从 ASR 响应的 utterances.additions.emotion 中提取情绪标签。
    /// 优先从 definite 分句中提取（准确率高），流式中间结果也可提取（响应及时）。
    private func extractEmotionFromPayload(_ envelope: WSEnvelope) {
        guard let utterances = envelope.payload["utterances"]?.arrayValue else { return }

        var bestEmotion: ASREmotionTag?

        for utt in utterances {
            guard let uttDict = utt as? [String: Any],
                  let additions = uttDict["additions"] as? [String: Any],
                  let emotionStr = additions["emotion"] as? String,
                  let tag = ASREmotionTag(rawValue: emotionStr) else {
                continue
            }
            let isDefinite = (uttDict["definite"] as? Bool) ?? false
            if isDefinite {
                onEmotion?(tag)
                return
            }
            bestEmotion = tag
        }

        if let emotion = bestEmotion {
            onEmotion?(emotion)
        }
    }
}

enum ASRError: LocalizedError {
    case alreadyActive
    case wsNotConnected
    case startTimeout
    case cancelled

    var errorDescription: String? {
        switch self {
        case .alreadyActive: return "语音识别已在进行中"
        case .wsNotConnected: return "实时连接不可用，请稍后重试"
        case .startTimeout: return "语音识别连接超时，请稍后重试"
        case .cancelled: return "语音识别已取消"
        }
    }
}
