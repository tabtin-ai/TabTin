import AVFoundation
import os
import SwiftUI

private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ChatVoiceInput")

func shouldInterruptVoiceOverlayAfterPermissionRequest(
    permissionWasUndetermined: Bool,
    permissionIsGranted: Bool
) -> Bool {
    permissionWasUndetermined && permissionIsGranted
}

struct ChatVoiceInputOverlay: View {
    @Binding var isPresented: Bool
    let onResult: (ChatVoiceResult) -> Void
    /// 同意前不得 preconnect / 上传音频；为 false 时只展示门禁，不自动开录。
    var hasAIDataSharingConsent: Bool = true
    /// 首次同意或麦克风授权结束后回调，宿主应关闭 overlay 并要求用户重新按住。
    var onPermissionInterrupted: (() -> Void)?
    let voiceConfig: VoiceConfig

    @State private var recorder = VoiceRecordingController()
    @State private var dismissTask: Task<Void, Never>?
    @State private var cardVisible = false

    init(
        isPresented: Binding<Bool>,
        messages: [ChatMessage] = [],
        appHotwords: [String]? = nil,
        hasAIDataSharingConsent: Bool = true,
        onPermissionInterrupted: (() -> Void)? = nil,
        onResult: @escaping (ChatVoiceResult) -> Void
    ) {
        self._isPresented = isPresented
        self.hasAIDataSharingConsent = hasAIDataSharingConsent
        self.onPermissionInterrupted = onPermissionInterrupted
        self.onResult = onResult

        let vs = VoiceSettings.shared

        let context: String? = vs.enableDialogContext
            ? VoiceConfig.buildDialogContext(from: messages.map { (role: $0.role.rawValue, content: $0.text) })
            : nil

        let mergedHotwords = vs.mergedHotwords(appHotwords: appHotwords)

        self.voiceConfig = .chat(context: context, hotwords: mergedHotwords)
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: TTSpacing.xl) {
            headerSection
            transcriptionSection
            audioVisualization
            controlsSection
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.lg)
        .padding(.bottom, TTSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(.secondarySystemBackground))
        .offset(y: cardVisible ? 0 : 16)
        .opacity(cardVisible ? 1 : 0)
        .onAppear { animateIn() }
        .onDisappear { Task { await recorder.cleanup() } }
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack {
            HStack(spacing: TTSpacing.sm) {
                if recorder.state == .recording {
                    Circle()
                        .fill(.red)
                        .frame(width: 8, height: 8)
                }
                Text(statusText)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)

                emotionBadge
            }

            Spacer()

            if recorder.state == .recording {
                Text(recorder.formattedDuration)
                    .font(.tt.codeSM)
                    .foregroundStyle(
                        (recorder.maxDuration - recorder.recordingDuration) <= 15
                            ? .red : .tt.textTertiary
                    )
            }

            Button {
                cancelAndDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.tt.iconBodyMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(.tt.bgSubtle.opacity(0.6)))
            }
            .disabled(recorder.state == .processing)
            .accessibilityLabel("关闭")
        }
    }

    /// 情绪检测 emoji 气泡
    @ViewBuilder
    private var emotionBadge: some View {
        if let emoji = recorder.emotionEmoji,
           recorder.state == .recording || recorder.state == .processing || recorder.state == .done {
            Text(emoji)
                .font(.tt.subtitle)
                .transition(.scale.combined(with: .opacity))
                .animation(.spring(duration: 0.3, bounce: 0.3), value: recorder.latestEmotion)
        }
    }

    private var statusText: String {
        switch recorder.state {
        case .idle, .preparing: return "正在连接"
        case .recording: return "语音输入"
        case .processing: return "正在处理"
        case .done: return "识别完成"
        case .error: return "语音输入失败"
        }
    }

    // MARK: - Transcription

    private var transcriptionSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            if recorder.state == .done, !recorder.hasText {
                VStack(spacing: TTSpacing.sm) {
                    Image(systemName: "text.bubble")
                        .font(.tt.iconFeature)
                        .foregroundStyle(.tt.textTertiary.opacity(0.4))
                    Text("没有识别到文字")
                        .font(.tt.body)
                        .foregroundStyle(.tt.textTertiary)
                }
                .frame(maxWidth: .infinity)
            } else if !recorder.effectiveText.isEmpty {
                ScrollView(.vertical, showsIndicators: false) {
                    Text(recorder.effectiveText)
                        .font(ConversationTypography.bodyFont)
                        .lineSpacing(ConversationTypography.bodyLineSpacing)
                        .foregroundStyle(.tt.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            } else if recorder.state == .recording {
                Text("正在听...")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if recorder.state == .preparing {
                HStack(spacing: TTSpacing.sm) {
                    ProgressView().scaleEffect(0.7)
                    Text("正在连接")
                        .font(.tt.body)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
        }
        .frame(minHeight: 60)
    }

    // MARK: - Audio Visualization

    @ViewBuilder
    private var audioVisualization: some View {
        if recorder.state == .recording {
            AudioLevelVisualization(
                levels: recorder.audioLevels,
                accessibilityText: "语音输入"
            )
        }
    }

    // MARK: - Controls

    private var controlsSection: some View {
        HStack(spacing: TTSpacing.xl) {
            switch recorder.state {
            case .recording:
                Button {
                    cancelAndDismiss()
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "trash")
                            .font(.tt.iconSubtitle)
                            .foregroundStyle(.tt.textTertiary)
                            .frame(width: 48, height: 48)
                            .background(Circle().fill(.tt.bgSubtle))
                        Text("取消")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .accessibilityLabel("取消")

                Button {
                    Task { await recorder.stopRecording() }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "stop.fill")
                            .font(.tt.iconFeature)
                            .foregroundStyle(.white)
                            .frame(width: 64, height: 64)
                            .background(Circle().fill(.red))
                            .shadow(color: .red.opacity(0.3), radius: 8, y: 2)
                        Text("完成")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
                .accessibilityLabel("完成")

            case .done:
                if recorder.hasText {
                    Button {
                        cancelAndDismiss()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "trash")
                                .font(.tt.iconSubtitle)
                                .foregroundStyle(.tt.textTertiary)
                                .frame(width: 48, height: 48)
                                .background(Circle().fill(.tt.bgSubtle))
                            Text("取消")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    }

                    Button {
                        finishWith(.fillDraft(recorder.effectiveText))
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "text.cursor")
                                .font(.tt.iconSubtitle)
                                .foregroundStyle(.tt.bgAccent)
                                .frame(width: 48, height: 48)
                                .background(Circle().fill(.tt.bgAccent.opacity(0.12)))
                            Text("填入")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    }
                    .accessibilityLabel("填入")

                    Button {
                        finishWith(.sendDirectly(recorder.effectiveText))
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "arrow.up")
                                .font(.tt.iconFeatureSemibold)
                                .foregroundStyle(.white)
                                .frame(width: 64, height: 64)
                                .background(Circle().fill(.tt.bgAccent))
                                .shadow(color: .tt.bgAccent.opacity(0.3), radius: 8, y: 2)
                            Text("发送")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                    .accessibilityLabel("发送")
                } else {
                    Button {
                        cancelAndDismiss()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "xmark")
                                .font(.tt.iconSubtitle)
                                .foregroundStyle(.tt.textTertiary)
                                .frame(width: 48, height: 48)
                                .background(Circle().fill(.tt.bgSubtle))
                            Text("关闭")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    }

                    Button {
                        Task { await recorder.startRecording() }
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.tt.iconFeatureSemibold)
                                .foregroundStyle(.white)
                                .frame(width: 64, height: 64)
                                .background(Circle().fill(.tt.bgAccent))
                                .shadow(color: .tt.bgAccent.opacity(0.3), radius: 8, y: 2)
                            Text("重试")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                    .accessibilityLabel("重试")
                }

            case .idle, .preparing:
                ProgressView().scaleEffect(1.2)

            case .processing:
                VStack(spacing: TTSpacing.sm) {
                    ProgressView()
                    Text("正在处理")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }

            case .error:
                VStack(spacing: TTSpacing.lg) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.tt.iconEmpty)
                        .foregroundStyle(.orange)

                    if let msg = recorder.errorMessage {
                        Text(msg)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                    } else if recorder.isPermissionError {
                        Text("请在系统设置中允许 TabTin 使用麦克风")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                            .multilineTextAlignment(.center)
                    }

                    HStack(spacing: TTSpacing.xl) {
                        Button { cancelAndDismiss() } label: {
                            VStack(spacing: 4) {
                                Image(systemName: "xmark")
                                    .font(.tt.iconSubtitle)
                                    .foregroundStyle(.tt.textTertiary)
                                    .frame(width: 48, height: 48)
                                    .background(Circle().fill(.tt.bgSubtle))
                                Text("关闭")
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }

                        if recorder.isPermissionError {
                            Button {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    UIApplication.shared.open(url)
                                }
                            } label: {
                                VStack(spacing: 4) {
                                    Image(systemName: "gear")
                                        .font(.tt.iconFeatureSemibold)
                                        .foregroundStyle(.white)
                                        .frame(width: 64, height: 64)
                                        .background(Circle().fill(.tt.bgAccent))
                                    Text("设置")
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                }
                            }
                        } else if recorder.retryCount < 3 {
                            Button {
                                recorder.retry()
                            } label: {
                                VStack(spacing: 4) {
                                    Image(systemName: "arrow.counterclockwise")
                                        .font(.tt.iconFeatureSemibold)
                                        .foregroundStyle(.white)
                                        .frame(width: 64, height: 64)
                                        .background(Circle().fill(.tt.bgAccent))
                                    Text("重试")
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Lifecycle

    private func animateIn() {
        recorder.voiceConfig = voiceConfig
        let permissionWasUndetermined = AVAudioApplication.shared.recordPermission == .undetermined
        withAnimation(.spring(duration: 0.4, bounce: 0.15)) {
            cardVisible = true
        }
        // AI 数据共享同意必须先于 ASR preconnect / 音频上传；未同意时不自动开录。
        guard hasAIDataSharingConsent else {
            VoiceRecordingSession.cancelPreconnect()
            return
        }
        Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard hasAIDataSharingConsent else {
                VoiceRecordingSession.cancelPreconnect()
                return
            }
            await recorder.startRecording()
            // 只有首次授权成功才结束本次手势。拒绝或已禁用时保留错误页，
            // 让用户能直接点击「设置」，不能把可恢复入口随 sheet 一起收掉。
            if shouldInterruptVoiceOverlayAfterPermissionRequest(
                permissionWasUndetermined: permissionWasUndetermined,
                permissionIsGranted: AVAudioApplication.shared.recordPermission == .granted
            ) {
                onPermissionInterrupted?()
            }
        }
    }

    // MARK: - Actions

    private func finishWith(_ result: ChatVoiceResult) {
        let text: String
        switch result {
        case .fillDraft(let t), .sendDirectly(let t):
            text = t.trimmingCharacters(in: .whitespacesAndNewlines)
        case .cancelled:
            text = ""
        }
        guard !text.isEmpty || result.isCancelled else { return }

        let resultToSend = result
        withAnimation(.spring(duration: 0.3, bounce: 0.1)) {
            cardVisible = false
        }
        dismissTask = Task { @MainActor in
            await recorder.cancelRecording()
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            onResult(resultToSend)
            isPresented = false
        }
    }

    private func cancelAndDismiss() {
        withAnimation(.spring(duration: 0.3, bounce: 0.1)) {
            cardVisible = false
        }
        dismissTask = Task { @MainActor in
            await recorder.cancelRecording()
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            onResult(.cancelled)
            isPresented = false
        }
    }
}

private extension ChatVoiceResult {
    var isCancelled: Bool {
        if case .cancelled = self { return true }
        return false
    }
}
