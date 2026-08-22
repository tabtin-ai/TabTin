import SwiftUI

/// 云文档资源类型图标。
///
/// 用无白底内容字形（`AppGlyphTabdoc` / `AppGlyphTabdata`），不是带底座的完整 App icon，
/// 也不是 emoji / 主题色 SF Symbol。缺字形时才退回 SF Symbol。
///
/// `itemType` 容忍后端各路别名（tabdoc / doc / document、tabdata / table）：
/// 分享给我的资源用的是 `SharedResourceType` 的 doc / table，知识树用的是 tabdoc / tabdata，
/// 这里统一先经 `SpaceResource.normalizedType` 归一再找资产，否则别名会全部掉进 fallback。
struct CloudDocsAppIcon: View {
    /// 列表行里的标准类型底座边长。行的分隔线缩进要按它算，所以是具名常量而非字面量。
    static let defaultSize: CGFloat = 40

    let itemType: String
    var size: CGFloat = CloudDocsAppIcon.defaultSize

    var body: some View {
        ZStack {
            Circle()
                .fill(backgroundColor)

            AppIconImage(reference: reference, size: size * 0.55)
        }
        .frame(width: size, height: size)
    }

    private var normalizedType: String { SpaceResource.normalizedType(itemType) }

    private var backgroundColor: Color {
        normalizedType == "tabdata" ? .tt.bgCloudTableIcon : .tt.bgCloudDocIcon
    }

    private var reference: AppIconReference {
        let appId = normalizedType
        return AppIconResolver.resolveContentGlyph(
            appId: appId,
            manifestIcon: SpaceResource.icon(forType: appId)
        )
    }
}

/// 云文档列表的统一行，三个分段共用。
///
/// - 知识树：传 `depth` 做层级缩进，传 `isExpandable` / `isExpanded` 出展开箭头。
/// - 最近：`subtitle` 放访问时间，`reservesDisclosureSpace` 传 `false` 让图标贴左。
/// - 分享给我：`subtitle` 放「由某某分享」，同样不占展开列。
///
/// 行本身不带点击手势——外层负责「打开资源」，这里只暴露展开箭头的回调，
/// 避免两层手势在同一块区域打架。
struct CloudDocsRow: View {
    let title: String
    let itemType: String
    /// 标题下方的第二行，放归属类信息（「由某某分享」、搜索命中的路径）。
    let subtitle: String?
    /// 行尾右对齐的元信息，放「最近修改：时间」。
    ///
    /// 时间**不能**塞进 `subtitle`：那会把每行撑成两行高，五行列表看着松散又空，
    /// 而右侧一列既紧凑又让不同行的时间自然对齐、便于纵向扫读。
    var meta: String?
    /// 「分享给我」才传：排成「由 [头像] 名字 分享」。
    var sharer: CloudDocsSharerAvatar? = nil
    var depth: Int = 0
    var isPinned: Bool = false
    var isExpandable: Bool = false
    var isExpanded: Bool = false
    var isLoadingChildren: Bool = false
    /// 仅当该行需要保持展开列对齐时才占住该列。叶子节点不预留，避免“全部”页
    /// 的文档图标相对最近 / 分享页无意义地右移。
    var reservesDisclosureSpace: Bool = true
    var onToggleExpand: (() -> Void)?

    /// HIG 最小点击热区。只用于按钮类子元素，不当行高使——两者语义不同，
    /// 行高按 demo 走 48pt。
    private static let minHitSize: CGFloat = 44

    /// 40pt 类型底座配两行文字，保持足够的上下呼吸空间。
    private static let minRowHeight: CGFloat = 64

    /// 展开箭头这一列的宽度，对齐 demo 的 `.row-chevron { width: 20px }`。
    /// 不复用 `TTSpacing.xl`——那是间距语义，设计师调间距不该连带改这里的列宽。
    static let disclosureWidth: CGFloat = 20

    /// 行内左右内边距，对齐 demo 的 `.row { padding: 8px 12px }`。
    static let horizontalPadding: CGFloat = TTSpacing.md

    /// 行尾要放下「最近修改：3 分钟前」这类带语义的时间，比裸相对时间更宽。
    private static let metaMaxWidth: CGFloat = 176
    fileprivate static let sharerAvatarSize: CGFloat = 18

    /// 分隔线从标题文字处起，不横穿展开箭头和类型底座。
    static let separatorLeadingInset: CGFloat = 60

    /// 每层缩进一个 `lg`，与 Electron 知识树同步。
    private var indent: CGFloat { CGFloat(depth) * TTSpacing.lg }

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            disclosure

            CloudDocsAppIcon(itemType: itemType)

            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xxs) {
                    if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.tt.iconCaptionMedium)
                            .foregroundStyle(.tt.iconAccent)
                            .accessibilityLabel(L10n.CloudDocs.actionPin)
                    }
                    Text(title)
                        .font(.tt.subtitleSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                }
                if let sharer {
                    CloudDocsSharedByLine(sharer: sharer)
                } else if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            // 留白只加在文字上：展开列已经占了 44pt 热区，行级 padding 会把整行顶到 60pt。
            .padding(.vertical, TTSpacing.xs)

            Spacer(minLength: TTSpacing.sm)

            if let meta, !meta.isEmpty {
                Text(meta)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                    .frame(maxWidth: Self.metaMaxWidth, alignment: .trailing)
                    .layoutPriority(1)
            }
        }
        .padding(.horizontal, Self.horizontalPadding)
        .padding(.leading, indent)
        .frame(minHeight: Self.minRowHeight)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var disclosure: some View {
        if isExpandable {
            Button {
                onToggleExpand?()
            } label: {
                Group {
                    if isLoadingChildren {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "chevron.right")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .frame(width: Self.disclosureWidth, height: Self.minHitSize)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isExpanded ? L10n.CloudDocs.collapse : L10n.CloudDocs.expand)
        } else if reservesDisclosureSpace {
            Color.clear.frame(width: Self.disclosureWidth, height: Self.minHitSize)
        }
    }
}

private struct CloudDocsSharedByLine: View {
    let sharer: CloudDocsSharerAvatar

    var body: some View {
        HStack(spacing: TTSpacing.xxs) {
            Text(L10n.CloudDocs.sharedByPrefix)
            IdentityColorAvatar(
                name: sharer.name,
                seed: sharer.seed,
                imageUrl: sharer.imageUrl,
                size: CloudDocsRow.sharerAvatarSize
            )
            Text(sharer.name)
                .lineLimit(1)
            if !L10n.CloudDocs.sharedBySuffix.isEmpty {
                Text(L10n.CloudDocs.sharedBySuffix)
            }
        }
        .font(.tt.captionMedium)
        .foregroundStyle(.tt.textTertiary)
    }
}
