package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.isActive

/** 与 Electron / agent-host `PROMPT_PREVIEW_MAX` 一致。 */
internal const val MEDIA_IMAGE_PROMPT_PREVIEW_MAX = 80

/** 与 Electron `IMAGE_PREVIEW` 同比例（400×320），移动端限宽。 */
private const val MEDIA_IMAGE_ASPECT_W = 400f
private const val MEDIA_IMAGE_ASPECT_H = 320f
private val MEDIA_IMAGE_MAX_WIDTH = 320.dp
private val MEDIA_IMAGE_PROGRESS_BAR_HEIGHT = 3.dp

/**
 * 点云边长。Electron 在 400 宽的图位框里放 144（约占框宽 36%）；
 * 移动端框最宽 320，同比例落到 115——再小会像个 spinner，再大就压过图位本身。
 */
private val MEDIA_IMAGE_SHAPING_SIZE = 115.dp

/**
 * 减弱动效时钉住的静帧相位（= 0.6 秒 × 2.405）。
 * 与 Electron 取同一个数，两端在关掉动效时看到的是同一个形，而不是各画各的。
 */
private const val MEDIA_IMAGE_SHAPING_STATIC_T = 1.443f

/**
 * 主时间线文生图交付面：loading → 成品图 / 失败。
 *
 * 对齐 Electron `MediaImageInlineCard` / `ImageGeneratingCard`：
 * 图位画布（进行中跑「正在成形」点云）+ 底边假进度条 + 静态文案；
 * 有 URL 复用 [RichContentSection]。
 */
@Composable
internal fun MediaImageInlineCard(step: AgentStep) {
    val url = remember(step.output) { MediaImageGenerateResultParser.parse(step.output) }
    val backgroundRunning = remember(step.output) { isBackgroundRunning(step.output) }
    val promptPreview = remember(step.presentationPrompt) {
        truncatedPromptPreview(step.presentationPrompt)
    }

    Column(
        modifier = Modifier
            .testTag("media-image-inline-card")
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        when {
            url != null -> {
                RichContentSection(
                    blocks = listOf(
                        BlockItem(
                            type = "rich_content",
                            kind = "image",
                            url = url,
                            summary = promptPreview,
                            altText = promptPreview,
                        ),
                    ),
                )
            }
            // 终态 + 无 URL + 非 background running → 失败（假成功不留空白）
            step.status == StepStatus.FAILED ||
                (step.status == StepStatus.COMPLETED && !backgroundRunning) -> {
                MediaImageFailedCanvas(
                    promptPreview = promptPreview,
                    details = step.output,
                )
            }
            else -> {
                MediaImageLoadingCanvas(promptPreview = promptPreview)
            }
        }
    }
}

/**
 * ：wait_ms 耗尽时 output 可能仍带 `"status":"running"`，尚无 URL——保持 loading。
 * P0 用简单子串检测，完整 unwrap 留给后续对齐 Electron `isShellBackgroundRunningOutput`。
 */
internal fun isBackgroundRunning(output: String?): Boolean {
    if (output.isNullOrBlank()) return false
    return output.contains("\"status\":\"running\"") ||
        output.contains("\"status\": \"running\"") ||
        output.contains("\"backgrounded\":true") ||
        output.contains("\"backgrounded\": true")
}

/** 展示用 prompt 截断（≤ [MEDIA_IMAGE_PROMPT_PREVIEW_MAX]，超出加省略号）。 */
internal fun truncatedPromptPreview(prompt: String?): String? {
    if (prompt.isNullOrBlank()) return null
    if (prompt.length <= MEDIA_IMAGE_PROMPT_PREVIEW_MAX) return prompt
    return prompt.take(MEDIA_IMAGE_PROMPT_PREVIEW_MAX) + "…"
}

@Composable
private fun MediaImageLoadingCanvas(promptPreview: String?) {
    // 对齐 Electron ：挂载锚定，不前移。
    val anchorAtMs = remember { System.currentTimeMillis() }
    val reduceMotion = rememberReduceMotion()
    var progress by remember { mutableFloatStateOf(0f) }
    var shapingT by remember { mutableFloatStateOf(MEDIA_IMAGE_SHAPING_STATIC_T) }

    // 跟帧刷新，连续浮点；避免 delay(33)+整数台阶发涩。
    // 点云与假进度共用这一个帧循环，别再开第二套时钟。
    LaunchedEffect(anchorAtMs, reduceMotion) {
        while (isActive) {
            withFrameNanos {
                val elapsedMs = System.currentTimeMillis() - anchorAtMs
                progress = ImageGeneratingProgress.compute(elapsedMs = elapsedMs, done = false)
                if (!reduceMotion) {
                    shapingT = elapsedMs / 1000f * MediaImageShapingCloud.SPEED
                }
            }
        }
    }

    Column(
        modifier = Modifier.widthIn(max = MEDIA_IMAGE_MAX_WIDTH),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        MediaImageGeneratingCanvas(failed = false, progress = progress, shapingT = shapingT)
        MediaImageGeneratingCaption(running = true)
        promptPreview?.takeIf { it.isNotBlank() }?.let { prompt ->
            Text(
                text = prompt,
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("media-image-generating-prompt"),
            )
        }
    }
}

@Composable
private fun MediaImageFailedCanvas(promptPreview: String?, details: String?) {
    var showDetails by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.widthIn(max = MEDIA_IMAGE_MAX_WIDTH),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        MediaImageGeneratingCanvas(failed = true, progress = 100f)
        MediaImageGeneratingCaption(running = false)
        promptPreview?.takeIf { it.isNotBlank() }?.let { prompt ->
            Text(
                text = prompt,
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (!details.isNullOrBlank()) {
            Text(
                text = stringResource(
                    if (showDetails) {
                        R.string.chat_media_image_hide_details
                    } else {
                        R.string.chat_media_image_view_details
                    },
                ),
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier
                    .clickable { showDetails = !showDetails }
                    .testTag("media-image-inline-toggle-details")
                    .padding(vertical = TTSpacing.xxs),
            )
            if (showDetails) {
                Text(
                    text = details.take(2000),
                    style = ConversationTypography.meta.copy(fontFamily = FontFamily.Monospace),
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    modifier = Modifier
                        .testTag("media-image-inline-details")
                        .fillMaxWidth()
                        .heightIn(max = 160.dp)
                        .clip(TTRadius.Shapes.sm)
                        .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                        .verticalScroll(rememberScrollState())
                        .padding(TTSpacing.sm),
                )
            }
        }
    }
}

/**
 * @param shapingT 非空时画「正在成形」点云（相位已含 SPEED）；为空时退回静态图标。
 */
@Composable
private fun MediaImageGeneratingCanvas(failed: Boolean, progress: Float, shapingT: Float? = null) {
    val track = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary).copy(alpha = 0.10f)
    val fill = if (failed) {
        ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.60f)
    } else {
        ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary).copy(alpha = 0.45f)
    }
    val border = if (failed) {
        ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.30f)
    } else {
        ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    }
    val bg = if (failed) {
        ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.06f)
    } else {
        ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    }
    val fraction = (progress.coerceIn(0f, 100f)) / 100f

    Box(
        modifier = Modifier
            .testTag("media-image-generating-canvas")
            .fillMaxWidth()
            .aspectRatio(MEDIA_IMAGE_ASPECT_W / MEDIA_IMAGE_ASPECT_H)
            .clip(TTRadius.Shapes.md)
            .background(bg)
            .border(0.5.dp, border, TTRadius.Shapes.md),
    ) {
        if (shapingT != null) {
            MediaImageShapingCloudCanvas(
                t = shapingT,
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            Icon(
                imageVector = if (failed) Icons.Filled.BrokenImage else Icons.Outlined.Image,
                contentDescription = null,
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(TTFonts.iconEmptyMD.fontSize.value.dp),
                tint = if (failed) {
                    ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.45f)
                } else {
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.70f)
                },
            )
        }

        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(MEDIA_IMAGE_PROGRESS_BAR_HEIGHT)
                .background(track),
        ) {
            Box(
                modifier = Modifier
                    .testTag("media-image-generating-progress-bar")
                    .fillMaxWidth()
                    .height(MEDIA_IMAGE_PROGRESS_BAR_HEIGHT)
                    .graphicsLayer {
                        scaleX = fraction
                        transformOrigin = TransformOrigin(0f, 0.5f)
                    }
                    .background(fill),
            )
        }
    }
}

@Composable
private fun MediaImageGeneratingCaption(running: Boolean) {
    val caption = if (running) {
        stringResource(R.string.chat_media_image_generating)
    } else {
        stringResource(R.string.chat_media_image_failed)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Icon(
            imageVector = if (running) Icons.Outlined.Image else Icons.Outlined.Info,
            contentDescription = null,
            modifier = Modifier.size(TTFonts.iconBody.fontSize.value.dp),
            tint = if (running) {
                ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
            } else {
                ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.70f)
            },
        )
        // 文案一律静态： L2 要求整张卡只留一处持续动效，那一处已经交给画布上的点云
        Text(
            text = caption,
            style = ConversationTypography.meta,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 「图正在成形」点云：24 点沿闭合曲线在 圆 → 三角 → 方 之间循环变形。
 *
 * 颜色刻意走灰阶而不用主题语义色——点云只表达「在干活」，不承载状态颜色，
 * 这是 Electron 的既定设计轴，两端保持一致。
 */
@Composable
private fun MediaImageShapingCloudCanvas(t: Float, modifier: Modifier = Modifier) {
    val ink = ttColor(Color(0xFF1A1A1A), Color(0xFFE6E6E6))
    Canvas(
        modifier = modifier
            .testTag("media-image-generating-shaping")
            .size(MEDIA_IMAGE_SHAPING_SIZE),
    ) {
        val scale = size.minDimension / MediaImageShapingCloud.PRESET_SIZE
        MediaImageShapingCloud.dots(t).forEach { dot ->
            drawCircle(
                color = ink,
                radius = dot.r * scale,
                center = Offset(dot.x * scale, dot.y * scale),
            )
        }
    }
}
