import CoreGraphics
import Foundation
import SwiftUI
import UIKit

/// 胶囊长按语音（PTT）手势阈值：按住 520ms 起录，上滑 56pt 取消，水平抖动 12pt 忽略。
enum CapsuleHoldToTalkMetrics {
    static let holdDurationMs: Int = 520
    static let cancelDistance: CGFloat = 56
    static let jitterTolerance: CGFloat = 12
    /// 菜单选「语音」后先收菜单再出 HUD，避免双层叠影。
    static let menuVoiceHandoffDelayMs: Int = 180
}

enum CapsuleHoldToTalkPhase: Equatable, Sendable {
    case idle
    case pressing
    case awaitingConsent
    case awaitingMicrophone
    case recording
    case cancelling
    case processing
    case readyToSubmit
    case blocked(reason: String)
}

enum CapsuleHoldToTalkEvent: Equatable, Sendable {
    case pressBegan
    case pressHeld(elapsedMs: Int)
    case fingerMoved(dx: CGFloat, dy: CGFloat)
    case pressEnded
    case systemCancelled
    case consentRequired
    case consentGrantedFirstTime
    case consentAlreadyGranted
    case microphoneDenied
    case microphoneGranted
    case transcriptReady(String)
    case submitBlocked(reason: String)
    case reset
}

/// 松手瞬间根据松手前相位决定：轻点回对话 / 提交录音 / 取消 / 忽略。
enum CapsuleHoldToTalkPointerOutcome: Equatable, Sendable {
    case tap
    case submitRecording
    case cancel
    case ignore

    static func resolve(phaseBeforeEnd: CapsuleHoldToTalkPhase) -> Self {
        switch phaseBeforeEnd {
        case .pressing:
            return .tap
        case .recording, .processing:
            return .submitRecording
        case .cancelling:
            return .cancel
        case .idle, .awaitingConsent, .awaitingMicrophone, .readyToSubmit, .blocked:
            return .ignore
        }
    }
}

/// 纯 reducer：不持有 ASR session；由 ConversationScreen 持有本状态机与生命周期。
struct CapsuleHoldToTalkReducer: Equatable, Sendable {
    private(set) var phase: CapsuleHoldToTalkPhase = .idle
    private(set) var commandId: String?
    private(set) var recoverableTranscript: String?
    private(set) var requiresFreshPressAfterConsent = false
    private(set) var frozenFocus: FocusSnapshot?

    mutating func handle(_ event: CapsuleHoldToTalkEvent) {
        switch event {
        case .reset:
            phase = .idle
            commandId = nil
            recoverableTranscript = nil
            frozenFocus = nil
            return

        case .consentRequired:
            phase = .awaitingConsent
            requiresFreshPressAfterConsent = true
            return

        case .consentGrantedFirstTime:
            // 首次授权后必须重新按住，不自动续录。
            phase = .idle
            requiresFreshPressAfterConsent = true
            commandId = nil
            return

        case .consentAlreadyGranted:
            requiresFreshPressAfterConsent = false
            return

        case .microphoneDenied:
            phase = .idle
            requiresFreshPressAfterConsent = true
            return

        case .microphoneGranted:
            if phase == .awaitingMicrophone {
                phase = .pressing
            }
            return

        case .pressBegan:
            guard !requiresFreshPressAfterConsent || phase == .idle else {
                // 授权/麦克风弹窗刚结束：忽略残留 touch，等待新一轮按住。
                return
            }
            phase = .pressing
            commandId = UUID().uuidString.lowercased()
            // 失败后的 recoverableTranscript 保留到真正开录；开录时再清。
            frozenFocus = nil
            return

        case let .pressHeld(elapsedMs):
            guard phase == .pressing, elapsedMs >= CapsuleHoldToTalkMetrics.holdDurationMs else { return }
            phase = .recording
            recoverableTranscript = nil
            return

        case let .fingerMoved(dx, dy):
            switch phase {
            case .recording, .cancelling:
                let armed = abs(dx) <= CapsuleHoldToTalkMetrics.jitterTolerance
                    && dy <= -CapsuleHoldToTalkMetrics.cancelDistance
                phase = armed ? .cancelling : .recording
            default:
                break
            }
            return

        case .pressEnded:
            switch phase {
            case .recording:
                phase = .processing
            case .pressing, .cancelling, .awaitingConsent, .awaitingMicrophone:
                phase = .idle
                commandId = nil
            default:
                break
            }
            return

        case .systemCancelled:
            // 来电 / 退后台：清空命令与冻结 Focus，松手不得再走 submit。
            phase = .idle
            commandId = nil
            frozenFocus = nil
            return

        case let .transcriptReady(text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            recoverableTranscript = trimmed.isEmpty ? nil : trimmed
            if phase == .processing || phase == .recording {
                phase = trimmed.isEmpty ? .idle : .readyToSubmit
            }
            return

        case let .submitBlocked(reason):
            phase = .blocked(reason: reason)
            return
        }
    }

    mutating func freezeFocus(_ snapshot: FocusSnapshot) {
        // 仅在进入录音时冻结；之后不再覆盖。
        guard phase == .recording, frozenFocus == nil else { return }
        frozenFocus = snapshot
    }
}

/// 会话级胶囊语音控制器：PTT reducer + ASR 生命周期；不随胶囊形态切换销毁。
@MainActor
@Observable
final class CapsuleVoiceCommandController {
    private(set) var reducer = CapsuleHoldToTalkReducer()
    private let recorder = VoiceRecordingController()

    private var touchActive = false
    private var pressStartedAt: Date?
    private var holdTickTask: Task<Void, Never>?
    private var didStartRecorder = false
    /// preparing / start 任务世代：松手后废止迟到的 startRecorderIfNeeded。
    private var recorderStartGeneration = 0
    private var ignoreTouchUntilLift = false
    /// 来电 / 退后台后置位：禁止随后的 pointerEnded 仍走 finishCaptureAndSubmit。
    private var suppressSubmitAfterSystemCancel = false
    /// Latch 录音中是否已进入「控制指」按住（用于区分虚假 pointerEnded）。
    private var latchedControlPressActive = false
    /// deinit 需非隔离访问；observer 仅在 init/deinit 读写。
    nonisolated(unsafe) private var lifecycleObservers: [NSObjectProtocol] = []

    var phase: CapsuleHoldToTalkPhase { reducer.phase }
    var recoverableTranscript: String? { reducer.recoverableTranscript }
    var frozenFocus: FocusSnapshot? { reducer.frozenFocus }
    var requiresFreshPressAfterConsent: Bool { reducer.requiresFreshPressAfterConsent }
    /// 录音中的实时 ASR 文本；供 Voice HUD 展示。
    private(set) var liveTranscript: String = ""
    /// 按住未达阈值：显示 hold-progress 描边。
    var isPressingVisually: Bool { phase == .pressing }
    var isRecordingVisually: Bool {
        switch phase {
        case .recording, .processing, .cancelling: return true
        default: return false
        }
    }
    var isCancelArmed: Bool { phase == .cancelling }
    /// 菜单选语音后的 latch 会话：无指按住；取消 / 发送由 HUD 按钮（或 a11y）完成。
    private(set) var isLatchedFromMenu = false
    /// 菜单已选语音、HUD 尚未接手（宿主延时交接中）。
    private(set) var isMenuVoiceHandoffPending = false
    /// 录音中锁定胶囊短按 / 拖拽 / 菜单；不再劫持指针做上滑取消。
    var isVoiceControlSessionActive: Bool {
        isLatchedFromMenu && (isRecordingVisually || phase == .processing)
    }
    /// HUD 展示「取消」「发送」显式按钮（菜单 latch / a11y 起录）。
    var showsVoiceActionButtons: Bool {
        isLatchedFromMenu && (phase == .recording || phase == .cancelling)
    }
    /// Voice HUD 是否应浮在胶囊上方（含取消瞬间）；菜单交接期间抑制，避免双层。
    var showsVoiceHud: Bool {
        if isMenuVoiceHandoffPending { return false }
        switch phase {
        case .pressing, .recording, .cancelling, .processing:
            return true
        default:
            return false
        }
    }

    var onNeedsConsent: (() -> Void)?
    var onTap: (() -> Void)?
    var onReadyToSubmit: ((String, FocusSnapshot?) -> Void)?
    var onFreezeFocus: (() -> FocusSnapshot?)?
    var onNotice: ((String) -> Void)?
    /// 胶囊迷你文字条：发送走会话入队；返回硬门闩文案（离线 / 无权限等）。
    var textComposerDisabledReason: (() -> String?)?
    /// 迷你文字条发送；调用方负责门禁与入队，成功后应 dismiss。
    var onTextSend: ((String) -> Void)?

    /// 菜单选「文字」后展开迷你输入条。
    private(set) var isTextComposerPresented = false

    init() {
        startLifecycleMonitoring()
    }

    deinit {
        for observer in lifecycleObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func handle(_ event: CapsuleHoldToTalkEvent) {
        let previous = phase
        reducer.handle(event)
        if previous != .recording, phase == .recording {
            Task { await startRecorderIfNeeded() }
        }
    }

    func freezeFocus(_ snapshot: FocusSnapshot) {
        reducer.freezeFocus(snapshot)
    }

    func reset() {
        holdTickTask?.cancel()
        holdTickTask = nil
        pressStartedAt = nil
        didStartRecorder = false
        recorderStartGeneration += 1
        touchActive = false
        ignoreTouchUntilLift = false
        suppressSubmitAfterSystemCancel = false
        isLatchedFromMenu = false
        isMenuVoiceHandoffPending = false
        latchedControlPressActive = false
        liveTranscript = ""
        recorder.onTranscriptUpdate = nil
        reducer.handle(.reset)
        Task { await recorder.cancelRecording() }
    }

    /// 发送失败：保留可恢复 transcript，供用户再次按住重试。
    func noteSubmitFailed(reason: String) {
        let transcript = recoverableTranscript
        reducer.handle(.submitBlocked(reason: reason))
        if let transcript {
            reducer.handle(.transcriptReady(transcript))
        }
        onNotice?(reason)
    }

    func noteConsentGrantedFirstTime() {
        ignoreTouchUntilLift = touchActive
        handle(.consentGrantedFirstTime)
        onNotice?(L10n.Privacy.aiVoiceConsentHoldAgain)
    }

    // MARK: - Pointer

    func pointerChanged(translation: CGSize) {
        if ignoreTouchUntilLift {
            return
        }
        // Latch 录音中：下一轮指落只控制取消/提交，不再走 520ms 起录。
        if isLatchedFromMenu, phase == .recording || phase == .cancelling {
            if !touchActive {
                touchActive = true
                latchedControlPressActive = true
                return
            }
            handle(.fingerMoved(dx: translation.width, dy: translation.height))
            return
        }
        if !touchActive {
            touchActive = true
            beginPress()
            return
        }
        handle(.fingerMoved(dx: translation.width, dy: translation.height))
    }

    func pointerEnded() {
        holdTickTask?.cancel()
        holdTickTask = nil
        let staleTouch = ignoreTouchUntilLift
        let blockedBySystem = suppressSubmitAfterSystemCancel
        ignoreTouchUntilLift = false
        suppressSubmitAfterSystemCancel = false
        let phaseBefore = phase
        let outcome = CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: phaseBefore)
        let hadLatchedControl = latchedControlPressActive
        touchActive = false
        latchedControlPressActive = false
        pressStartedAt = nil

        if staleTouch || blockedBySystem {
            if blockedBySystem {
                Task { await cancelCapture() }
            }
            return
        }

        // Latch 录音中尚未进入控制指：忽略虚假 ended，继续等轻点/上滑。
        if isLatchedFromMenu, !hadLatchedControl,
           phaseBefore == .recording || phaseBefore == .cancelling || phaseBefore == .processing {
            return
        }

        handle(.pressEnded)

        switch outcome {
        case .tap:
            reset()
            onTap?()
        case .cancel:
            isLatchedFromMenu = false
            Task { await cancelCapture() }
        case .submitRecording:
            isLatchedFromMenu = false
            Task { await finishCaptureAndSubmit() }
        case .ignore:
            if phaseBefore == .awaitingConsent {
                // 同意流程中松手：不回对话、不录音。
                break
            }
            Task { await recorder.cancelRecording() }
            didStartRecorder = false
        }
    }

    func pointerCancelled() {
        holdTickTask?.cancel()
        holdTickTask = nil
        touchActive = false
        ignoreTouchUntilLift = false
        pressStartedAt = nil
        suppressSubmitAfterSystemCancel = true
        handle(.systemCancelled)
        Task { await cancelCapture() }
    }

    /// 来电 / 退后台：录音中强制 systemCancelled，避免松手仍提交。
    private func startLifecycleMonitoring() {
        let center = NotificationCenter.default
        let resign = center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleLifecycleInterruption()
            }
        }
        let background = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleLifecycleInterruption()
            }
        }
        lifecycleObservers = [resign, background]
    }

    private func handleLifecycleInterruption() {
        switch phase {
        case .pressing, .recording, .cancelling, .processing, .awaitingMicrophone:
            onNotice?("录音已中断，请重新按住说话")
            pointerCancelled()
        default:
            break
        }
    }

    // MARK: - Accessibility / Menu

    /// VoiceOver「开始语音指令」：走真实同意门禁 + 合法录音生命周期。
    /// 不伪造 consentAlreadyGranted 后立刻结束录音；第二次激活同一操作则提交。
    func beginAccessibilityVoiceCommand() {
        if phase == .recording || phase == .processing {
            submitAccessibilityVoiceCommand()
            return
        }
        isLatchedFromMenu = true
        beginVoiceCaptureSkippingHoldThreshold()
        // a11y 起录后无指按住，与菜单 latch 同语义。
        touchActive = false
    }

    /// VoiceOver / TalkBack「结束并发送」。
    func submitAccessibilityVoiceCommand() {
        guard phase == .recording || phase == .processing || phase == .cancelling else { return }
        ignoreTouchUntilLift = false
        suppressSubmitAfterSystemCancel = false
        // 若停在取消区，先回到 recording 再提交。
        if phase == .cancelling {
            handle(.fingerMoved(dx: 0, dy: 0))
        }
        touchActive = true
        latchedControlPressActive = true
        pointerEnded()
    }

    /// VoiceOver / TalkBack「取消语音」。
    func cancelAccessibilityVoiceCommand() {
        guard isRecordingVisually || phase == .processing else { return }
        isLatchedFromMenu = false
        Task { await cancelCapture() }
    }

    /// 菜单列已选「语音」：先抑制 HUD，等宿主收完菜单再 `completeMenuVoiceHandoff()`。
    func beginMenuVoiceHandoff() {
        guard phase != .recording, phase != .processing, phase != .cancelling else { return }
        dismissTextComposer()
        isMenuVoiceHandoffPending = true
    }

    /// 菜单退场后进入录音；latch 等待控制手势或 a11y 提交/取消。
    func completeMenuVoiceHandoff() {
        guard isMenuVoiceHandoffPending else { return }
        isMenuVoiceHandoffPending = false
        beginVoiceCommandFromMenu()
    }

    /// 长按菜单选「语音」：跳过胶囊本体 520ms 按住阈值，直接走同意门禁后录音。
    /// 录音中由 HUD「取消 / 发送」或 a11y 动作收尾（不再上滑取消）。
    func beginVoiceCommandFromMenu() {
        guard phase != .recording, phase != .processing, phase != .cancelling else { return }
        dismissTextComposer()
        isMenuVoiceHandoffPending = false
        isLatchedFromMenu = true
        beginVoiceCaptureSkippingHoldThreshold()
        // 菜单松手后无指按住；取消 / 发送走按钮，不依赖下一轮指针。
        touchActive = false
    }

    /// 长按菜单选「文字」：展开贴底迷你输入条，不跳整页对话。
    func presentTextComposer() {
        guard !isTextComposerPresented else { return }
        isTextComposerPresented = true
    }

    func dismissTextComposer() {
        isTextComposerPresented = false
    }

    func submitTextComposer(_ text: String) {
        onTextSend?(text)
    }

    func resolvedTextComposerDisabledReason() -> String? {
        textComposerDisabledReason?()
    }

    /// 跳过 pressing→520ms，授权后直接进入 recording。
    private func beginVoiceCaptureSkippingHoldThreshold() {
        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            handle(.consentRequired)
            onNeedsConsent?()
            return
        }
        handle(.consentAlreadyGranted)
        touchActive = true
        ignoreTouchUntilLift = false
        suppressSubmitAfterSystemCancel = false
        handle(.pressBegan)
        pressStartedAt = Date()
        enterRecordingAfterConsentGate()
    }

    // MARK: - Private session

    /// 指落只进 pressing；短点回对话，不弹同意框。同意检查推迟到 ≥520ms 长按路径。
    private func beginPress() {
        handle(.pressBegan)
        pressStartedAt = Date()
        startHoldTicker()
    }

    private func startHoldTicker() {
        holdTickTask?.cancel()
        holdTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(40))
                guard let self, !Task.isCancelled else { return }
                guard let started = self.pressStartedAt, self.touchActive else { return }
                let elapsed = Int(Date().timeIntervalSince(started) * 1000)
                if elapsed >= CapsuleHoldToTalkMetrics.holdDurationMs, self.phase == .pressing {
                    self.enterRecordingAfterConsentGate()
                    return
                }
                self.handle(.pressHeld(elapsedMs: elapsed))
                if self.phase == .recording
                    || self.phase == .cancelling
                    || self.phase == .awaitingConsent {
                    return
                }
            }
        }
    }

    /// 进入录音前的同意门禁：仅长按阈值到达或明确 Voice 操作时调用。
    private func enterRecordingAfterConsentGate() {
        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            handle(.consentRequired)
            ignoreTouchUntilLift = true
            onNeedsConsent?()
            return
        }
        handle(.consentAlreadyGranted)
        handle(.pressHeld(elapsedMs: CapsuleHoldToTalkMetrics.holdDurationMs))
    }

    private func startRecorderIfNeeded() async {
        guard phase == .recording, !didStartRecorder else { return }
        didStartRecorder = true
        recorderStartGeneration += 1
        let generation = recorderStartGeneration
        if let focus = onFreezeFocus?() {
            freezeFocus(focus)
        }
        liveTranscript = ""
        recorder.voiceConfig = .chat()
        recorder.onTranscriptUpdate = { [weak self] text in
            self?.liveTranscript = text
        }
        await recorder.startRecording()
        // 松手 / cancel 已抬 generation：不得把迟到的 preparing 完成当成有效录音。
        guard generation == recorderStartGeneration else {
            recorder.onTranscriptUpdate = nil
            await recorder.cancelRecording()
            didStartRecorder = false
            return
        }
        guard phase == .recording || phase == .processing else {
            recorder.onTranscriptUpdate = nil
            await recorder.cancelRecording()
            didStartRecorder = false
            return
        }
        if recorder.isPermissionError {
            didStartRecorder = false
            recorder.onTranscriptUpdate = nil
            liveTranscript = ""
            handle(.microphoneDenied)
            ignoreTouchUntilLift = true
            onNotice?("需要麦克风权限才能语音发指令")
            await recorder.cancelRecording()
        }
    }

    private func cancelCapture() async {
        didStartRecorder = false
        recorderStartGeneration += 1
        recorder.onTranscriptUpdate = nil
        liveTranscript = ""
        await recorder.cancelRecording()
        handle(.reset)
    }

    private func finishCaptureAndSubmit() async {
        if suppressSubmitAfterSystemCancel {
            await cancelCapture()
            return
        }
        // 废止尚未完成的 preparing start；stopRecording 在 preparing 时会取消后续 start。
        recorderStartGeneration += 1
        if didStartRecorder {
            await recorder.stopRecording()
        }
        let text = recorder.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
        didStartRecorder = false
        recorder.onTranscriptUpdate = nil
        if !text.isEmpty {
            liveTranscript = text
        }
        if text.isEmpty {
            liveTranscript = ""
            handle(.transcriptReady(""))
            handle(.reset)
            onNotice?("没有识别到文字")
            return
        }
        handle(.transcriptReady(text))
        guard let focus = frozenFocus else {
            // Focus 静默丢失：保留 transcript，要求重新按住；禁止 live fallback。
            noteSubmitFailed(reason: "焦点已失效，请重新按住说话")
            return
        }
        onReadyToSubmit?(text, focus)
        // 提交后收起 HUD；可恢复文案仍留在 reducer。
        liveTranscript = ""
    }
}

// MARK: - Gesture

struct CapsuleHoldToTalkPointerGesture: ViewModifier {
    let controller: CapsuleVoiceCommandController

    func body(content: Content) -> some View {
        content
            .simultaneousGesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { value in
                        controller.pointerChanged(translation: value.translation)
                    }
                    .onEnded { _ in
                        controller.pointerEnded()
                    }
            )
    }
}

extension View {
    func capsuleHoldToTalk(_ controller: CapsuleVoiceCommandController) -> some View {
        modifier(CapsuleHoldToTalkPointerGesture(controller: controller))
    }
}
