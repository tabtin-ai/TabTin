package com.tabtin.mobile.features.memo.components

import android.content.Context
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.memo.MemoColor
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.data.model.memo.isVoice
import com.tabtin.mobile.data.model.memo.strippedPreview
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter

private const val CARD_AI_TAGS_LIMIT = 5

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
public fun MemoCardView(
    memo: MemoSummary,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val isDark = isSystemInDarkTheme()
    val mc = MemoColor.from(memo.color)

    val cardBackground = when {
        mc != null -> if (isDark) mc.bgDark else mc.bgLight
        else -> if (isDark) Color.White.copy(alpha = 0.04f) else Color.White
    }

    val stripeColor = mc?.displayColor

    // combinedClickable 自带 ripple 与长按语义；按压缩放改由 interactionSource 驱动。
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val pressScale by animateFloatAsState(
        targetValue = if (pressed) 0.98f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "press",
    )

    Box(
        modifier = modifier
            .height(IntrinsicSize.Min)
            .scale(pressScale)
            .clip(RoundedCornerShape(TTRadius.md))
            .background(cardBackground)
            .then(
                if (isDark && mc == null) {
                    Modifier.border(0.5.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(TTRadius.md))
                } else Modifier
            )
            .combinedClickable(
                interactionSource = interactionSource,
                onClick = onClick,
                onLongClick = onLongClick,
                onLongClickLabel = if (onLongClick != null) {
                    stringResource(R.string.memo_card_actions)
                } else {
                    null
                },
            )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = TTSpacing.lg + if (stripeColor != null) 4.dp else 0.dp,
                    end = TTSpacing.lg,
                    top = TTSpacing.md + 2.dp,
                    bottom = TTSpacing.md + 2.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
                // 置顶徽章
                if (memo.isPinned) {
                    Row(
                        modifier = Modifier.padding(bottom = TTSpacing.xs),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.PushPin,
                            contentDescription = null,
                            modifier = Modifier.size(10.dp),
                            tint = ttColor(Color(0xFFE07E29).copy(alpha = 0.7f), Color(0xFFE6944C).copy(alpha = 0.7f)),
                        )
                        Text(
                            text = stringResource(R.string.memo_pinned),
                            style = TTFonts.codeXS,
                            color = ttColor(Color(0xFFE07E29).copy(alpha = 0.7f), Color(0xFFE6944C).copy(alpha = 0.7f)),
                        )
                    }
                }

                // 内容预览
                if (memo.strippedPreview.isNotEmpty()) {
                    Text(
                        text = memo.strippedPreview,
                        style = ConversationTypography.body,
                        color = ttColor(Color(0xFF282523), Color(0xFFE8E5E0)),
                        maxLines = 12,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                // 书签预览
                if (memo.bookmarkUrl.isNotEmpty()) {
                    Spacer(Modifier.height(TTSpacing.sm))
                    BookmarkPreviewSection(
                        imageUrl = memo.bookmarkImage,
                        title = memo.bookmarkTitle,
                        url = memo.bookmarkUrl,
                    )
                }

                // 标签区
                val manualTags = memo.tags
                val aiTags = memo.aiTags.take(CARD_AI_TAGS_LIMIT)
                if (manualTags.isNotEmpty() || aiTags.isNotEmpty()) {
                    Spacer(Modifier.height(TTSpacing.sm))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        manualTags.forEach { tag ->
                            TagChip(text = tag, isAI = false)
                        }
                        aiTags.forEach { tag ->
                            TagChip(text = tag, isAI = true)
                        }
                    }
                }

                // 底部信息栏
                Spacer(Modifier.height(TTSpacing.sm))
                MemoCardFooter(
                    memo = memo,
                    context = context,
                )
        }

        // 左侧颜色条 overlay
        if (stripeColor != null) {
            Box(
                modifier = Modifier
                    .width(4.dp)
                    .fillMaxHeight()
                    .align(Alignment.CenterStart)
                    .clip(
                        RoundedCornerShape(
                            topStart = TTRadius.md,
                            bottomStart = TTRadius.md,
                            topEnd = 0.dp,
                            bottomEnd = 0.dp
                        )
                    )
                    .background(stripeColor)
            )
        }
    }
}

@Composable
private fun BookmarkPreviewSection(
    imageUrl: String,
    title: String,
    url: String,
) {
    val domain = extractDomain(url)
    val tertiaryColor = ttColor(Color(0xFFB5AFA8), Color(0xFF5C5854))
    val secondaryColor = ttColor(Color(0xFF877F77), Color(0xFF8C8580))
    val subtleBg = ttColor(Color(0xFFF2F0EE).copy(alpha = 0.5f), Color(0xFF322F2B).copy(alpha = 0.5f))

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(subtleBg, RoundedCornerShape(TTRadius.sm))
            .padding(TTSpacing.sm + 2.dp),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (imageUrl.isNotEmpty()) {
            AsyncImage(
                model = imageUrl,
                contentDescription = null,
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(TTRadius.xs)),
                contentScale = ContentScale.Crop,
            )
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Link,
                    contentDescription = null,
                    modifier = Modifier.size(9.dp),
                    tint = tertiaryColor,
                )
                Text(
                    text = title.ifEmpty { domain },
                    style = TTFonts.meta,
                    color = secondaryColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (title.isNotEmpty()) {
                Text(
                    text = domain,
                    style = TTFonts.caption,
                    color = tertiaryColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun MemoCardFooter(
    memo: MemoSummary,
    context: Context,
) {
    val tertiaryColor = ttColor(Color(0xFFB5AFA8), Color(0xFF5C5854)).copy(alpha = 0.6f)
    val accentColor = ttColor(Color(0xFFE07E29).copy(alpha = 0.7f), Color(0xFFE6944C).copy(alpha = 0.7f))

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            memoTimeDisplay(memo, context)?.let { time ->
                Text(
                    text = time,
                    style = TTFonts.caption,
                    color = tertiaryColor,
                )
            }

            if (memo.isVoice) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Mic,
                        contentDescription = null,
                        modifier = Modifier.size(8.dp),
                        tint = accentColor,
                    )
                    Text(
                        text = stringResource(R.string.memo_voice_badge),
                        style = TTFonts.codeXS,
                        color = accentColor,
                    )
                }
            }
        }

        if (memo.attachmentCount > 0) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.AttachFile,
                    contentDescription = null,
                    modifier = Modifier.size(10.dp),
                    tint = tertiaryColor,
                )
                Text(
                    text = "${memo.attachmentCount}",
                    style = TTFonts.caption,
                    color = tertiaryColor,
                )
            }
        }
    }
}

private fun extractDomain(url: String): String {
    return try {
        val parsed = java.net.URL(url)
        val host = parsed.host ?: return url
        if (host.startsWith("www.")) host.removePrefix("www.") else host
    } catch (_: Exception) {
        url
    }
}

private fun memoTimeDisplay(memo: MemoSummary, context: Context): String? {
    val date = RelativeTimeFormatter.parse(memo.createdAt) ?: return RelativeTimeFormatter.format(context, memo.updatedAt)
    val cal = java.util.Calendar.getInstance()
    val now = java.util.Date()
    val today = cal.time
    cal.add(java.util.Calendar.DAY_OF_YEAR, -1)
    val yesterday = cal.time

    val dateCal = java.util.Calendar.getInstance().apply { time = date }
    val todayCal = java.util.Calendar.getInstance().apply { time = today }
    val yesterdayCal = java.util.Calendar.getInstance().apply { time = yesterday }

    return when {
        dateCal.get(java.util.Calendar.YEAR) == todayCal.get(java.util.Calendar.YEAR) &&
            dateCal.get(java.util.Calendar.DAY_OF_YEAR) == todayCal.get(java.util.Calendar.DAY_OF_YEAR) ->
            RelativeTimeFormatter.formatTime(memo.createdAt)
        dateCal.get(java.util.Calendar.YEAR) == yesterdayCal.get(java.util.Calendar.YEAR) &&
            dateCal.get(java.util.Calendar.DAY_OF_YEAR) == yesterdayCal.get(java.util.Calendar.DAY_OF_YEAR) ->
            RelativeTimeFormatter.formatTime(memo.createdAt)
        else ->
            RelativeTimeFormatter.format(context, memo.updatedAt)
    }
}
