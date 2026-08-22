@preconcurrency import AVFoundation
import Foundation
import os

/// 线程安全的写入错误计数器，用于在音频引擎的 tap 回调（非 actor 线程）中安全访问。
///
/// **`@unchecked Sendable` 论证粒度**（W4 续作 #L88 注释精确化）：本 class 是 **真跨线程
/// 并发访问** 模式 —— audio engine inputNode tap callback 在 audio thread 触发 increment() /
/// fireCallback()；同时 actor AudioRecordingService 内部从 actor 线程 reset() / setCallback() /
/// cleanup() —— 真两条线程同时访问 _count / _callback。所以**必须用 `NSLock` 显式锁**，
/// `@unchecked Sendable` 是真跨线程并发安全的标注。
///
/// 与同文件 `ConsumeFlag` 的区别（重要！避免后续 reviewer 误以为 ConsumeFlag 也需要锁）：
/// - **WriteErrorState（本类）**：跨线程并发 → NSLock + @unchecked Sendable + 加锁访问
/// - **ConsumeFlag**（同文件下方定义；用符号引用避免行号 stale）：单线程串行 → @unchecked
///   Sendable 不加锁；运行时安全靠 "converter.convert 同步调用约定" 保证
///
/// 两者都用 `@unchecked Sendable` 但实际并发模式完全不同；论证粒度（W2b 技术 Review 必修
/// #2 教训）必须对齐**具体调度约定**，不能笼统说"thread-safe"。
private final class WriteErrorState: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    private var _callback: (@Sendable () -> Void)?

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return _count
    }

    func increment() -> Int {
        lock.lock()
        _count += 1
        let c = _count
        lock.unlock()
        return c
    }

    func reset() {
        lock.lock()
        _count = 0
        lock.unlock()
    }

    func setCallback(_ cb: (@Sendable () -> Void)?) {
        lock.lock()
        _callback = cb
        lock.unlock()
    }

    func fireCallback() {
        lock.lock()
        let cb = _callback
        lock.unlock()
        cb?()
    }

    func cleanup() {
        lock.lock()
        _count = 0
        _callback = nil
        lock.unlock()
    }
}

/// 单次消费标志的 reference type wrap。
///
/// 用途：把 `var consumed = false` 这种 local mutable Bool 升级成 reference type，
/// 让 `@Sendable` closure 可以 capture（Swift 6 严检不允许 capture mutable var）。
///
/// 线程安全约定：访问发生在 `converter.convert(to:error:withInputFrom:)` 的同步 input
/// block 内——converter.convert 是同步函数，同一线程串行调用 input block，**无跨线程
/// 并发访问**。`@unchecked Sendable` 仅绕 Swift 6 var 隔离检查，运行时安全靠"converter
/// 同步调用约定"保证，与 W2b 反思 §6 `nonisolated(unsafe) var debounceTimer` 论证粒度
/// 一致（main thread 单线程访问约定 / converter 同步调用单线程约定）。
private final class ConsumeFlag: @unchecked Sendable {
    var value: Bool = false
}

/// PCM 16-bit mono 录音服务，通过 AVAudioEngine 实时采集音频块。
/// 同时将完整音频写入临时 WAV 文件，供后续 OSS 上传。
actor AudioRecordingService {
    static let shared = AudioRecordingService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "AudioRecording")
    private let engine = AVAudioEngine()
    private let sampleRate: Double = 16000
    /// 目标 chunk 时长（秒），字节 ASR 推荐双向流式 200ms。
    private let targetChunkDuration: Double = 0.2

    private var isRecording = false
    private var audioFileURL: URL?
    private var audioFile: AVAudioFile?
    private var onAudioChunk: (@Sendable (Data) -> Void)?
    private var onLevelUpdate: (@Sendable (Float) -> Void)?

    private nonisolated let writeErrorState = WriteErrorState()
    private static let writeErrorThreshold = 5
    private static let writeErrorFatalThreshold = 10

    private init() {}

    // MARK: - Public

    struct RecordingResult {
        let fileURL: URL
        let duration: TimeInterval
        let fileSize: Int
    }

    private var isSessionPrepared = false

    /// 预热音频会话。可在 ASR 连接期间并行调用，减少后续 startRecording 的延迟。
    func prepareSession() throws {
        guard !isSessionPrepared else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        isSessionPrepared = true
    }

    /// 开始录音。
    /// - `onChunk`: 在音频引擎工作线程调用，传递 PCM 16-bit LE 数据块。**`@Sendable`**：闭包
    ///   会被 audio thread tap callback 真实跨线程使用，必须 Sendable；caller 端用
    ///   `Task { @MainActor in ... }` wrapper 把 audio thread 调用 hop 到 main actor 域
    ///   （prompt §修复模式 B + W2b 步骤 4.5 同款）。
    /// - `onLevel`: 在音频引擎工作线程调用，传递 0.0~1.0 归一化音量值。`@Sendable` 同上。
    /// - `onWriteError`: 磁盘写入连续失败超阈值时回调（可在任意线程调用）。
    func startRecording(
        onChunk: @escaping @Sendable (Data) -> Void,
        onLevel: (@Sendable (Float) -> Void)? = nil,
        onWriteError: (@Sendable () -> Void)? = nil
    ) async throws {
        guard !isRecording else { return }

        if let oldURL = audioFileURL {
            try? FileManager.default.removeItem(at: oldURL)
            audioFileURL = nil
        }

        if !isSessionPrepared {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        }
        isSessionPrepared = false

        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        ) else {
            throw AudioRecordingError.formatUnavailable
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            throw AudioRecordingError.converterUnavailable
        }

        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "memo_voice_\(Int(Date().timeIntervalSince1970)).wav"
        let fileURL = tempDir.appendingPathComponent(fileName)
        let audioFile = try AVAudioFile(
            forWriting: fileURL,
            settings: targetFormat.settings,
            commonFormat: targetFormat.commonFormat,
            interleaved: targetFormat.isInterleaved
        )

        self.audioFileURL = fileURL
        self.audioFile = audioFile
        self.onAudioChunk = onChunk
        self.onLevelUpdate = onLevel
        self.writeErrorState.reset()
        self.writeErrorState.setCallback(onWriteError)
        self.isRecording = true

        let convertBufferCapacity: AVAudioFrameCount = 4096
        let chunkCallback = onChunk
        let levelCallback = onLevel

        let hwBufferSize = AVAudioFrameCount(hwFormat.sampleRate * targetChunkDuration)
        inputNode.installTap(onBus: 0, bufferSize: hwBufferSize, format: hwFormat) { [weak self] buffer, _ in
            guard let self else { return }

            if let levelCallback {
                let level = Self.calculateRMSLevel(buffer: buffer)
                levelCallback(level)
            }

            let convertBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: convertBufferCapacity
            )!

            // converter.convert 是同步函数，但 input block 类型是 `@Sendable`：Swift 6
            // 严检不允许 capture mutable `var consumed`。用 final class wrap 把状态放到
            // reference 类型；converter.convert 同步调用 → 无真正跨线程访问，无需加锁
            // （ConsumeFlag 单线程串行访问约定，与 W2b §6 nonisolated(unsafe) 同款论证）。
            let consumed = ConsumeFlag()
            var error: NSError?
            let status = converter.convert(to: convertBuffer, error: &error) { _, outStatus in
                if !consumed.value {
                    consumed.value = true
                    outStatus.pointee = .haveData
                    return buffer
                }
                outStatus.pointee = .noDataNow
                return nil
            }

            guard status != .error, error == nil, convertBuffer.frameLength > 0 else { return }

            let byteCount = Int(convertBuffer.frameLength) * 2
            let data = Data(bytes: convertBuffer.int16ChannelData![0], count: byteCount)

            do {
                try audioFile.write(from: convertBuffer)
                self.writeErrorState.reset()
            } catch {
                let count = self.writeErrorState.increment()
                self.logger.error("Audio file write failed (\(count)x): \(error.localizedDescription)")
                if count == Self.writeErrorThreshold {
                    self.writeErrorState.fireCallback()
                }
                if count >= Self.writeErrorFatalThreshold {
                    self.logger.error("磁盘写入连续失败 \(count) 次，强制停止录音以防止生成损坏文件")
                    Task { await self.forceStopDueToWriteError() }
                    return
                }
            }
            chunkCallback(data)
        }

        engine.prepare()
        try engine.start()
        logger.info("Recording started, file: \(fileName)")
    }

    /// 磁盘写入连续失败超过致命阈值时，从 tap 回调内触发的强制停止。
    private func forceStopDueToWriteError() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        audioFile = nil
        onAudioChunk = nil
        onLevelUpdate = nil
        writeErrorState.fireCallback()
        writeErrorState.cleanup()
        logger.warning("录音已因磁盘写入失败被强制停止")
    }

    /// 停止录音并返回录音文件信息。
    func stopRecording() async throws -> RecordingResult {
        guard isRecording else { throw AudioRecordingError.notRecording }

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        audioFile = nil
        onAudioChunk = nil
        onLevelUpdate = nil
        writeErrorState.cleanup()

        guard let fileURL = audioFileURL else {
            throw AudioRecordingError.noFileURL
        }

        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let fileSize = (attrs[.size] as? Int) ?? 0

        let asset = AVURLAsset(url: fileURL)
        let duration = try await asset.load(.duration).seconds

        logger.info("Recording stopped, duration: \(duration)s, size: \(fileSize)")
        return RecordingResult(fileURL: fileURL, duration: duration, fileSize: fileSize)
    }

    /// 取消录音，清理临时文件。
    func cancelRecording() {
        if isRecording {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        isRecording = false
        isSessionPrepared = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        if let url = audioFileURL {
            try? FileManager.default.removeItem(at: url)
        }
        audioFile = nil
        audioFileURL = nil
        onAudioChunk = nil
        onLevelUpdate = nil
        writeErrorState.cleanup()
        logger.info("Recording cancelled")
    }

    /// 删除临时录音文件。
    func cleanupFile() {
        if let url = audioFileURL {
            try? FileManager.default.removeItem(at: url)
            audioFileURL = nil
        }
    }

    // MARK: - Level Metering

    /// 从 AVAudioPCMBuffer 计算 RMS 归一化到 0.0~1.0，支持 Float32/Int16/Int32 格式。
    private static func calculateRMSLevel(buffer: AVAudioPCMBuffer) -> Float {
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0.05 }

        var sumOfSquares: Float = 0

        if let channelData = buffer.floatChannelData {
            let samples = channelData[0]
            for i in 0..<count {
                sumOfSquares += samples[i] * samples[i]
            }
        } else if let channelData = buffer.int16ChannelData {
            let samples = channelData[0]
            let scale: Float = 1.0 / Float(Int16.max)
            for i in 0..<count {
                let s = Float(samples[i]) * scale
                sumOfSquares += s * s
            }
        } else if let channelData = buffer.int32ChannelData {
            let samples = channelData[0]
            let scale: Float = 1.0 / Float(Int32.max)
            for i in 0..<count {
                let s = Float(samples[i]) * scale
                sumOfSquares += s * s
            }
        } else {
            return 0.05
        }

        let rms = sqrtf(sumOfSquares / Float(count))
        let db = 20 * log10f(max(rms, 1e-7))
        let minDb: Float = -60
        let normalized = max(0, (db - minDb) / -minDb)
        return min(normalized, 1.0)
    }
}

enum AudioRecordingError: LocalizedError {
    case formatUnavailable
    case converterUnavailable
    case notRecording
    case noFileURL
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .formatUnavailable: return "当前设备音频格式不可用"
        case .converterUnavailable: return "音频转换器初始化失败"
        case .notRecording: return "当前没有正在进行的录音"
        case .noFileURL: return "录音文件不存在"
        case .permissionDenied: return "请在系统设置中允许 TabTin 使用麦克风"
        }
    }
}
