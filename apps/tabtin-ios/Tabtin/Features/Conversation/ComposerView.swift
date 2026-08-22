import SwiftUI
import UIKit

/// 底部输入栏：多行输入 + 发送 / 停止。
///
/// Agent 在跑时仍可排队发送，但模型选择锁定到本轮结束。环境硬门闩（无 Workspace、执行设备
/// 离线/未绑定、HITL 阻断、计费）会置灰输入井，原因写在井内顶栏，不外挂横幅。
/// 仅当「输入为空 + 本机有可取消的在跑轮次」时按钮变为「停止」。
struct ComposerView: View {
    @Binding var text: String
    /// 父层每次消费输入后递增；用于让 SwiftUI 多行 TextField 丢弃首轮焦点同步里的旧文本缓存。
    var resetToken: Int = 0
    /// 本机有一轮可取消的在跑任务：输入为空时显示停止按钮。
    var canCancel: Bool = false
    /// 首发建会话或当前草稿尚未入队：发送键改转圈，避免同一位置立刻变成停止。
    var sendInFlight: Bool = false
    var isPaused: Bool = false
    var pauseControlPending: Bool = false
    var cancelControlPending: Bool = false
    /// HITL 阻断态：上方有待处理的审批 / 选择 / 表单时，Agent 已暂停等回应——
    /// 此时禁止发普通消息；模型选择同样保持锁定，等待当前交互结束。
    var blocked: Bool = false
    var disabledReason: String?
    /// 用户正在翻消息（滚动中，或停在历史里）：输入井收成一行悬浮胶囊，把屏幕高度让给
    /// 阅读。是否真的收由 `ComposerReadingCollapsePolicy` 结合井内内容决定。
    var collapsedForReading: Bool = false
    var currentMode = "agent"
    /// 兼容旧调用方；审批权限现由 `currentApprovalMode` 表达，YOLO 不再是工作模式。
    /// 当前未再使用，留作既有调用方的兼容参数；W0-A 会迁走旧 YOLO 偏好。
    var allowMemberYolo: Bool = true
    /// W0-C 只提供设置外壳；W0-A/W0-B 会把真实 Agent、审批档和 Device 快照接进来。
    var currentAgentName: String? = nil
    var agentOptions: [ComposerTaskAgentOption] = []
    var selectedAgentId: String? = nil
    var agentIsMutable = false
    var currentApprovalMode = "always_ask"
    var executionWorkspaceName: String? = nil
    var executionLocationHint: String? = nil
    var canSwitchExecutionWorkspace: Bool = false
    var executionWorkspaceOptions: [ComposerExecutionWorkspaceOption] = []
    var selectedExecutionWorkspaceId: String? = nil
    /// 工具条中部只显示模型名称（无图标）；点按打开选择抽屉。
    var selectedModelName: String? = nil
    var selectedModelId: String? = nil
    var selectedContextTierId: String? = nil
    var selectedThinkingMode: ChatModelThinkingMode? = nil
    var runtimeSettingsSummary: String? = nil
    var availableModels: [ChatModel] = []
    var modelProviders: [String: ChatModelProviderMetadata] = [:]
    var isModelLoading = false
    var modelSelectionDisabled = false
    var onSelectModel: (ChatModel) -> Void = { _ in }
    var onSelectContextTier: (String) -> Void = { _ in }
    var onSelectThinkingMode: (ChatModelThinkingMode) -> Void = { _ in }
    var onRetryLoadModels: () -> Void = {}
    var attachments: [ComposerLocalAttachment] = []
    var contextRefs: [MentionContextRef] = []
    var contextResources: [SpaceResource] = []
    var currentSpaceName: String?
    var onModeChange: (String) -> Void = { _ in }
    var onAgentChange: (ComposerTaskAgentOption) -> Void = { _ in }
    var onApprovalModeChange: (String) -> Void = { _ in }
    var onExecutionLocationHelp: () -> Void = {}
    var onSelectExecutionWorkspace: (ComposerExecutionWorkspaceOption) -> Void = { _ in }
    var onSelectTool: (ComposerTool) -> Void = { _ in }
    var onVoiceInput: () -> Void = {}
    var onRemoveAttachment: (String) -> Void = { _ in }
    var onRetryAttachment: (String) -> Void = { _ in }
    var onRemoveContextRef: (String) -> Void = { _ in }
    var onOpenContextRef: (MentionContextRef) -> Void = { _ in }
    var onAddContextRef: (MentionContextRef) -> Void = { _ in }
    let onSend: (String) -> Void
    let onCancel: () -> Void
    let onPause: () -> Void
    let onResume: () -> Void

    /// Electron compact composer 的输入井始终可见；focus 只负责键盘和编辑态，
    /// 不再把「有无焦点」误作整块 Composer 的布局状态。
    @State private var isExpanded = true
    @State private var showMentionPopover = false
    @State private var mentionQuery = ""
    @State private var showModelSelector = false
    @State private var staleTextToIgnore: String?
    /// UIKit 是 first responder 的唯一真源；SwiftUI 只保存其回报，用于阅读态策略。
    @State private var focused = false
    /// 业务需要主动聚焦时发一次新请求。普通文本重算不参与焦点仲裁。
    @State private var focusRequest: UUID?
    @State private var stopArmed = false
    @State private var stopArmTask: Task<Void, Never>?
    @Environment(\.colorScheme) private var colorScheme

    private var isDisabled: Bool { blocked || disabledReason != nil }
    private var isRunControlPending: Bool { pauseControlPending || cancelControlPending }

    private var shouldKeepExpanded: Bool {
        !ComposerReadingCollapsePolicy.shouldCollapse(
            scrollWantsCollapse: collapsedForReading,
            isFocused: focused,
            hasDraftText: !trimmed.isEmpty,
            hasAttachments: !attachments.isEmpty,
            hasContextRefs: !contextRefs.isEmpty,
            hasBlockingReason: disabledReason != nil
        )
    }

    private var materialSummary: ComposerMaterialSummary {
        AttachmentUploadPolicy.summary(
            attachments: attachments,
            contextReferenceCount: contextRefs.count
        )
    }

    private var canSubmitCurrentDraft: Bool {
        AttachmentUploadPolicy.canSubmit(
            text: text,
            attachments: attachments
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            if showMentionPopover {
                MentionPopover(
                    resources: contextResources,
                    query: mentionQuery,
                    currentSpaceName: currentSpaceName,
                    onSelect: selectMentionResource,
                    onDismiss: { showMentionPopover = false }
                )
                .padding(.horizontal, TTSpacing.lg)
                .padding(.bottom, TTSpacing.xs)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            inputBar
        }
        .opacity(isDisabled ? 0.6 : 1)
        .onAppear { isExpanded = shouldKeepExpanded }
        .onChange(of: shouldKeepExpanded) { _, shouldExpand in
            guard isExpanded != shouldExpand else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
                isExpanded = shouldExpand
            }
        }
        .onChange(of: focused) { _, now in PerfTrace.mark("composer.focus=\(now)") }
        .onChange(of: text) { _, value in
            updateMentionState(for: value)
        }
        .onChange(of: resetToken) { _, _ in
            text = ""
            showMentionPopover = false
            mentionQuery = ""
        }
        .onChange(of: canCancel) { _, _ in
            refreshStopArm()
        }
        .onChange(of: sendInFlight) { _, _ in
            refreshStopArm()
        }
        .onAppear {
            refreshStopArm()
        }
        .onDisappear {
            stopArmTask?.cancel()
            stopArmTask = nil
        }
        .onChange(of: isDisabled) { _, nowDisabled in
            if nowDisabled {
                showMentionPopover = false
            }
        }
        .onChange(of: focused) { _, now in
            if !now { showMentionPopover = false }
            else { updateMentionState(for: text) }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            PerfTrace.mark("keyboard.willShow")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            PerfTrace.mark("keyboard.didShow")
        }
    }

    @ViewBuilder
    private var inputBar: some View {
        inputWell
            .padding(TTSpacing.xs)
            // 实底而非玻璃：底部渐隐层已经是不透明的画布色，玻璃在它上面没有可折射的内容，
            // 只会把输入区的明度洗到和画布一样——看着像融掉，而不是浮起来。轮廓改由
            //「比画布亮一档的实底 + 两层淡投影」表达，与画布的关系是明度差，不是描边。
            .background(composerFill, in: composerShape)
            // 不描边：一条 hairline 会把输入区"框"出来，读起来是贴在页面上的卡片，而不是
            // 浮起来的一层。轮廓改由「材质比画布亮一档 + 大扩散淡投影」表达。
            //
            // 两层投影：贴边那层给出接触感，大扩散那层给出高度感。单层要么发灰发脏，
            // 要么在边缘留下可见的一圈——这正是硬边界的来源。
            .shadow(color: Color.black.opacity(0.05), radius: 2, x: 0, y: 1)
            .shadow(
                color: Color.black.opacity(isExpanded ? 0.07 : 0.09),
                radius: isExpanded ? 24 : 30,
                x: 0,
                y: isExpanded ? 6 : 8
            )
            .safeAreaPadding(.horizontal, isExpanded ? TTSpacing.lg : TTSpacing.xl)
            .padding(.top, TTSpacing.xs)
            .padding(.bottom, TTSpacing.sm)
    }

    /// 收敛态走胶囊形、展开态回到结构面圆角——形状本身就在说"现在是读，还是写"。
    /// 用同一个 `RoundedRectangle` 只换半径，让两态之间能连续插值。
    private var composerShape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: isExpanded ? TTRadius.xl : Self.collapsedCornerRadius,
            style: .continuous
        )
    }

    /// 收敛态单行高度约 52pt，取其半作胶囊半径。
    private static let collapsedCornerRadius: CGFloat = 26

    /// 浮层底色：画布是浅灰，输入区就该是那颗更亮的「药丸」。设计系统尚无 elevated
    /// 语义色，这里浅色直接用白、深色把画布往白里提一档，两种外观下都比画布亮一级。
    /// 深色档位要越过 `bgSubtle`：井内的「+」圆底用的就是它，药丸若停在同一档，圆底会
    /// 直接融进药丸。两种外观下都得让药丸成为最亮的一层，井内控件才浮得出来。
    private var composerFill: Color {
        colorScheme == .dark
            ? Color.tt.bgCanvasDefault.mix(with: .white, by: 0.15)
            : .white
    }

    /// 输入与所有即时操作共用单层 input well。模型已上移到会话导航栏，
    /// Workspace 收为工具栏图标，避免任何设置项再生成第二行。
    @ViewBuilder
    private var inputWell: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty || !contextRefs.isEmpty {
                AttachmentSummaryView(
                    summary: materialSummary,
                    onCancelAllUploads: cancelAllUploads
                )
                .padding(.horizontal, TTSpacing.sm)
                .padding(.top, TTSpacing.sm)

                previewBar
            }

            if let disabledReason {
                // 硬门闩提示只活在输入井内：warning 色 + 最多两行，不再外挂屏幕横幅。
                Text(disabledReason)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textWarning)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, TTSpacing.sm)
                    .padding(.top, TTSpacing.sm)
                    .accessibilityLabel(disabledReason)
            }

            if isExpanded {
                if let composerQuote {
                    composerQuotePreview(composerQuote)
                }

                ZStack(alignment: .topLeading) {
                    ScrollableComposerTextView(
                        text: composerReplyBinding,
                        isEditable: !isDisabled && !isPaused && !isRunControlPending,
                        isFocused: $focused,
                        focusRequest: focusRequest,
                        onSubmit: submitIfPossible
                    )
                    if editableReply.isEmpty, !inputPlaceholder.isEmpty {
                        Text(inputPlaceholder)
                            .font(ConversationTypography.composerFont)
                            .foregroundStyle(.tt.textTertiary)
                            .padding(.horizontal, TTSpacing.sm)
                            .padding(.vertical, TTSpacing.sm)
                            .allowsHitTesting(false)
                    }
                }
                    // footer 作为全屏 overlay 的底部内容，会收到整屏高度 proposal。
                    // 垂直方向必须坚持 UITextView 返回的固有高度，否则这个弹性 frame
                    // 会把单行编辑区扩到 136pt，并把文字居中后在上方留下大块空白。
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            controlsRow(showCollapsedPlaceholder: !isExpanded)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func controlsRow(showCollapsedPlaceholder: Bool) -> some View {
        HStack(alignment: .center, spacing: TTSpacing.sm) {
            // 「+」已并入任务设置抽屉顶部宫格，工具条只留设置入口。
            taskSettings

            // 收敛态是阅读姿态：模型名是"发送前才需要确认"的信息，此时让位给占位文案，
            // 使这一行读起来就是一句「继续对话」，而不是半截被截断的工作区名。
            if !showCollapsedPlaceholder {
                modelNameControl
            }

            if showCollapsedPlaceholder {
                Button { expandComposer() } label: {
                    HStack(spacing: 0) {
                        Text(collapsedPlaceholder)
                            .font(ConversationTypography.composerFont)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDisabled || isPaused || isRunControlPending)
                .accessibilityLabel(collapsedPlaceholder.isEmpty ? "输入框" : collapsedPlaceholder)
                .accessibilityHint("展开输入框并开始输入")
            } else {
                Spacer(minLength: 0)
            }

            // 右侧：语音固定贴右；有正文或已就绪附件时显示发送键。
            voiceInputButton
                .frame(width: 44, height: 44)

            switch primaryAction {
            case .stop:
                runControlButtons
                    .id("composer-action-stop")
            case .sending:
                sendingIndicator
                    .id("composer-action-sending")
            case .send:
                Button(action: submitCurrentText) {
                    Image(systemName: actionIcon)
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(buttonEnabled ? actionColor : Color.tt.textDisabled)
                        .frame(width: 28, height: 28)
                        .background(
                            buttonEnabled ? actionColor.opacity(0.14) : Color.tt.bgSubtle,
                            in: Circle()
                        )
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .id("composer-action-send")
                .disabled(!buttonEnabled)
                .accessibilityLabel("发送")
            case .none:
                EmptyView()
            }
        }
        .padding(.horizontal, showCollapsedPlaceholder ? TTSpacing.md : TTSpacing.sm)
        .padding(.vertical, 0)
    }

    /// 工具条中部：模型名 + 可选运行设置短摘要，点按打开选择抽屉。
    @ViewBuilder
    private var modelNameControl: some View {
        Group {
            if let name = selectedModelName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                Button {
                    showModelSelector = true
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        Text(name)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if let runtimeSettingsSummary,
                           !runtimeSettingsSummary.isEmpty {
                            Text(runtimeSettingsSummary)
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                    .frame(maxWidth: 180, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(modelSelectionDisabled || availableModels.isEmpty)
                .accessibilityLabel(
                    runtimeSettingsSummary.map { "当前模型：\(name)，\($0)" } ?? "当前模型：\(name)"
                )
                .accessibilityHint("选择下一次发送使用的模型与运行设置")
            } else if isModelLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("正在加载模型")
            } else {
                Button {
                    if availableModels.isEmpty {
                        onRetryLoadModels()
                    } else {
                        showModelSelector = true
                    }
                } label: {
                    Text("选择模型")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(modelSelectionDisabled)
                .accessibilityLabel("选择模型")
            }
        }
        .onChange(of: modelSelectionDisabled) { _, disabled in
            if disabled { showModelSelector = false }
        }
        .sheet(isPresented: $showModelSelector) {
            ComposerModelSelectionDrawer(
                models: availableModels,
                providers: modelProviders,
                selectedModelId: selectedModelId,
                selectedContextTierId: selectedContextTierId,
                selectedThinkingMode: selectedThinkingMode,
                onSelect: { model in
                    guard !modelSelectionDisabled else { return }
                    onSelectModel(model)
                },
                onSelectContextTier: onSelectContextTier,
                onSelectThinkingMode: onSelectThinkingMode
            )
        }
    }

    private var voiceInputButton: some View {
        Button(action: onVoiceInput) {
            Image(systemName: "mic")
                .font(.tt.iconSubtitleMedium)
                .foregroundStyle(isDisabled ? .tt.textTertiary : .tt.textSecondary)
                .frame(width: 28, height: 28)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isPaused)
        .accessibilityLabel("语音输入")
    }

    private var previewBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.sm) {
                ForEach(contextRefs) { ref in
                    ContextRefChip(
                        ref: ref,
                        onOpen: ref.type == .memo ? { onOpenContextRef(ref) } : nil,
                        onRemove: { onRemoveContextRef(ref.id) }
                    )
                }
                ForEach(attachments) { attachment in
                    ComposerAttachmentChip(
                        attachment: attachment,
                        onRetry: { onRetryAttachment(attachment.id) },
                        onRemove: { onRemoveAttachment(attachment.id) }
                    )
                }
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.xs)
        }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var composerQuote: ComposerMessageQuote? {
        MessageQuote.parseComposerDraft(text)
    }

    private var editableReply: String {
        composerQuote?.reply ?? text
    }

    private var composerReplyBinding: Binding<String> {
        Binding(
            get: { editableReply },
            set: { newValue in
                if let staleTextToIgnore {
                    if newValue == staleTextToIgnore { return }
                    if !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.staleTextToIgnore = nil
                    }
                }
                text = composerQuote.map { $0.payload + newValue } ?? newValue
            }
        )
    }

    private func composerQuotePreview(_ quote: ComposerMessageQuote) -> some View {
        HStack(alignment: .center, spacing: TTSpacing.sm) {
            Image(systemName: "quote.bubble")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textAccent)
                .frame(width: 28, height: 28)
                .background(.tt.iconAccent.opacity(0.10), in: Circle())

            VStack(alignment: .leading, spacing: 0) {
                Text(quote.author == "我" ? "引用我的消息" : "引用 Agent 的回复")
                    .font(.tt.metaMedium)
                    .foregroundStyle(.tt.textAccent)
                    .lineLimit(1)
                Text(quote.content)
                    .font(ConversationTypography.metaFont)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                text = quote.reply
                requestFocus()
            } label: {
                Image(systemName: "xmark")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("移除引用")
        }
        .padding(.leading, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var primaryAction: ComposerPrimaryAction {
        ComposerPrimaryActionPolicy.action(
            canSubmitCurrentDraft: canSubmitCurrentDraft,
            canCancel: canCancel,
            sendInFlight: sendInFlight,
            cancelControlPending: cancelControlPending,
            isPaused: isPaused,
            pauseControlPending: pauseControlPending,
            stopArmed: stopArmed
        )
    }

    private var sendingIndicator: some View {
        ProgressView()
            .controlSize(.small)
            .frame(width: 44, height: 44)
            .accessibilityLabel("正在发送")
    }

    private var buttonEnabled: Bool { !isDisabled && !isPaused && !isRunControlPending }

    private var workspaceDisplayName: String {
        let fromSpace = currentSpaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !fromSpace.isEmpty { return fromSpace }
        return executionWorkspaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var inputPlaceholder: String {
        // 完整原因已在井内顶栏；占位只给短状态，避免与顶栏重复长文。
        if disabledReason != nil { return "" }
        if cancelControlPending { return "正在停止任务…" }
        if pauseControlPending { return "正在暂停，当前步骤完成后生效" }
        if isPaused { return "任务已暂停，可继续或停止" }
        if blocked { return "请先处理上方的请求…" }
        let workspace = workspaceDisplayName
        return workspace.isEmpty ? "在此对话…" : "在\(workspace)中对话…"
    }

    /// 收敛态只有一行：不重复 Workspace 名（发到哪在展开时才需要确认），只说下一步动作。
    private var collapsedPlaceholder: String {
        if disabledReason != nil { return "" }
        if cancelControlPending { return "正在停止任务…" }
        if pauseControlPending { return "正在暂停，当前步骤完成后生效" }
        if isPaused { return "任务已暂停" }
        if blocked { return "请先处理上方的请求…" }
        return "继续对话…"
    }

    private var actionIcon: String {
        "arrow.up.circle"
    }

    private var actionColor: Color {
        .tt.iconAccent
    }

    private var runControlButtons: some View {
        HStack(spacing: TTSpacing.xs) {
            // Electron 紧凑 Composer 在执行中只保留 Stop 主控，避免小屏横向挤压。
            // 已暂停时仍保留继续入口，保证状态可恢复。
            if isPaused {
                Button(action: onResume) {
                    if pauseControlPending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "play.circle")
                            .font(.tt.iconSubtitle)
                            .foregroundStyle(.tt.iconAccent)
                            .frame(width: 28, height: 28)
                            .background(.tt.iconAccent.opacity(0.14), in: Circle())
                            .frame(width: 44, height: 44)
                    }
                }
                .buttonStyle(.plain)
                .disabled(pauseControlPending)
                .frame(width: 44, height: 44)
                .accessibilityLabel("继续任务")
            }

            Button(action: onCancel) {
                if cancelControlPending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "stop.circle")
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(.tt.textCritical)
                        .frame(width: 28, height: 28)
                        .background(.tt.textCritical.opacity(0.12), in: Circle())
                        .frame(width: 44, height: 44)
                }
            }
                .buttonStyle(.plain)
                .disabled(cancelControlPending)
                .accessibilityLabel("停止任务")
        }
    }

    private func refreshStopArm() {
        stopArmTask?.cancel()
        if sendInFlight || !canCancel {
            stopArmed = false
            stopArmTask = nil
            return
        }
        stopArmed = false
        stopArmTask = Task { @MainActor in
            try? await Task.sleep(for: ComposerPrimaryActionPolicy.stopArmDelay)
            guard !Task.isCancelled else { return }
            stopArmed = true
        }
    }

    private func submitIfPossible() {
        guard !isDisabled, !isRunControlPending, !sendInFlight, canSubmitCurrentDraft else { return }
        submitCurrentText()
    }

    private func submitCurrentText() {
        let submittedText = text
        let submittedReply = editableReply
        staleTextToIgnore = submittedReply
        text = ""
        onSend(submittedText)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            if staleTextToIgnore == submittedReply {
                staleTextToIgnore = nil
            }
        }
    }

    private func updateMentionState(for value: String) {
        guard focused, !isDisabled else {
            showMentionPopover = false
            return
        }
        guard let token = Self.trailingMentionToken(in: value) else {
            showMentionPopover = false
            mentionQuery = ""
            return
        }
        mentionQuery = token
        showMentionPopover = true
    }

    private func selectMentionResource(_ ref: MentionContextRef) {
        onAddContextRef(ref)
        text = Self.removingTrailingMentionToken(from: text)
        showMentionPopover = false
        mentionQuery = ""
        requestFocus()
    }

    /// 单项移除始终走已有回调；批量取消沿用它，确保上传 Task 取消、临时文件清理和
    /// 服务端 usage 回收保持同一条链路。
    private func cancelAllUploads() {
        AttachmentUploadPolicy
            .cancellableAttachmentIDs(in: attachments)
            .forEach(onRemoveAttachment)
    }

    private var taskSettings: some View {
        ComposerTaskSettingsView(
            agentName: currentAgentName,
            agentOptions: agentOptions,
            selectedAgentId: selectedAgentId,
            agentIsMutable: agentIsMutable,
            currentMode: currentMode,
            currentApprovalMode: currentApprovalMode,
            workspaceName: executionWorkspaceName,
            executionLocationHint: executionLocationHint,
            canSwitchExecutionWorkspace: canSwitchExecutionWorkspace,
            executionWorkspaceOptions: executionWorkspaceOptions,
            selectedExecutionWorkspaceId: selectedExecutionWorkspaceId,
            permitsRelaxedApproval: allowMemberYolo,
            disabled: isDisabled,
            onAgentChange: onAgentChange,
            onModeChange: onModeChange,
            onApprovalModeChange: onApprovalModeChange,
            onExecutionLocationHelp: onExecutionLocationHelp,
            onSelectExecutionWorkspace: onSelectExecutionWorkspace,
            onSelectTool: onSelectTool
        )
    }

    private static func trailingMentionToken(in value: String) -> String? {
        guard let atIndex = value.lastIndex(of: "@") else { return nil }
        let suffix = value[value.index(after: atIndex)...]
        guard !suffix.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        let before = value[..<atIndex]
        if let last = before.last, !last.isWhitespace, !last.isNewline {
            return nil
        }
        return String(suffix)
    }

    private static func removingTrailingMentionToken(from value: String) -> String {
        guard let atIndex = value.lastIndex(of: "@") else { return value }
        let before = value[..<atIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return before.isEmpty ? "" : "\(before) "
    }

    private func expandComposer() {
        PerfTrace.mark("composer.tap.expand")
        guard !isExpanded else {
            requestFocus()
            return
        }
        withAnimation(.easeInOut(duration: 0.18)) {
            isExpanded = true
        }
        Task { @MainActor in
            await Task.yield()
            requestFocus()
        }
    }

    private func requestFocus() {
        guard !isDisabled, !isPaused, !isRunControlPending else { return }
        focusRequest = UUID()
    }
}

/// Composer 编辑区按真实正文行高增长；单行保持紧凑，长草稿到上限后由 UITextView 内滚。
enum ComposerTextViewMetrics {
    static let minimumHeight = ConversationTypography.stepLineHeight + TTSpacing.sm * 2
    static let maximumHeight: CGFloat = 136

    static func resolvedHeight(for fittingHeight: CGFloat) -> CGFloat {
        min(max(fittingHeight, minimumHeight), maximumHeight)
    }

    static func shouldScroll(for contentHeight: CGFloat) -> Bool {
        contentHeight > maximumHeight
    }

    /// `UITextView` 开启滚动后，系统的 `sizeThatFits` 可能直接回报当前约束高度，
    /// 导致单行草稿也命中 136pt 上限。这里用独立 TextKit 布局测量真实文本高度，
    /// 不让当前 frame / contentOffset 反过来污染 SwiftUI 的尺寸决策。
    @MainActor
    static func contentHeight(for textView: UITextView, width: CGFloat) -> CGFloat {
        let insets = textView.textContainerInset
        let horizontalPadding = textView.textContainer.lineFragmentPadding * 2
        let contentWidth = max(0, width - insets.left - insets.right - horizontalPadding)
        guard contentWidth > 0 else { return minimumHeight }

        let storage = NSTextStorage(attributedString: textView.attributedText)
        let fallbackFont = textView.font ?? UIFont.systemFont(ofSize: ConversationTypography.bodySize)
        if storage.length > 0 {
            storage.addAttribute(.font, value: fallbackFont, range: NSRange(location: 0, length: storage.length))
        }
        // 空文本和末尾换行都需要一行可输入高度；零宽字符只参与排版，不改变实际内容。
        storage.append(NSAttributedString(string: "\u{200B}", attributes: [.font: fallbackFont]))

        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(
            size: CGSize(width: contentWidth, height: .greatestFiniteMagnitude)
        )
        container.lineFragmentPadding = 0
        container.lineBreakMode = textView.textContainer.lineBreakMode
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: container)

        return ceil(layoutManager.usedRect(for: container).height + insets.top + insets.bottom)
    }
}

/// 有界、可滚动的 Composer 输入模块。
///
/// 焦点接口刻意单向：
/// - UIKit 通过 `isFocused` 回报真实 first responder 状态；
/// - SwiftUI 只有发出新的 `focusRequest`，或把输入置为不可编辑时，才命令 UIKit；
/// - 文本更新绝不根据状态快照调用 `resignFirstResponder()`。
struct ScrollableComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let isEditable: Bool
    @Binding var isFocused: Bool
    let focusRequest: UUID?
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = UIFontMetrics.default.scaledFont(
            for: UIFont.systemFont(
                ofSize: ConversationTypography.bodySize,
                weight: .regular
            )
        )
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = UIEdgeInsets(
            top: TTSpacing.sm,
            left: TTSpacing.sm,
            bottom: TTSpacing.sm,
            right: TTSpacing.sm
        )
        textView.textContainer.lineFragmentPadding = 0
        // 单行 / 短草稿由 SwiftUI 按内容高度布局；超过上限后才切到内部滚动。
        textView.isScrollEnabled = false
        textView.alwaysBounceVertical = false
        textView.showsVerticalScrollIndicator = false
        textView.keyboardDismissMode = .interactive
        textView.returnKeyType = .default
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return textView
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let contentHeight = ComposerTextViewMetrics.contentHeight(for: uiView, width: width)
        let shouldScroll = ComposerTextViewMetrics.shouldScroll(for: contentHeight)
        if uiView.isScrollEnabled != shouldScroll {
            uiView.isScrollEnabled = shouldScroll
        }
        return CGSize(
            width: width,
            height: ComposerTextViewMetrics.resolvedHeight(for: contentHeight)
        )
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyExternalTextIfNeeded(to: textView)
        textView.isEditable = isEditable
        textView.textColor = isEditable
            ? UIColor(Color.tt.textPrimary)
            : UIColor(Color.tt.textTertiary)
        textView.accessibilityLabel = "输入消息"
        context.coordinator.reconcileFocus(on: textView)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ScrollableComposerTextView
        private var fulfilledFocusRequest: UUID?

        init(parent: ScrollableComposerTextView) {
            self.parent = parent
        }

        func applyExternalTextIfNeeded(to textView: UITextView) {
            guard textView.text != parent.text else { return }
            // 中文拼音 / 手写输入处于 marked text 时，UIKit 必须独占编辑缓冲；
            // 此时从 SwiftUI 反写全文会终止组合输入并跳光标。
            guard textView.markedTextRange == nil else { return }

            let previousSelection = textView.selectedRange
            textView.text = parent.text
            let utf16Count = parent.text.utf16.count
            let location = min(previousSelection.location, utf16Count)
            let length = min(previousSelection.length, utf16Count - location)
            textView.selectedRange = NSRange(location: location, length: length)
            textView.invalidateIntrinsicContentSize()
        }

        func reconcileFocus(on textView: UITextView) {
            guard parent.isEditable else {
                if textView.isFirstResponder {
                    textView.resignFirstResponder()
                }
                return
            }
            guard let request = parent.focusRequest,
                  request != fulfilledFocusRequest else { return }

            if fulfillFocusRequest(request, on: textView) { return }
            // 首次 update 可能发生在视图入窗前；延后一拍重试，但不把失败请求标成已消费。
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView,
                      self.parent.isEditable,
                      self.parent.focusRequest == request else { return }
                _ = self.fulfillFocusRequest(request, on: textView)
            }
        }

        @discardableResult
        func fulfillFocusRequest(_ request: UUID, on textView: UITextView) -> Bool {
            guard textView.window != nil else { return false }
            let accepted = textView.isFirstResponder || textView.becomeFirstResponder()
            if accepted {
                fulfilledFocusRequest = request
            }
            return accepted
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText replacement: String
        ) -> Bool {
            guard replacement == "\n" else { return true }
            parent.onSubmit()
            return false
        }
    }
}

/// Composer 顶部羽化层尺寸。羽化画在 `background` 里不进 footer 实测高度，
/// 但下半段已明显遮挡消息——列表 `contentInset.bottom` 需额外加上可读重叠。
enum ComposerTopScrimMetrics {
    static let height: CGFloat = 72
    /// 羽化段中下部已不透明到可读受阻；给列表底部多留这一截，最后一条消息停在清晰区。
    static let readableOverlap: CGFloat = 36
}

extension View {
    /// 悬浮输入区的底部渐隐层：输入区所在的整条底部区域铺画布色，再向上羽化一大段，
    /// 让滚过去的消息在靠近输入区时逐渐融进背景。
    ///
    /// 两个要点都是「不要出现界限」：
    /// - **羽化段要足够高**（约两行正文）。窄渐变等于把硬边往上挪了一点，照样是边。
    /// - **停靠点按缓动分布**，不是线性。线性渐变两端的斜率突变，人眼会读成一条淡淡的
    ///   横线；这里在起点密、终点疏，衰减读起来才是连续的。
    ///
    /// 画在 `background` 里并用负 padding 向上延伸：背景不参与父布局测量——输入区的实测
    /// 高度要写进消息列表的底部 inset，渐隐层若被量进去就会凭空吃掉一截可读区域。
    /// 可读重叠见 `ComposerTopScrimMetrics.readableOverlap`，由 `MessageListView` 加进 inset。
    func ttComposerTopScrim(height: CGFloat = ComposerTopScrimMetrics.height) -> some View {
        background(alignment: .bottom) {
            VStack(spacing: 0) {
                LinearGradient(
                    stops: [
                        .init(color: Color.tt.bgCanvasDefault.opacity(0), location: 0),
                        .init(color: Color.tt.bgCanvasDefault.opacity(0.12), location: 0.28),
                        .init(color: Color.tt.bgCanvasDefault.opacity(0.42), location: 0.52),
                        .init(color: Color.tt.bgCanvasDefault.opacity(0.78), location: 0.76),
                        .init(color: Color.tt.bgCanvasDefault.opacity(0.94), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: height)
                // 输入区自身所在的一段：保持同一档不透明度，与羽化段末端无缝接上。
                Color.tt.bgCanvasDefault.opacity(0.94)
            }
            .padding(.top, -height)
            .allowsHitTesting(false)
        }
    }
}

enum ComposerAttachmentUploadStatus: String, Equatable, Sendable {
    case pending
    case uploading
    case ready
    case error

    var isInFlight: Bool { self == .pending || self == .uploading }
}

struct ComposerLocalAttachment: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case photo
        case camera
        case file
    }

    let id: String
    let name: String
    let kind: Kind
    let byteCount: Int64?
    let mimeType: String?
    let url: URL?
    let isTemporary: Bool
    var status: ComposerAttachmentUploadStatus = .pending
    var progress: Double = 0
    var fileId: String?
    var remoteURL: String?
    var errorMessage: String?
    var retryCount: Int = 0

    var icon: String {
        switch kind {
        case .photo, .camera: return "photo"
        case .file: return "doc"
        }
    }

    func blockPayload(fileId: String? = nil, remoteURL: String? = nil) -> [String: Any] {
        var payload: [String: Any] = [
            "type": kind == .file ? "file" : "image",
            "filename": name,
        ]
        if let mimeType { payload["mime_type"] = mimeType }
        if let byteCount { payload["size"] = byteCount }
        if let fileId { payload["file_id"] = fileId }
        if let remoteURL, !remoteURL.isEmpty {
            payload["url"] = remoteURL
            payload["remote_url"] = remoteURL
        }
        return payload
    }

    func readyBlockPayload() -> [String: Any]? {
        guard status == .ready, let fileId else { return nil }
        return blockPayload(fileId: fileId, remoteURL: remoteURL)
    }
}

private struct ComposerAttachmentChip: View {
    let attachment: ComposerLocalAttachment
    let onRetry: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: attachment.icon)
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(statusColor)
            Text(attachment.name)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            statusView
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, 5)
        .background(Capsule().fill(background))
        .overlay(Capsule().strokeBorder(border, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var statusView: some View {
        switch attachment.status {
        case .pending:
            ProgressView()
                .controlSize(.mini)
        case .uploading:
            HStack(spacing: 3) {
                ProgressView()
                    .controlSize(.mini)
                Text("\(Int((attachment.progress * 100).rounded()))%")
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
            }
        case .ready:
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textSuccess)
        case .error:
            Button(action: onRetry) {
                Image(systemName: "arrow.clockwise.circle.fill")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textCritical)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("重试上传")
        }
    }

    private var statusColor: Color {
        switch attachment.status {
        case .ready: return .tt.textSuccess
        case .error: return .tt.textCritical
        case .pending, .uploading: return .tt.iconAccent
        }
    }

    private var background: Color {
        attachment.status == .error ? .tt.bgCritical.opacity(0.08) : .tt.bgSubtle
    }

    private var border: Color {
        attachment.status == .error ? .tt.textCritical.opacity(0.25) : .tt.borderLight
    }

    private var accessibilityText: String {
        switch attachment.status {
        case .pending: return "\(attachment.name)，等待上传"
        case .uploading: return "\(attachment.name)，上传中 \(Int((attachment.progress * 100).rounded()))%"
        case .ready: return "\(attachment.name)，已上传"
        case .error: return "\(attachment.name)，上传失败，\(attachment.errorMessage ?? "可重试")"
        }
    }
}

enum ComposerTool: String, CaseIterable, Identifiable {
    case context
    case photoLibrary
    case camera
    case file

    var id: String { rawValue }

    var title: String {
        switch self {
        case .context: return "添加上下文"
        case .photoLibrary: return "选择照片"
        case .camera: return "拍照"
        case .file: return "选择文件"
        }
    }

    /// 任务设置抽屉宫格内的短标签。
    var gridTitle: String {
        switch self {
        case .context: return "上下文"
        case .photoLibrary: return "照片"
        case .camera: return "拍照"
        case .file: return "文件"
        }
    }

    var icon: String {
        switch self {
        case .context: return "link.badge.plus"
        case .photoLibrary: return "photo.on.rectangle"
        case .camera: return "camera"
        case .file: return "doc"
        }
    }
}

#if DEBUG
/// 确定性的 Agent Runtime Composer 视觉夹具。通过
/// `--agent-runtime-composer-review` 启动，便于在不依赖登录、网络或执行设备的
/// 情况下，把 iOS 紧凑布局与 Electron 胶囊态逐轮截图对照。
struct AgentRuntimeComposerReviewRoot: View {
    @State private var text = ""

    private static let agent = ComposerTaskAgentOption(
        id: "default-agent",
        name: "默认 Agent",
        avatar: "默"
    )

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: TTSpacing.md) {
                Text("今天想和默认 Agent 一起完成什么？")
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .multilineTextAlignment(.center)

                ComposerView(
                    text: $text,
                    currentMode: "agent",
                    currentAgentName: Self.agent.name,
                    agentOptions: [Self.agent],
                    selectedAgentId: Self.agent.id,
                    agentIsMutable: true,
                    currentApprovalMode: "always_ask",
                    executionWorkspaceName: "默认 Workspace",
                    onSend: { _ in },
                    onCancel: {},
                    onPause: {},
                    onResume: {}
                )
            }
            Spacer(minLength: 0)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }
}
#endif
