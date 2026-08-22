import Foundation
import SwiftUI

/// 对话生图假进度：ease-out 指数逼近，封顶 92%；工具终态再冲到 100%。
/// 对齐 Electron `imageGeneratingProgress.ts`——连续浮点，供 scaleX 每帧平滑推进。
enum ImageGeneratingProgress {
    static let defaultTauMs: Double = 18_000

    static func compute(
        elapsedMs: Double,
        tauMs: Double = defaultTauMs,
        done: Bool
    ) -> Double {
        if done { return 100 }
        guard tauMs > 0, elapsedMs >= 0 else { return 0 }
        let raw = 100 * (1 - exp(-elapsedMs / tauMs))
        return min(92, raw)
    }
}

/// 主时间线文生图交付面：loading → 成品图 / 失败。
///
/// 对齐 Electron `MediaImageInlineCard`：有 URL 复用 `RichContentBlockCard`；
/// 后台仍在跑保持等待；终态无 URL 才失败。绝不渲染终端卡。
struct MediaImageInlineView: View {
    let tool: ToolCall
    var imageGallery: [RichImageGalleryItem] = []

    /// 与 Electron / agent-host `PROMPT_PREVIEW_MAX` 一致。
    static let promptPreviewMax = 80

    private var imageURL: String? {
        MediaImageGenerateResultParser.parse(tool.resultText)
            ?? MediaImageGenerateResultParser.parse(tool.visibleOutputText)
    }

    private var isBackgroundRunning: Bool {
        Self.isBackgroundRunningOutput(tool.resultText)
            || Self.isBackgroundRunningOutput(tool.visibleOutputText)
    }

    /// 终态 + 无 URL + 非 background running → 失败（假成功不留空白）。
    private var showsFailure: Bool {
        if imageURL != nil { return false }
        if isBackgroundRunning { return false }
        if tool.isError || tool.resolvedExecutionPhase == .failed { return true }
        return tool.resolvedExecutionPhase.isTerminal
    }

    private var truncatedPrompt: String? {
        Self.truncatedPromptPreview(tool.presentationPrompt)
    }

    var body: some View {
        Group {
            if let url = imageURL {
                RichContentBlockCard(block: imageBlock(url: url), imageGallery: effectiveGallery(url: url))
            } else if showsFailure {
                MediaImageFailedCanvas(
                    promptPreview: truncatedPrompt,
                    details: tool.visibleOutputText ?? tool.resultText
                )
            } else {
                MediaImageLoadingCanvas(promptPreview: truncatedPrompt)
            }
        }
        .accessibilityIdentifier("media-image-inline-card")
    }

    private func imageBlock(url: String) -> RichContentBlock {
        let summary = truncatedPrompt ?? L10n.Agent.mediaImageGenerating
        return RichContentBlock(
            messageId: nil,
            index: tool.index,
            kind: "image",
            summary: summary,
            title: nil,
            groupId: "media_image_\(tool.toolCallId)",
            tableRows: [],
            tableSchema: nil,
            footer: nil,
            resourceType: nil,
            resourceName: nil,
            resourceId: nil,
            spaceName: nil,
            url: url,
            filename: nil,
            mimeType: "image/png",
            fileSize: nil,
            totalRows: nil,
            widgetId: nil,
            format: nil,
            sourceCode: nil,
            mermaidSource: nil,
            query: nil,
            searchResults: [],
            totalCount: nil
        )
    }

    /// 确保合成图可进 gallery；父级 gallery 缺当前 URL 时补上，避免点按放大丢项。
    private func effectiveGallery(url: String) -> [RichImageGalleryItem] {
        let block = imageBlock(url: url)
        guard let current = RichImageGalleryItem(block: block) else { return imageGallery }
        if imageGallery.isEmpty { return [current] }
        if imageGallery.contains(where: { $0.url == current.url }) { return imageGallery }
        return imageGallery + [current]
    }

    /// ：wait_ms 耗尽时 output 可能仍带 `"status":"running"`，尚无 URL——保持 loading。
    static func isBackgroundRunningOutput(_ output: String?) -> Bool {
        guard let output, !output.isEmpty else { return false }
        return output.contains("\"status\":\"running\"")
            || output.contains("\"status\": \"running\"")
            || output.contains("\"backgrounded\":true")
            || output.contains("\"backgrounded\": true")
    }

    /// 展示用 prompt 截断（≤ `promptPreviewMax`，超出加省略号）。
    static func truncatedPromptPreview(_ prompt: String?) -> String? {
        guard let prompt, !prompt.isEmpty else { return nil }
        if prompt.count <= promptPreviewMax { return prompt }
        return String(prompt.prefix(promptPreviewMax)) + "…"
    }
}

// MARK: - Loading / Failed canvases
// 对齐 Electron `ImageGeneratingCard`：图位画布 + 底边假进度条（无百分比）。
// 整张卡只留一处持续动效（ L2），那一处是画布上的成形点云——所以运行态文案不再扫光。

/// 与 Electron `IMAGE_PREVIEW` 同比例（400×320），移动端限宽。
private enum MediaImageGeneratingLayout {
    static let aspectWidth: CGFloat = 400
    static let aspectHeight: CGFloat = 320
    static let maxWidth: CGFloat = 320
    static let progressBarHeight: CGFloat = 3

    /// 中央成形点云的边长。
    ///
    /// Electron 在 400 宽的图位里放 144（占框宽 36%）；iOS 图位限宽 320，同比例即 115。
    /// 再小会读成 spinner，再大就压过图位本身。
    static let shapingCloudSize: CGFloat = 115
}

private struct MediaImageLoadingCanvas: View {
    let promptPreview: String?
    /// 对齐 Electron ：挂载即锚定，后续不前移。
    @State private var anchorAt = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            // 跟显示刷新对齐（约 60fps），连续浮点 + scaleX，避免整数台阶发涩。
            // 点云与假进度共用这一个时钟：两套 60fps 时钟只会互相错拍并白烧电。
            TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                let elapsed = context.date.timeIntervalSince(anchorAt)
                let progress = ImageGeneratingProgress.compute(
                    elapsedMs: elapsed * 1000,
                    done: false
                )
                MediaImageGeneratingCanvas(
                    phase: .running,
                    progress: progress,
                    cloudPhase: reduceMotion
                        ? MediaImageShapingCloud.reducedMotionPhase
                        : CGFloat(max(0, elapsed)) * MediaImageShapingCloud.speed
                )
            }

            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "photo")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.textTertiary)
                // 与 ShinyText 的静态分支同色，撤掉扫光后观感不跳
                Text(L10n.Agent.mediaImageGenerating)
                    .foregroundStyle(Color.tt.textTertiary.opacity(ShinyTextMotion.mutedOpacity))
                    .font(ConversationTypography.metaFont)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            if let promptPreview, !promptPreview.isEmpty {
                Text(promptPreview)
                    .font(ConversationTypography.metaFont)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("media-image-generating-prompt")
            }
        }
        .frame(maxWidth: MediaImageGeneratingLayout.maxWidth, alignment: .leading)
    }
}

private struct MediaImageFailedCanvas: View {
    let promptPreview: String?
    let details: String?
    @State private var showDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            MediaImageGeneratingCanvas(phase: .failed, progress: 100)

            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "exclamationmark.circle")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.textCritical.opacity(0.7))
                Text(L10n.Agent.mediaImageFailed)
                    .font(ConversationTypography.metaFont)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }

            if let promptPreview, !promptPreview.isEmpty {
                Text(promptPreview)
                    .font(ConversationTypography.metaFont)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let details, !details.isEmpty {
                Button {
                    showDetails.toggle()
                } label: {
                    Text(showDetails ? L10n.Agent.mediaImageHideDetails : L10n.Agent.mediaImageViewDetails)
                        .font(ConversationTypography.metaFont)
                        .foregroundStyle(.tt.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("media-image-inline-toggle-details")

                if showDetails {
                    ScrollView {
                        Text(String(details.prefix(2000)))
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 160)
                    .padding(TTSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: TTRadius.sm)
                            .fill(.tt.bgSubtle)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: TTRadius.sm)
                            .strokeBorder(.tt.borderLight, lineWidth: 0.5)
                    )
                    .accessibilityIdentifier("media-image-inline-details")
                }
            }
        }
        .frame(maxWidth: MediaImageGeneratingLayout.maxWidth, alignment: .leading)
    }
}

private enum MediaImageGeneratingPhase {
    case running
    case failed
}

/// 图位画布 + 底边进度条（scaleX）。运行态中央跑成形点云，其余状态静态图标。
private struct MediaImageGeneratingCanvas: View {
    let phase: MediaImageGeneratingPhase
    let progress: Double
    /// 已乘过 `MediaImageShapingCloud.speed` 的相位；`nil` 表示不画点云（失败态）。
    var cloudPhase: CGFloat?

    @Environment(\.colorScheme) private var colorScheme

    private var fillFraction: CGFloat {
        CGFloat(max(0, min(100, progress))) / 100
    }

    var body: some View {
        ZStack {
            if let cloudPhase, phase == .running {
                // equatable：减弱动效下相位恒定，靠它跳过每帧重绘同一张图
                MediaImageShapingCloudView(phase: cloudPhase, dark: colorScheme == .dark)
                    .equatable()
            } else {
                Image(systemName: "photo")
                    .font(.tt.iconEmptyMD)
                    .foregroundStyle(
                        phase == .failed
                            ? Color.tt.textCritical.opacity(0.45)
                            : Color.tt.textTertiary.opacity(0.7)
                    )
                    .accessibilityHidden(true)
            }

            VStack {
                Spacer(minLength: 0)
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(Color.tt.textPrimary.opacity(0.1))
                    Rectangle()
                        .fill(
                            phase == .failed
                                ? Color.tt.textCritical.opacity(0.6)
                                : Color.tt.textPrimary.opacity(0.45)
                        )
                        .frame(maxWidth: .infinity)
                        .scaleEffect(x: fillFraction, y: 1, anchor: .leading)
                        .accessibilityIdentifier("media-image-generating-progress-bar")
                }
                .frame(height: MediaImageGeneratingLayout.progressBarHeight)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(
            MediaImageGeneratingLayout.aspectWidth / MediaImageGeneratingLayout.aspectHeight,
            contentMode: .fit
        )
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .fill(
                    phase == .failed
                        ? Color.tt.textCritical.opacity(0.06)
                        : Color.tt.bgSubtle
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(
                    phase == .failed
                        ? Color.tt.textCritical.opacity(0.3)
                        : Color.tt.borderLight,
                    lineWidth: 0.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.md))
        .accessibilityIdentifier("media-image-generating-canvas")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            phase == .failed
                ? L10n.Agent.mediaImageFailed
                : L10n.Agent.mediaImageGenerating
        )
        .accessibilityValue("\(Int(progress.rounded()))%")
    }
}

/// 「图正在成形」点云。数学在 `MediaImageShapingCloud`，这里只负责缩放与落色。
private struct MediaImageShapingCloudView: View, Equatable {
    /// 已乘过 `MediaImageShapingCloud.speed` 的相位。
    let phase: CGFloat
    let dark: Bool

    /// 恒定灰阶，故意不接主题色：点云只说「在干活」，不承载颜色语义（要不要用户出手由色点管）。
    /// 数值等于上游 `resolveOrbDotInk` 对 `ink = 0.1` 的解析结果，跨端同色。
    private var ink: Color {
        dark
            ? Color(red: 230.0 / 255, green: 230.0 / 255, blue: 230.0 / 255)
            : Color(red: 26.0 / 255, green: 26.0 / 255, blue: 26.0 / 255)
    }

    var body: some View {
        let side = MediaImageGeneratingLayout.shapingCloudSize
        let scale = side / MediaImageShapingCloud.presetSize
        let color = ink
        Canvas { context, _ in
            for dot in MediaImageShapingCloud.dots(t: phase) {
                let radius = dot.r * scale
                let rect = CGRect(
                    x: dot.x * scale - radius,
                    y: dot.y * scale - radius,
                    width: radius * 2,
                    height: radius * 2
                )
                context.fill(Path(ellipseIn: rect), with: .color(color))
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }

    // nonisolated：`View` 是 main actor 隔离的，`==` 不脱离隔离就跨界报数据竞争；
    // 这里只比两个值类型字段，天然安全。
    nonisolated static func == (
        lhs: MediaImageShapingCloudView,
        rhs: MediaImageShapingCloudView
    ) -> Bool {
        lhs.phase == rhs.phase && lhs.dark == rhs.dark
    }
}
