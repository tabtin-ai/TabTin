package com.tabtin.mobile.features.conversation

import android.content.Intent
import android.net.Uri
import android.text.format.Formatter
import android.util.Log
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Slideshow
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.Language
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.isHttpImageUrl
import com.tabtin.mobile.features.clouddocs.AppIconResolver
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent

@Composable
internal fun RichContentSection(
    blocks: List<BlockItem>,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        blocks.forEach { block ->
            when (block.kind) {
                "image" -> RichImage(block)
                "table_preview" -> RichTablePreview(block)
                "resource_ref" -> RichResourceRef(
                    block = block,
                    currentSpaceId = currentSpaceId,
                    currentOrganizationId = currentOrganizationId,
                    onOpenInWorkbench = onOpenInWorkbench,
                )
                "file" -> RichFile(block)
                "widget" -> RichWidget(block)
                else -> RichFallback(block)
            }
        }
    }
}

/**
 * Widget Wave 4 Android 渲染（widget RFC §五 4.9 / 4.11）。
 *
 * 三种渲染路径（按 `block.imageUrl` 状态分流）：
 *   1. **有 imageUrl**：内联显示烤图 + `clickable` → `ImagePreviewDialog` 全屏（沿用
 *      附件流 `MessageAttachments` 体验，双指缩放 / 保存 / 分享）。这是绝大多数用户
 *      在 chat 拉桌面端历史时看到的体验。
 *   2. **无 imageUrl（空串 / 缺字段）**：A 子 Agent 烤图失败兜底信号——显示 widget 容器
 *      + summary + 明显的"在桌面端查看"按钮。点击 Toast 提示用户切到桌面端。
 *   3. **imageUrl 网络/格式错误**：AsyncImage `painter.state` 走 Error 分支显示
 *      widget_image_load_failed 文案占位。
 *
 * 双端视觉一致性：用布局流中的纯文字“图示”标识类型，不叠系统图标或浮层角标；
 * 拉桌面端历史的用户仍能识别内容类型，同时避免装饰性图标和固定占位挤压正文。
 *
 * 不做的事（与 RFC §决策 10 移动端不做实时同步流式 widget 一致）：
 *   - 不订阅 `tool_call_args_delta`——只接 final RICH_CONTENT 的 image_url
 *   - 不做 sendPrompt 转发（移动端拉到的是图片不是 SVG，不能点击）
 */
@Composable
private fun RichWidget(block: BlockItem) {
    val context = LocalContext.current
    val widgetBadgeText = stringResource(R.string.rich_content_widget_badge)
    // **关键 remember key**：widgetBadgeText 是 stringResource 的返回值——locale 切换时
    // stringResource 在 recomposition 时拿到新 locale 的"图示" / "Widget"，必须把它加入
    // remember key 让 plan 重新计算。否则 plan.accessibilityLabel 会留旧 locale 的字面值
    // → TalkBack 切语言后仍朗读旧"图示"。三视角 Review C #3 真 bug。
    //
    // Mobile 对齐 Wave 新增 key：block.format / block.mermaidSource / block.sourceCode
    // 影响 plan.mermaidFallbackSource；同一 widget block 在服务端 emit Mermaid 编译
    // 完毕后 `code` 字段会被编译成 SVG 字符串，`mermaid_source` 会被补进来，keyring
    // 必须把这些字段都纳入才能重新计算 plan（否则源码折叠面板永远不出现）。
    val plan = remember(
        block.imageUrl,
        block.title,
        block.summary,
        block.format,
        block.mermaidSource,
        block.sourceCode,
        widgetBadgeText,
    ) {
        planWidgetRender(
            widgetBadgeLabel = widgetBadgeText,
            title = block.title,
            summary = block.summary,
            imageUrl = block.imageUrl,
            format = block.format,
            mermaidSource = block.mermaidSource,
            sourceCode = block.sourceCode,
        )
    }
    var showFullScreen by remember(plan.imageUrl) { mutableStateOf(false) }

    if (plan.imageUrl != null) {
        // image 路径：父容器走 mergeDescendants 让 TalkBack 一次朗读完整 plan.accessibilityLabel
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.md)
                .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
                .semantics { contentDescription = plan.accessibilityLabel },
        ) {
            WidgetBadge(modifier = Modifier.padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs))
            WidgetImageBlock(
                imageUrl = plan.imageUrl,
                summary = plan.visibleSummary,
                contentDescription = plan.accessibilityLabel,
                onTap = { showFullScreen = true },
            )
        }
    } else {
        // fallback 路径：父容器**不设 contentDescription**，让"在桌面端查看"按钮能独立 focus
        // （Wave 4 Review 修复：之前父级 contentDescription 把按钮可点击语义吞掉，TalkBack
        // 用户难以单独激活按钮）。
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.md)
                .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant)),
        ) {
            WidgetBadge(modifier = Modifier.padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs))
            // mermaid widget 无烤图时本地渲染（对齐 iOS RichWidgetView / Electron），
            // 渲染失败再落到「在桌面端查看」说明卡。
            val fallbackContent: @Composable () -> Unit = {
                WidgetBakeFailedFallback(
                    title = plan.visibleTitle,
                    summary = plan.visibleSummary,
                    widgetId = block.widgetId,
                    mermaidFallbackSource = plan.mermaidFallbackSource,
                    onOpenOnDesktopTap = {
                        android.widget.Toast.makeText(
                            context,
                            context.getString(R.string.rich_content_widget_open_on_desktop_hint),
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    },
                )
            }
            if (plan.mermaidFallbackSource != null) {
                MermaidBlockView(code = plan.mermaidFallbackSource) {
                    fallbackContent()
                }
            } else {
                fallbackContent()
            }
        }
    }

    if (showFullScreen && plan.imageUrl != null) {
        ImagePreviewDialog(
            imageUrl = plan.imageUrl,
            filename = plan.visibleTitle,
            onDismiss = { showFullScreen = false },
        )
    }
}

@Composable
private fun WidgetBadge(modifier: Modifier = Modifier) {
    Text(
        text = stringResource(R.string.rich_content_widget_badge),
        style = TTFonts.captionSemibold,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        modifier = modifier,
    )
}

@Composable
private fun WidgetImageBlock(
    imageUrl: String,
    summary: String?,
    contentDescription: String,
    onTap: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
    ) {
        var loadState by remember(imageUrl) {
            mutableStateOf<AsyncImagePainter.State?>(null)
        }
        when (loadState) {
            is AsyncImagePainter.State.Error -> {
                WidgetImageLoadFailedView(imageUrl = imageUrl)
            }
            else -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 160.dp)
                        .clip(TTRadius.Shapes.sm)
                        .clickable(onClick = onTap)
                        .padding(horizontal = TTSpacing.xs),
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = imageUrl,
                        // Wave 4 Review 修复：之前 contentDescription = null + 外层 Box
                        // 朗读，TalkBack 用户对图片可点击区域听不到完整朗读（被 mergeDescendants
                        // 默认行为忽略）。改用 plan.accessibilityLabel 让图片本身有完整语义。
                        contentDescription = contentDescription,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxWidth(),
                        onState = { state ->
                            loadState = state
                            if (state is AsyncImagePainter.State.Error) {
                                Log.w(
                                    "RichWidget",
                                    "image load failed url=${imageUrl.take(80)}",
                                )
                            }
                        },
                    )
                    // Wave 4 Review 修复（Android P1）：之前没 loading placeholder 让弱网用户
                    // 看到空白区域。Coil onState Loading 期间显示 CircularProgressIndicator
                    // 让用户知道"图片正在下载"而不是"卡片坏了"。
                    if (loadState is AsyncImagePainter.State.Loading || loadState == null) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp,
                            color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                        )
                    }
                }
            }
        }

        if (summary != null) {
            // 图片下方 caption 区——与桌面端 RichWidget `block.summary && finalCode` 分支
            // 字面对齐（小一号灰色文字）。
            Text(
                text = summary,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            )
        }
    }
}

@Composable
private fun WidgetImageLoadFailedView(imageUrl: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 160.dp)
            .clip(TTRadius.Shapes.sm)
            .padding(horizontal = TTSpacing.xs),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            Icon(
                imageVector = Icons.Filled.BrokenImage,
                contentDescription = null,
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.size(24.dp),
            )
            Text(
                text = stringResource(R.string.rich_content_widget_image_load_failed),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
    }
}

/**
 * 烤图失败兜底（widget RFC §五 4.11）：服务端 emit RICH_CONTENT 但 image_url 缺失/空时显示。
 *
 * 视觉权重设计：
 *   - **明显的"在桌面端查看"按钮**——Material 主色按钮（Accent 色 + DesktopWindows icon），
 *     不是 placeholder 文字下面藏一行链接（之前 Wave 2 placeholder 的做法：用户根本不知道
 *     还有"行动入口"）
 *   - summary 在按钮上方做主要文案（用户至少能从 summary 知道 widget 大致内容）
 *   - 桌面端拉历史看到的是真 widget；移动端拉历史只能看到这条提示——是已知降级
 *
 * **Wave 4 Review 修复**：
 *   - 顶部 padding 从 36dp 改回 28dp 与 iOS 一致（之前不对称，没必要 36dp 多 8dp）
 *   - LaunchedEffect key 改用 widgetId（更稳定，title+summary 重复时会误触发多次日志）
 */
@Composable
private fun WidgetBakeFailedFallback(
    title: String?,
    summary: String?,
    widgetId: String?,
    mermaidFallbackSource: String?,
    onOpenOnDesktopTap: () -> Unit,
) {
    // Wave 4 Review 修复：之前 LaunchedEffect(title, summary) 不稳定（不同 widget 重复
    // title+summary 时会误打日志）。widget_id 在服务端是 unique 的，更适合作为 key。
    LaunchedEffect(widgetId) {
        // 项目暂无 metric 基础设施（grep `analytics|metric.report` 命中 0）——这里走
        // Logcat 让未来上 metric 时有 hook 点。失败信号 widget_id / summary 截断到
        // 60 字符防巨型 PII 进日志。
        Log.w(
            "RichWidget",
            "bake failed (image_url missing/empty) widget_id=${widgetId ?: "null"} summary=${(summary ?: "").take(60)}",
        )
    }
    val openOnDesktopText = stringResource(R.string.rich_content_widget_open_on_desktop)
    Column(
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = TTSpacing.sm, end = TTSpacing.sm, bottom = TTSpacing.sm),
    ) {
        title?.let {
            Text(
                text = it,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        summary?.let {
            Text(
                text = it,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // Mermaid 降级源码折叠面板（Mobile 对齐 Wave，与 iOS `mermaidSourceDisclosure`
        // 对齐）：仅当烤图失败 + format=mermaid + mermaid_source/source_code 非空时渲染。
        // 视觉简单——chevron + 等宽源码文本。默认关闭，用户点开才展开，避免占据 chat
        // 气泡过多空间。
        mermaidFallbackSource?.let { source ->
            MermaidSourceDisclosure(source = source)
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            modifier = Modifier
                .clip(TTRadius.Shapes.full)
                .background(ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent))
                .clickable(onClick = onOpenOnDesktopTap)
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs)
                // Wave 4 Review 修复：单独让按钮承载 contentDescription——之前父级 Box
                // 的 contentDescription 把按钮可点击语义吞掉，TalkBack 用户无法单独
                // 激活按钮。给按钮 Row 自己 semantics 让 TalkBack 能独立朗读 + 双击激活。
                .semantics {
                    contentDescription = openOnDesktopText
                },
        ) {
            Icon(
                imageVector = Icons.Filled.DesktopWindows,
                contentDescription = null,
                tint = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                modifier = Modifier.size(12.dp),
            )
            Text(
                text = openOnDesktopText,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
            )
        }
    }
}

/**
 * Mermaid 降级源码折叠面板（Mobile 对齐 Wave，与 iOS `mermaidSourceDisclosure` 对齐）。
 *
 * 视觉设计：
 *   - 默认折叠：KeyboardArrowRight + "Mermaid 源码" 文字
 *   - 展开后：KeyboardArrowDown + 等宽源码文本（FontFamily.Monospace）
 *   - 源码面板用 horizontalScroll——mermaid 长行不换行但可横向滑动查看
 *   - 背景用 SurfaceVariant alpha 0.6 跟外层区分出一层次，不抢主按钮视觉权重
 *
 * **a11y 策略**（与 iOS 对齐）：
 *   - 外层 Row 自己挂 onClick semantic + `rich_content_widget_mermaid_source_expand_hint`
 *     告诉 TalkBack 双击激活的效果，不依赖父容器
 *   - 展开后源码 Text 不自带 semantic 让 TalkBack 自行朗读完整源码内容（视障用户
 *     可以听完整的 mermaid DSL）
 *
 * **状态保留**：用 rememberSaveable 而不是 remember——用户展开源码后若列表滚动导致
 * Composable 被 destroy 再 recompose，展开态应保留；配置变更（旋屏）也应保留。
 */
@Composable
private fun MermaidSourceDisclosure(source: String) {
    var expanded by rememberSaveable(source) { mutableStateOf(false) }
    val scrollState = rememberScrollState()
    val labelText = stringResource(R.string.rich_content_widget_mermaid_source)
    val expandHintText = stringResource(R.string.rich_content_widget_mermaid_source_expand_hint)

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = { expanded = !expanded })
                .padding(vertical = 4.dp)
                .semantics {
                    contentDescription = labelText
                    onClick(label = expandHintText, action = null)
                },
        ) {
            Icon(
                imageVector = if (expanded) Icons.Filled.KeyboardArrowDown
                    else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = labelText,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }

        AnimatedVisibility(
            visible = expanded,
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            // SelectionContainer：跟 iOS `.textSelection(.enabled)` 对齐——用户长按
            // 能选中并复制 Mermaid 源码到剪贴板，切回桌面端粘贴。卡片类组件
            // `CodeBlockView` / `TerminalCardView` 已是这个范式，此处保持一致。
            SelectionContainer {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(TTRadius.Shapes.sm)
                        .background(
                            ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant)
                                .copy(alpha = 0.6f)
                        )
                        .padding(TTSpacing.xs)
                        .horizontalScroll(scrollState),
                ) {
                    Text(
                        text = source,
                        style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                }
            }
        }
    }
}

/**
 * Wave 3 (X1/M3)：rich_content image 点击 → 全屏预览。
 * 复用现有 `ImagePreviewDialog`（与 ChatBubble 内附件图片同一组件），与桌面端
 * RichContentRenderer.RichImage 行为对齐（点击 → 同一预览模态）。
 *
 * contentDescription 字段优先级：alt_text（无障碍专用）→ caption → summary →
 * "image"（兜底字符串避免 TalkBack 念出 "未标记图片"）。
 *
 * Wave 3 三视角 Review 修正：原 `AsyncImage` 无 placeholder/error，弱网下用户看到的
 * 是塌陷为 0 高度的空白区——容易误解为"agent 没出图"。这里改用 SubcomposeAsyncImage
 * 给出明确的 loading（spinner）和 error（损坏图片图标）态，与 iOS RichImageView 的
 * CachedAsyncImage 三态（loaded/loading/failed）行为对齐。
 */
@Composable
private fun RichImage(block: BlockItem) {
    val url = rememberResolvedRichImageUrl(block) ?: return
    val contentDesc = block.altText
        ?: block.caption
        ?: block.summary
        ?: stringResource(R.string.chat_image_preview)

    var showPreview by remember { mutableStateOf(false) }

    Column {
        // 加载后按真实宽高比适配；仅用 max 约束，避免固定画幅裁切。
        SubcomposeAsyncImage(
            model = url,
            contentDescription = contentDesc,
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 320.dp)
                .heightIn(max = 360.dp)
                .clip(TTRadius.Shapes.sm)
                .clickable { showPreview = true },
            contentScale = ContentScale.Fit,
            loading = { ImagePlaceholderBox(loading = true) },
            error = { ImagePlaceholderBox(loading = false) },
        )
        block.caption?.takeIf { it.isNotEmpty() }?.let { caption ->
            Text(
                text = caption,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.padding(top = TTSpacing.xxs),
            )
        }
    }

    if (showPreview) {
        ImagePreviewDialog(
            imageUrl = url,
            filename = block.filename ?: block.altText ?: block.caption,
            onDismiss = { showPreview = false },
        )
    }
}

@EntryPoint
@InstallIn(SingletonComponent::class)
internal interface RichOssAssetEntryPoint {
    fun ossUploadService(): OSSUploadService
}

/**
 * 正式 OSS 资产优先凭 file_id 换当前有效地址；网络失败时保留协议内 HTTP(S) 兜底。
 * 资源身份 URI 不会进入图片或文件预览器。
 */
@Composable
private fun rememberResolvedRichOssUrl(fileId: String?, fallbackUrl: String?): String? {
    val context = LocalContext.current
    val fallback = fallbackUrl?.takeIf(::isHttpImageUrl)
    var resolvedUrl by remember(fileId, fallback) { mutableStateOf(fallback) }

    LaunchedEffect(fileId, fallback) {
        resolvedUrl = fallback
        val resolvedFileId = fileId?.trim()?.takeIf { it.isNotEmpty() } ?: return@LaunchedEffect
        val service = EntryPointAccessors.fromApplication(
            context.applicationContext,
            RichOssAssetEntryPoint::class.java,
        ).ossUploadService()
        val freshUrl = try {
            service.resolveFile(resolvedFileId).displayUrl.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
        if (freshUrl != null && isHttpImageUrl(freshUrl)) resolvedUrl = freshUrl
    }
    return resolvedUrl
}

/** 正式图片优先凭 file_id 换当前有效地址；资源身份 URI 从不进入 Coil。 */
@Composable
private fun rememberResolvedRichImageUrl(block: BlockItem): String? =
    rememberResolvedRichOssUrl(fileId = block.fileId, fallbackUrl = block.url)

/**
 * RichImage 的 loading / error 占位框。
 * - 固定 200x150dp 占位，让气泡布局在加载期间不会突变高度（避免列表滚动跳）
 * - 暗黑模式自适应背景；icon 在主题色与 tertiary 之间切换
 * - 长按未挂——tap 仍走父级 onClick 进全屏，预览组件本身处理 retry
 */
@Composable
private fun ImagePlaceholderBox(loading: Boolean) {
    Box(
        modifier = Modifier
            .size(width = 200.dp, height = 150.dp)
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                strokeWidth = 2.dp,
                color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        } else {
            Icon(
                Icons.Filled.BrokenImage,
                contentDescription = null,
                modifier = Modifier.size(28.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun RichTablePreview(block: BlockItem) {
    val columns = block.columns
    val rows = block.rows
    if (columns.isNullOrEmpty()) {
        RichFallback(block)
        return
    }

    // 渲染计划抽到 `planTablePreviewRender`（RichContentSchemaBridge.kt）做权威决策——
    // 视觉层只渲染 plan 里列出的 segment，summary 不在 plan.visibleTitle / plan.markdownTable
    // 视觉字段中（与桌面 `RichContentRenderer.tsx` RichTablePreview 对齐：仅渲染 title +
    // 表格 + 截断 footer）。summary 仍保留在 BlockItem 字段中，承担 a11y 兜底文案 +
    // 未来 widget 烤图失败时移动端 fallback 角色。
    val plan = remember(columns, rows, block.title, block.summary, block.totalRows) {
        planTablePreviewRender(
            title = block.title,
            summary = block.summary,
            columns = columns,
            rows = rows,
            totalRows = block.totalRows,
        )
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.md)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(TTSpacing.sm),
    ) {
        // 与桌面端 `text-caption font-medium text-foreground` 视觉对齐——表格标题条带。
        // `maxLines=1 + TextOverflow.Ellipsis` 与同文件 RichResourceRef 标题 (maxLines=2) /
        // RichFile 文件名 (maxLines=1) 风格对齐——服务端推异常长 title 时不会撑爆卡片让
        // 用户误以为是消息正文。
        //
        // a11y：把 summary（兜底文案，桌面端不显示但服务端必填）+ 视觉 title 合并成
        // contentDescription，让 TalkBack 朗读「Q3 销售数据 — 销售看板」而不是只听到
        // "销售看板"。**故意不在 Column 上 mergeDescendants = true**——那会把表格内容
        // / 截断 footer 合并成一句话覆盖子元素朗读（review 反馈：TalkBack 用户听不到
        // 表内容是真实风险）。把 contentDescription 挂在 title Text 上，子元素仍可
        // 独立 focus 朗读。
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            Image(
                painter = painterResource(R.drawable.app_glyph_tabdata),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
            Text(
                text = plan?.visibleTitle ?: "TabData",
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).then(plan?.accessibilityLabel?.let { label ->
                    Modifier.semantics { contentDescription = label }
                } ?: Modifier),
            )
        }
        MarkdownBubble(content = plan?.markdownTable ?: buildTableMarkdown(columns, rows))
        // 与桌面 `text-caption text-foreground/50` 视觉对齐——次要文字截断提示。
        plan?.truncationFooter?.let { footer ->
            Text(
                text = stringResource(
                    R.string.rich_content_showing_rows,
                    footer.rendered,
                    footer.total,
                ),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
    // 已知 a11y backlog：title 缺失但 summary 在场（服务端可只推 summary 不推 title）时，
    // summary 不会被 TalkBack 朗读。Wave 0.5 之后服务端实际同时推 summary + title 的
    // 概率极高，作为 backlog 处理；理想方案是用一个 size 0 的 Text + Modifier.semantics
    // 注入不可视但 a11y-visible 的兜底元素。
}

/**
 * Wave 3 (X1/M3)：rich_content resource_ref 点击 → tabtin:// deep link 跳转。
 *
 * 是否可点（canNavigate）：必须 resource_type + resource_id 都非空。这个守卫与右上角
 * 箭头图标的展示条件一致——可点的卡片显示箭头，不可点的卡片视觉上就是静态信息卡，
 * tap 不会触发任何动作（避免"死按钮"反馈）。
 */
@Composable
private fun RichResourceRef(
    block: BlockItem,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
) {
    val context = LocalContext.current
    val normalizedType = SpaceResource.normalizedType(block.resourceType.orEmpty().trim().lowercase())
    val brandGlyph = AppIconResolver.resolveContentGlyph(normalizedType)
    val fallbackIcon = resourceTypeIcon(normalizedType)

    // 主标题与桌面端 RichResourceRef 一致：resource_name → summary → 兜底 "资源"。
    // 字段语义区别：resource_name 是资源本身的名字（如"Q3 销售报告"），
    // summary 是上下文描述（如"agent 找到的相关文档"）；两者都缺时用 i18n "资源"。
    val displayName = block.resourceName?.takeIf { it.isNotEmpty() }
        ?: block.summary?.takeIf { it.isNotEmpty() }
        ?: stringResource(R.string.rich_content_resource)

    // 副标题：优先 space_name（与桌面端两行版式一致），否则 fallback resource_type 首字母大写
    val subtitle = block.spaceName?.takeIf { it.isNotEmpty() }
        ?: block.resourceType?.takeIf { it.isNotEmpty() }
            ?.replaceFirstChar { it.uppercase() }

    val openRequest = remember(block) { resolveRichResourceOpenRequest(block) }
    val canNavigate = openRequest != null

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .border(
                width = 1.dp,
                color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
                shape = TTRadius.Shapes.sm,
            )
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .let { mod ->
                // canNavigate=false 时不挂 clickable，避免 ripple+无反馈死按钮
                if (canNavigate) {
                    mod.clickable {
                        dispatchRichResourceOpen(
                            request = checkNotNull(openRequest),
                            onOpenInWorkbench = onOpenInWorkbench?.takeIf {
                                canOpenRichResourceInCurrentTask(
                                    block = block,
                                    currentSpaceId = currentSpaceId,
                                    currentOrganizationId = currentOrganizationId,
                                )
                            },
                            onOpenWithDeepLink = { request ->
                                navigateToResource(
                                    context = context,
                                    resourceType = request.resourceType,
                                    resourceId = request.resourceId,
                                    title = request.title ?: displayName,
                                    locationHint = request.locationHint,
                                    spaceId = block.spaceId ?: currentSpaceId,
                                    organizationId = block.organizationId
                                        ?: block.workspaceId
                                        ?: currentOrganizationId,
                                )
                            },
                        )
                    }
                } else mod
            }
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        // tabdoc / tabdata：无白底品牌字形，不叠色底；其它类型仍用系统矢量。
        if (brandGlyph != null) {
            Image(
                painter = painterResource(brandGlyph),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
        } else {
            Icon(
                fallbackIcon,
                contentDescription = null,
                modifier = Modifier.size(22.dp),
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = displayName,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (canNavigate) {
            Text(
                text = stringResource(R.string.rich_content_open),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        }
    }
}

/**
 * 构造 tabtin://resource/<type>/<encoded_id> 并通过 Intent.ACTION_VIEW 派发。
 *
 * `Uri.encode(String)` 不指定 allow set 时会 encode 除字母数字与 `_-.*` 之外的所有字符，
 * 比 iOS `.urlPathAllowed` 更激进（后者保留 `@` `+` 等路径字符）。对常见场景
 * （UUID、纯数字、英文 slug）两端表现一致；含 `@` `+` 等特殊字符的 resourceId 在两端
 * encode 结果会有差异，但解码后语义不变（Wave 6 的 Z2 polish 会做端到端等价性回归）。
 *
 * 失败时（系统找不到 handler、或 manifest 注册被禁）走 Toast"即将支持"——
 * 与 DeepLinkHandler 一致的兜底文案，避免出现 ActivityNotFoundException 崩溃。
 */
internal fun navigateToResource(
    context: android.content.Context,
    resourceType: String,
    resourceId: String,
    title: String? = null,
    locationHint: String? = null,
    spaceId: String? = null,
    organizationId: String? = null,
) {
    val encoded = Uri.encode(resourceId)
    val builder = Uri.parse("tabtin://resource/$resourceType/$encoded").buildUpon()
    title?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("title", it) }
    locationHint?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("location_hint", it) }
    spaceId?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("space_id", it) }
    organizationId?.takeIf { it.isNotBlank() }?.let { builder.appendQueryParameter("organization_id", it) }
    val uri = builder.build()
    try {
        // FLAG_ACTIVITY_NEW_TASK 不需要——MainActivity 是 singleTask，已存在的 instance
        // 直接收到 onNewIntent，不会创建新栈。
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            // 强制路由到本应用（防止其他应用注册了相同 scheme 抢截）
            setPackage(context.packageName)
        }
        context.startActivity(intent)
    } catch (e: android.content.ActivityNotFoundException) {
        // 仅在 manifest 注册被禁 / 系统找不到 handler 时走兜底 Toast。其他 Exception
        // （SecurityException 等）让它向上抛出便于排查——比一律静默 Toast 更利于运维。
        Log.w("RichContentSection", "navigateToResource ActivityNotFound: $uri", e)
        android.widget.Toast.makeText(
            context,
            context.getString(R.string.rich_content_resource_coming_soon),
            android.widget.Toast.LENGTH_LONG,
        ).show()
    }
}

@Composable
private fun RichFile(block: BlockItem) {
    val context = LocalContext.current
    val filename = block.filename ?: stringResource(R.string.common_file)
    val resolvedUrl = rememberResolvedRichOssUrl(fileId = block.fileId, fallbackUrl = block.url)
    var showPreview by remember(resolvedUrl) { mutableStateOf(false) }
    val canPreview = remember(resolvedUrl) {
        val scheme = resolvedUrl?.let { runCatching { Uri.parse(it).scheme?.lowercase() }.getOrNull() }
        scheme == "http" || scheme == "https"
    }

    // rich_content file block 优先 file_size（agent emit），fallback 到 size（用户上传 schema 复用）
    val sizeBytes = block.fileSize ?: block.size
    val sizeText = sizeBytes
        ?.takeIf { it > 0 }
        ?.let { Formatter.formatFileSize(context, it) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .clickable(enabled = canPreview) { showPreview = true }
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        // 本地文件：系统 Material 类型图标（按 mime/扩展名），不叠品牌字形或色底。
        Icon(
            fileTypeIcon(block.mimeType, block.filename),
            contentDescription = null,
            modifier = Modifier.size(22.dp),
            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = filename,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (sizeText != null) {
                Text(
                    text = sizeText,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                )
            }
            // 本地交付物只有 tabtin:// 指针、无 https：文件在电脑执行设备上，手机不能预览。
            if (!canPreview) {
                Text(
                    text = stringResource(R.string.rich_content_file_open_on_desktop),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                )
            }
        }
        if (canPreview) {
            Icon(
                Icons.AutoMirrored.Filled.OpenInNew,
                contentDescription = stringResource(R.string.rich_content_open),
                modifier = Modifier.size(18.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }

    if (showPreview && canPreview && !resolvedUrl.isNullOrEmpty()) {
        ChatFilePreviewDialog(
            fileUrl = resolvedUrl,
            filename = block.filename,
            mimeType = block.mimeType,
            onDismiss = { showPreview = false },
        )
    }
}

@Composable
private fun RichFallback(block: BlockItem) {
    val text = block.summary ?: return
    Text(
        text = text,
        style = TTFonts.body,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        modifier = Modifier.padding(vertical = TTSpacing.xxs),
    )
}

private fun resourceTypeIcon(resourceType: String?): ImageVector = when (resourceType) {
    "table", "tabdata" -> Icons.Default.TableChart
    "doc", "tabdoc", "document" -> Icons.Default.Description
    "slide", "tabslide" -> Icons.Default.Slideshow
    "video", "tabvideo" -> Icons.Default.Videocam
    "site", "tabsite" -> Icons.Default.Language
    else -> Icons.AutoMirrored.Filled.Article
}
