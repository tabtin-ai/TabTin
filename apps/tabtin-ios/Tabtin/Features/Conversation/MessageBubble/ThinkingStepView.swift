import Observation
import SwiftUI
@preconcurrency import MarkdownUI

// MARK: - Electron / React Bits aligned shiny text
// @see https://reactbits.dev/text-animations/shiny-text
// Electron: apps/tabtin-electron/.../globals.css `.thinking-shiny-text`

/// 对齐 React Bits / Electron 的视觉模型：
/// `linear-gradient(120deg, …)` + `background-size: 200%` + `background-clip: text`。
/// 产品口径：高光**从左扫到右**（与 Electron CSS 注释「右→左」相反，以真机观感为准）。
///
/// 相位用**进程级绝对时间**算，不绑 `@State` / `onAppear`——tip 每帧重建时相位连续。
///
/// ⚠️ 2w 渐变只能在 `-w…0` 内平移：越界会滑出文字视口（clear Text + mask → 整段消失）。
enum ShinyTextMotion {
    /// CSS `background-size: 200% auto`
    static let backgroundSizeMultiplier: CGFloat = 2
    /// Electron: muted 40% / foreground 50% / muted 60%
    static let gradientLocations: [CGFloat] = [0, 0.4, 0.5, 0.6, 1]
    /// 静止态 / 扫光基色不透明度。Electron 用 0.60 / 0.55，但移动端小屏上
    /// tertiary 再叠 0.6 几乎不可读（dogfood 反馈「步骤行太浅」），iOS 加深为
    /// 0.9 / 0.8；高光 0.92 与桌面一致。
    static let mutedOpacity: CGFloat = 0.9
    static let bandMutedOpacity: CGFloat = 0.8
    static let highlightOpacity: CGFloat = 0.92
    private static let electronAngleRadians = 120.0 * Double.pi / 180.0

    /// 进程级纪元：所有 ShinyText 实例共享同一时钟，重建不重置扫光位置。
    static let epoch = Date()

    static func phase(at date: Date, duration: TimeInterval) -> CGFloat {
        let cycle = max(duration, 0.01)
        let elapsed = date.timeIntervalSince(epoch)
        let wrapped = elapsed.truncatingRemainder(dividingBy: cycle)
        let normalized = wrapped >= 0 ? wrapped : wrapped + cycle
        return CGFloat(normalized / cycle)
    }

    /// 2w 渐变左对齐后的水平位移：phase 0→1 时从 `-w` 到 `0`。
    /// 高光在渐变正中（x=w），故 phase0 落在视口左缘、phase1 落在右缘 → 左→右。
    /// 全程视口 [0,w] 都被渐变覆盖，不会整段透明。
    static func gradientOffsetX(phase: CGFloat, textWidth: CGFloat) -> CGFloat {
        let width = max(textWidth, 1)
        let clamped = min(max(phase, 0), 1)
        return -width * (1 - clamped)
    }

    static func gradientFrameWidth(forTextWidth width: CGFloat) -> CGFloat {
        max(width * backgroundSizeMultiplier, 1)
    }

    /// CSS 120° → SwiftUI UnitPoint（magic-corners 线长公式）。
    static func gradientAxis(tileWidth: CGFloat, height: CGFloat) -> (
        start: UnitPoint,
        end: UnitPoint
    ) {
        let safeWidth = max(tileWidth, 1)
        let safeHeight = max(height, 1)
        let directionX = CGFloat(sin(electronAngleRadians))
        let directionY = CGFloat(-cos(electronAngleRadians))
        let lineLength = abs(safeWidth * directionX) + abs(safeHeight * directionY)
        let deltaX = lineLength * directionX / safeWidth
        let deltaY = lineLength * directionY / safeHeight
        return (
            UnitPoint(x: 0.5 - deltaX / 2, y: 0.5 - deltaY / 2),
            UnitPoint(x: 0.5 + deltaX / 2, y: 0.5 + deltaY / 2)
        )
    }

    static func shouldAnimate(
        active: Bool,
        isVisible: Bool = true,
        isCoordinatedActive: Bool = true,
        reduceMotion: Bool
    ) -> Bool {
        active && isVisible && isCoordinatedActive && !reduceMotion
    }
}

/// 对齐 Electron `syncActiveShinyText`（`ShinyText.tsx`）：一屏里思考行和多张工具卡
/// 可能同时处于运行态，全部一起扫光会让整屏发亮、注意力彻底失焦。所以进程内只让
/// **最后出现**的那一条真正扫光，其余退回静态 muted 文字。
@MainActor
@Observable
final class ShinyTextCoordinator {
    static let shared = ShinyTextCoordinator()

    private(set) var activeToken: Int?
    @ObservationIgnored private var tokens: [Int] = []
    @ObservationIgnored private var lastIssuedToken = 0

    init() {}

    func register() -> Int {
        lastIssuedToken += 1
        tokens.append(lastIssuedToken)
        activeToken = tokens.last
        return lastIssuedToken
    }

    func unregister(_ token: Int) {
        tokens.removeAll { $0 == token }
        activeToken = tokens.last
    }

    func isActive(_ token: Int?) -> Bool {
        guard let token else { return false }
        return activeToken == token
    }
}

/// React Bits / Electron ShinyText 的 iOS 实现。
///
/// - 视觉：与 CSS `background-clip:text` + 滑动 `background-position` 同构
/// - 时钟：`ShinyTextMotion.epoch` 绝对时间，tip 重建不重置相位
/// - 协调：`ShinyTextCoordinator` 同屏只让最后一条扫光
struct ShinyText: View {
    let text: String
    var active = true
    var duration: TimeInterval = 1.6

    /// 默认可tip 重建时若先画一帧再 onAppear，`false` 会先走静态分支再切扫光，
    /// 看起来像闪一下。离屏由 onDisappear 关掉动画即可。
    @State private var isVisible = true
    @State private var coordinationToken: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var mutedColor: Color {
        Color.tt.textTertiary.opacity(ShinyTextMotion.mutedOpacity)
    }

    var body: some View {
        Group {
            if ShinyTextMotion.shouldAnimate(
                active: active,
                isVisible: isVisible,
                isCoordinatedActive: ShinyTextCoordinator.shared.isActive(coordinationToken),
                reduceMotion: reduceMotion
            ) {
                // 30fps 足够表现扫光；相位来自绝对时间，重建不会跳回起点。
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    let phase = ShinyTextMotion.phase(at: context.date, duration: duration)
                    shinyGlyphs(phase: phase)
                }
            } else {
                // 静态态也必须有可见字形；扫光分支用 clear Text + mask，绝不能在无覆盖时落到这里闪空。
                Text(text)
                    .foregroundStyle(mutedColor)
            }
        }
        .accessibilityLabel(text)
        .onAppear {
            isVisible = true
            if coordinationToken == nil {
                coordinationToken = ShinyTextCoordinator.shared.register()
            }
        }
        .onDisappear {
            isVisible = false
            if let token = coordinationToken {
                ShinyTextCoordinator.shared.unregister(token)
                coordinationToken = nil
            }
        }
    }

    /// 透明文字定尺寸 + 2× 宽渐变在 `-w…0` 内平移 + mask（≈ background-clip）。
    private func shinyGlyphs(phase: CGFloat) -> some View {
        Text(text)
            .foregroundStyle(.clear)
            .overlay {
                GeometryReader { geo in
                    let textWidth = max(geo.size.width, 1)
                    let textHeight = max(geo.size.height, 1)
                    let frameWidth = ShinyTextMotion.gradientFrameWidth(forTextWidth: textWidth)
                    let axis = ShinyTextMotion.gradientAxis(
                        tileWidth: frameWidth,
                        height: textHeight
                    )
                    LinearGradient(
                        stops: [
                            .init(
                                color: Color.tt.textTertiary.opacity(ShinyTextMotion.bandMutedOpacity),
                                location: ShinyTextMotion.gradientLocations[0]
                            ),
                            .init(
                                color: Color.tt.textTertiary.opacity(ShinyTextMotion.bandMutedOpacity),
                                location: ShinyTextMotion.gradientLocations[1]
                            ),
                            .init(
                                color: Color.tt.textPrimary.opacity(ShinyTextMotion.highlightOpacity),
                                location: ShinyTextMotion.gradientLocations[2]
                            ),
                            .init(
                                color: Color.tt.textTertiary.opacity(ShinyTextMotion.bandMutedOpacity),
                                location: ShinyTextMotion.gradientLocations[3]
                            ),
                            .init(
                                color: Color.tt.textTertiary.opacity(ShinyTextMotion.bandMutedOpacity),
                                location: ShinyTextMotion.gradientLocations[4]
                            ),
                        ],
                        startPoint: axis.start,
                        endPoint: axis.end
                    )
                    .frame(width: frameWidth, height: textHeight, alignment: .leading)
                    .offset(x: ShinyTextMotion.gradientOffsetX(phase: phase, textWidth: textWidth))
                    // 裁到文字宽度，避免渐变伸出；并保证视口始终有像素可 mask。
                    .frame(width: textWidth, height: textHeight, alignment: .leading)
                    .clipped()
                }
                .mask(Text(text))
                .allowsHitTesting(false)
            }
    }
}

/// 会话中间步骤的统一文案。思考与工具共用同一字号、字重、颜色和执行态动效，
/// 避免不同卡片各自套字体后产生视觉漂移。
struct ConversationStepLabel: View {
    let text: String
    var detail: String? = nil
    var isRunning = false

    var body: some View {
        Group {
            if isRunning {
                ShinyText(text: composedText)
            } else if let detail, !detail.isEmpty {
                (
                    Text(text)
                        .foregroundStyle(Color.tt.textPrimary)
                    + Text(" · \(detail)")
                        .foregroundStyle(Color.tt.textTertiary)
                )
            } else {
                Text(text)
                    .foregroundStyle(Color.tt.textTertiary.opacity(ShinyTextMotion.mutedOpacity))
            }
        }
        .font(ConversationTypography.stepFont)
        .lineSpacing(ConversationTypography.stepLineSpacing)
        .lineLimit(1)
        .truncationMode(.tail)
    }

    private var composedText: String {
        if let detail, !detail.isEmpty {
            return "\(text) · \(detail)"
        }
        return text
    }
}

// MARK: - Thinking step row

/// 思考块是独立于工具的内容时间线单元。把它的可见状态集中在这里，避免流式/完成态的
/// 文案、内容可见性和动画条件在 View 内分叉后再被误归类为 tool 状态。
enum ThinkingStepState: Equatable {
    case streaming
    case completed(elapsedSeconds: Int?)
}

enum ThinkingStepPresentation {
    static func state(for segment: ThinkingSegment) -> ThinkingStepState {
        guard segment.completed else { return .streaming }
        guard let elapsed = segment.elapsedSeconds, elapsed >= 1 else {
            return .completed(elapsedSeconds: nil)
        }
        return .completed(elapsedSeconds: max(1, Int(elapsed.rounded())))
    }

    /// 时间线内联只保留**流式 66pt 预览**；全文（流式与完成）一律进底部抽屉。
    static func showsInlinePreview(state: ThinkingStepState) -> Bool {
        if case .streaming = state { return true }
        return false
    }

    /// 标题行与抽屉标题共用同一文案，避免两处各自拼接后漂移。
    static func label(for state: ThinkingStepState) -> String {
        switch state {
        case .streaming:
            return L10n.Agent.thinkingInProgress
        case .completed(let elapsedSeconds):
            guard let elapsedSeconds else { return L10n.Agent.thinkingCompleted }
            return L10n.Agent.thinkingCompletedIn(elapsedSeconds)
        }
    }
}

/// 流式思考预览辅助。
///
/// 旧实现用二阶 typewriter（`.task(id: 全文)` + sleep）平滑揭示，但 16ms publish
/// 会持续取消 task，进度长期不前，完成瞬间 snap 成「整段倾泻」。现改为：
/// - 流式预览直接跟权威全文（无二阶动画）
/// - 固定高预览只 layout **尾部字符预算**，避免每帧对整段 thinking 做 Text 测高
enum ThinkingStreamReveal {
    /// 66pt 预览窗口够用的 Character 预算（含中英混排余量）。
    static let previewCharacterBudget = 720

    static func previewTail(_ text: String, maxCharacters: Int = previewCharacterBudget) -> String {
        guard maxCharacters > 0, text.count > maxCharacters else { return text }
        let start = text.index(text.endIndex, offsetBy: -maxCharacters, limitedBy: text.startIndex)
            ?? text.startIndex
        return String(text[start...])
    }

    /// 保留给单测 / 工具函数的渐进步进（UI 已不再驱动 typewriter）。
    static func nextVisibleCount(current: Int, target: Int) -> Int {
        guard target > current else { return max(0, target) }
        let backlog = target - current
        let advance = max(1, Int((Double(backlog) * 0.12).rounded()))
        return min(target, current + advance)
    }

    static func visibleText(_ text: String, characterCount: Int) -> String {
        String(text.prefix(max(0, min(characterCount, text.count))))
    }
}

/// 思考过程段。与 Electron ThinkingBlockView 的差异（移动端阅读增强，见 parity 文档）：
/// - 运行中默认展示 66pt 的最新内容预览，让用户知道 Agent 没卡死；
/// - **全文一律进底部抽屉**（`ExecutionDetailSheet`，与工具执行详情同一个容器），
///   不再在时间线内联展开，长推理不会把后续回复和 Composer 顶出屏幕；
/// - 点按标题行打开抽屉：流式为实时纯文本，完成后为 Markdown；
/// - Brain 表达语义，chevron 表示「可打开详情」。
struct ThinkingStepView: View {
    let segment: ThinkingSegment

    @State private var showDetailSheet = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 流式空 thinking 不渲染，交给 `AwaitingThinkingView`（planningNext / pending），
    /// 避免与等待壳双 Brain 行，也避免把已 settle 的执行组挤到下面。
    private var shouldRender: Bool {
        segment.completed || AgentAwaitingThoughtPresentation.hasVisibleThinkingBody(segment)
    }

    var body: some View {
        if shouldRender {
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Button {
                    showDetailSheet = true
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        ThinkingStatusIcon()

                        ConversationStepLabel(
                            text: ThinkingStepPresentation.label(for: thinkingState),
                            isRunning: !segment.completed
                        )

                        Image(systemName: "chevron.right")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, TTSpacing.xxs)
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(L10n.Agent.thinkingDetailHint)

                if showsInlinePreview, !segment.text.isEmpty {
                    streamingPreview
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.24),
                value: thinkingState
            )
            .sheet(isPresented: $showDetailSheet) {
                ExecutionDetailSheet(blocks: [.thinking(segment)])
            }
        }
    }

    private var thinkingState: ThinkingStepState {
        ThinkingStepPresentation.state(for: segment)
    }

    private var showsInlinePreview: Bool {
        ThinkingStepPresentation.showsInlinePreview(state: thinkingState)
    }

    /// 流式尾部预览：固定 66pt 窗口，只 layout 尾部字符预算。
    private var streamingPreview: some View {
        Text(ThinkingStreamReveal.previewTail(segment.text))
            .font(ConversationTypography.stepFont)
            .lineSpacing(ConversationTypography.stepLineSpacing)
            .foregroundStyle(.tt.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(height: 66, alignment: .bottomLeading)
            .clipped()
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black, location: 0.22),
                        .init(color: .black, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .opacity(0.68)
            .padding(.leading, TTSpacing.sm)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(.tt.borderLight)
                    .frame(width: 1)
            }
            .padding(.leading, TTSpacing.xs)
            .padding(.bottom, TTSpacing.xxs)
    }
}

// MARK: - Thinking detail content

enum ThinkingDetailContentPolicy {
    enum RenderingMode: Equatable {
        case markdown
        case chunkedPlainText
    }

    static let markdownCharacterLimit = 4_000
    static let plainTextChunkSize = 1_600

    static func renderingMode(characterCount: Int) -> RenderingMode {
        characterCount < markdownCharacterLimit ? .markdown : .chunkedPlainText
    }

    static func plainTextChunks(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var chunks: [String] = []
        var start = text.startIndex

        while start < text.endIndex {
            let end = text.index(
                start,
                offsetBy: plainTextChunkSize,
                limitedBy: text.endIndex
            ) ?? text.endIndex
            chunks.append(String(text[start..<end]))
            start = end
        }
        return chunks
    }
}

/// 思考全文正文。时间线只留锚点行，长推理都在 `ExecutionDetailSheet` 里读：
/// - 流式：纯文本随权威全文实时更新（父视图重算时 sheet 内容同步刷新）；
/// - 完成短内容：Markdown（与旧内联展开同一主题）；
/// - 完成长内容：分块纯文本，避免键盘/选择变化同步重排整段 Markdown 与 CoreText。
struct ThinkingDetailContent: View {
    let segment: ThinkingSegment

    var body: some View {
        Group {
            if segment.completed,
               ThinkingDetailContentPolicy.renderingMode(characterCount: segment.text.count) == .markdown {
                Markdown(segment.text)
                    .markdownTheme(
                        .tabtinThinking(fontSize: ConversationTypography.bodySize)
                    )
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(
                        Array(ThinkingDetailContentPolicy.plainTextChunks(segment.text).enumerated()),
                        id: \.offset
                    ) { _, chunk in
                        Text(chunk)
                            .font(ConversationTypography.stepFont)
                            .lineSpacing(ConversationTypography.stepLineSpacing)
                            .foregroundStyle(.tt.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button {
                UIPasteboard.general.string = segment.text
            } label: {
                Label("复制全文", systemImage: "doc.on.doc")
            }
        }
    }
}

/// message_start / 工具 settle 后的即时反馈，对齐 Electron AgentAwaitingThought。
struct AwaitingThinkingView: View {
    enum Mode: Equatable {
        /// 尚无有效块：首段「思考中…」
        case thinking
        /// 工具已 settle、下一轮 thinking 正文未到：「正在计划下一步...」
        case planningNext
    }

    var mode: Mode = .thinking

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            ThinkingStatusIcon()
            ConversationStepLabel(
                text: mode == .planningNext
                    ? L10n.Agent.thinkingPlanningNext
                    : L10n.Agent.thinkingInProgress,
                isRunning: true
            )
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            mode == .planningNext
                ? L10n.Agent.thinkingPlanningNext
                : L10n.Agent.thinkingInProgress
        )
    }
}

private struct ThinkingStatusIcon: View {
    var body: some View {
        // Electron 与 iOS 共用 Lucide Brain；持续动效只作用于相邻文字。
        ConversationStepIcon(name: "Brain")
            .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("思考步骤") {
    ScrollView {
        VStack(alignment: .leading, spacing: TTSpacing.lg) {
            ThinkingStepView(
                segment: ThinkingSegment(
                    messageId: "preview-streaming",
                    index: 0,
                    text: "正在检查工具结果，并整理下一步执行计划……",
                    completed: false
                )
            )

            ThinkingStepView(
                segment: ThinkingSegment(
                    messageId: "preview-completed",
                    index: 1,
                    text: """
                    ### 分析结果

                    思考正文应与状态文字保持相同字号，**强调内容只增加字重**，不会改变字号。

                    - 工具摘要保持灰色
                    - 点击状态行可展开或收起
                    """,
                    completed: true
                )
            )
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color(uiColor: .systemBackground))
}
#endif
