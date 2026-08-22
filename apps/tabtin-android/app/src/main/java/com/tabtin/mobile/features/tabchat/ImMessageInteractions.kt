package com.tabtin.mobile.features.tabchat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTBubbleShape
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import java.time.Instant

/**
 * Phase E 会话内交互的展示组件 + 常量，对齐 iOS `IMMessageInteractions.swift`：
 * 快捷表情集、撤回时限、表情回应条、撤回占位、typing 指示。
 * 交互动作（toggle / 编辑 / 撤回）由 [ImConversationScreen] 通过 `ImMessageStore` 执行。
 */

/** 表情选择器完整常用集；长按菜单只保留「添加表情」入口。 */
public val imReactionPickerEmojis: List<String> = listOf(
    "👍", "❤️", "😂", "🎉", "😮", "🙏", "👏", "🔥", "🤔", "👀", "✅", "💯",
    "😢", "😡", "🚀", "💪", "👋", "🌹", "🎈", "💡", "🥳", "😱", "🤝", "☕️",
)

/** 撤回时限（毫秒）：与后端 `RECALL_TIMEOUT_SECONDS=120` / Electron `MESSAGE_RECALL_WINDOW_MS` 对齐。 */
public const val IM_RECALL_WINDOW_MS: Long = 120_000L

/** 手机端每行最多 5 个回应，避免表情条横跨整块消息区。 */
public const val IM_REACTION_MAX_ITEMS_PER_ROW: Int = 5

/** 撤回失败必须转成用户可见反馈；成功时不打扰用户。 */
public fun imRecallFeedbackMessage(success: Boolean): String? =
    if (success) null else "消息撤回失败，请稍后重试"

/** 是否仍在撤回时限内（仅本人消息可撤回；解析失败视为超窗，禁撤回）。 */
public fun imWithinRecallWindow(message: ImMessage, nowMs: Long = System.currentTimeMillis()): Boolean {
    val created = message.createdAt?.let { raw ->
        runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
            ?: RelativeTimeFormatter.parse(raw)?.time
    } ?: return false
    return nowMs - created <= IM_RECALL_WINDOW_MS
}

/**
 * 消息发送者标签（普通成员灰色；Agent 带前缀标识 + accent）。
 * [clock] 为组首时分，跟在昵称旁（对齐 iOS / Electron 组首 meta）。
 */
@Composable
internal fun ImMessageSenderLabel(
    senderName: String,
    isAgent: Boolean,
    clock: String? = null,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (isAgent) "✦ $senderName" else senderName,
            style = MaterialTheme.typography.labelSmall,
            color = if (isAgent) {
                ttColor(TTColors.Primary, TTColors.Dark.Primary)
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        if (!clock.isNullOrEmpty()) {
            Text(
                text = clock,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
            )
        }
    }
}

/** 表情回应条：展示每个 emoji + 计数，本人点过的高亮描边；点击切换。 */
@Composable
internal fun ImReactionBar(
    reactions: Map<String, List<String>>,
    reactionOrder: List<String>,
    currentUserId: String?,
    isMine: Boolean,
    onToggle: (String) -> Unit,
) {
    val items = orderedImReactionItems(reactions, reactionOrder)
    if (items.isEmpty()) return
    Column(
        modifier = Modifier
            .wrapContentWidth()
            .padding(start = if (isMine) 0.dp else 46.dp),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
        horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
    ) {
        for (row in items.chunked(IM_REACTION_MAX_ITEMS_PER_ROW)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for ((emoji, users) in row) {
                    val reactedByMe = currentUserId != null && users.contains(currentUserId)
                    ImReactionChip(emoji = emoji, count = users.size, reactedByMe = reactedByMe) {
                        onToggle(emoji)
                    }
                }
            }
        }
    }
}

/** 与 Electron 的 Object.entries(reactions) 一致：保留数据顺序，不按 emoji 字符串重排。 */
internal fun orderedImReactionItems(
    reactions: Map<String, List<String>>,
    order: List<String>,
): List<Pair<String, List<String>>> {
    val seen = mutableSetOf<String>()
    return (order + reactions.keys.filterNot(order::contains)).mapNotNull { emoji ->
        val users = reactions[emoji].orEmpty()
        if (!seen.add(emoji) || users.isEmpty()) null else emoji to users
    }
}

@Composable
private fun ImReactionChip(emoji: String, count: Int, reactedByMe: Boolean, onClick: () -> Unit) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides Dp.Unspecified) {
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = if (reactedByMe) accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceVariant,
            border = if (reactedByMe) {
                androidx.compose.foundation.BorderStroke(1.dp, accent)
            } else null,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = TTSpacing.sm, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(emoji, style = MaterialTheme.typography.labelSmall)
                Text(
                    text = count.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (reactedByMe) accent else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 撤回占位：居中灰字胶囊，替代原气泡。 */
@Composable
internal fun ImRecalledBubble(isMine: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(
                if (isMine) R.string.im_recalled_by_me else R.string.im_recalled_by_peer,
            ),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
            modifier = Modifier
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        )
    }
}

/** 成员加入/退出等系统事件，不属于成员发言；与 Electron 一致居中显示为弱提示。 */
@Composable
internal fun ImSystemMessageBubble(content: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = content,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
            modifier = Modifier
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f))
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        )
    }
}

/** 「正在输入…」指示（跳动三点 + 文案）。 */
@Composable
internal fun ImTypingIndicator() {
    Row(
        modifier = Modifier.padding(horizontal = TTSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val transition = rememberInfiniteTransition(label = "im-typing")
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            for (i in 0 until 3) {
                val alpha by transition.animateFloat(
                    initialValue = 0.3f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 600, delayMillis = i * 200, easing = LinearEasing),
                        repeatMode = androidx.compose.animation.core.RepeatMode.Reverse,
                    ),
                    label = "dot$i",
                )
                Spacer(
                    modifier = Modifier
                        .size(5.dp)
                        .alpha(alpha)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.onSurfaceVariant),
                )
            }
        }
        Text(
            text = stringResource(R.string.im_typing),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * 气泡背景色：对齐 Electron 轻底色语义。
 * 己方 foreground 约 6%/8%（亮/暗）；对方（含 Agent）accent 约 10%。
 */
@Composable
internal fun imBubbleColor(isMine: Boolean, @Suppress("UNUSED_PARAMETER") isAgent: Boolean): Color {
    if (isMine) {
        val alpha = if (LocalTTDarkTheme.current) 0.08f else 0.06f
        return ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary).copy(alpha = alpha)
    }
    return ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.10f)
}

/** 气泡文字色：轻底色上统一用主文本色（不再用 onPrimary 白字）。 */
@Composable
internal fun imBubbleTextColor(@Suppress("UNUSED_PARAMETER") isMine: Boolean): Color =
    ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)

/** 消息气泡通用容器：左右对齐 + 圆角 + 上色，供文本 / 附件 / 资源卡复用主体外壳。 */
@Composable
internal fun ImBubbleRow(
    isMine: Boolean,
    modifier: Modifier = Modifier,
    showIncomingAvatar: Boolean = false,
    incomingAvatar: (@Composable () -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // 必须用 Modifier.size，不能写 modifier.size：调用方常传 fillMaxWidth()，
        // fillMaxWidth().size(40) 会把 Spacer 撑满整行，气泡剩余宽度变成 0。
        if (isMine) Spacer(modifier = Modifier.size(40.dp))
        if (!isMine && incomingAvatar != null) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .align(Alignment.Top),
                contentAlignment = Alignment.Center,
            ) {
                if (showIncomingAvatar) incomingAvatar()
            }
            Spacer(modifier = Modifier.size(10.dp))
        }
        content()
        if (!isMine) Spacer(modifier = Modifier.size(40.dp))
    }
}

/** 己方右下 / 对方左下略尖，对齐 Electron rounded-2xl + rounded-br/bl-md。 */
internal fun imBubbleShape(isMine: Boolean): RoundedCornerShape =
    if (isMine) TTBubbleShape.outgoing else TTBubbleShape.incoming

internal val ImBubbleShape: RoundedCornerShape = TTBubbleShape.outgoing

@Composable
internal fun Modifier.imBubbleBackground(isMine: Boolean, isAgent: Boolean): Modifier =
    this
        .clip(imBubbleShape(isMine))
        .background(imBubbleColor(isMine, isAgent))
        .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm)

@Composable
internal fun imBorderLight(): Color =
    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)

internal fun Modifier.imCardBorder(color: Color): Modifier =
    this.border(1.dp, color, RoundedCornerShape(12.dp))

/** 内容标签用的半粗字重（发送者名等），避免各处重复。 */
internal val ImSemiBold: FontWeight = FontWeight.SemiBold
