package com.tabtin.mobile.features.tabchat

import android.text.format.DateFormat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.util.RelativeTimeFormatter
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * IM 消息时间线分组，对齐 iOS `IMMessageTimeline` / Electron `IMMessageBubble`
 *（跨天分割、发送者变化、间隔 >5 分钟断组）。
 */
internal object ImMessageTimeline {
    /** 连续消息超过该间隔视为新一组（Electron `shouldShowTimestamp`）。 */
    const val GAP_BREAK_INTERVAL_MS: Long = 5 * 60 * 1000L

    fun parseTimestampMs(raw: String?): Long? {
        if (raw.isNullOrBlank()) return null
        return runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
            ?: RelativeTimeFormatter.parse(raw)?.time
    }

    fun isSameCalendarDay(a: String?, b: String?): Boolean {
        val da = parseTimestampMs(a) ?: return false
        val db = parseTimestampMs(b) ?: return false
        val calA = Calendar.getInstance().apply { timeInMillis = da }
        val calB = Calendar.getInstance().apply { timeInMillis = db }
        return calA.get(Calendar.YEAR) == calB.get(Calendar.YEAR) &&
            calA.get(Calendar.DAY_OF_YEAR) == calB.get(Calendar.DAY_OF_YEAR)
    }

    fun shouldShowDateDivider(message: ImMessage, previous: ImMessage?): Boolean {
        if (previous == null) return true
        return !isSameCalendarDay(previous.createdAt, message.createdAt)
    }

    fun shouldShowTimestampGap(current: ImMessage, previous: ImMessage?): Boolean {
        if (previous == null) return true
        val curr = parseTimestampMs(current.createdAt) ?: return true
        val prev = parseTimestampMs(previous.createdAt) ?: return true
        return curr - prev > GAP_BREAK_INTERVAL_MS
    }

    fun senderChanged(current: ImMessage, previous: ImMessage?): Boolean {
        if (previous == null) return true
        return previous.senderId != current.senderId || previous.senderType != current.senderType
    }

    /** 组首：前一条已撤回 / 跨天 / 超 5 分钟 / 发送者变化。 */
    fun isGroupStart(current: ImMessage, previous: ImMessage?): Boolean =
        previous?.isDeleted == true ||
            shouldShowDateDivider(current, previous) ||
            shouldShowTimestampGap(current, previous) ||
            senderChanged(current, previous)

    /** 对方消息仅在消息组首展示头像；组内连续消息保留头像槽对齐。 */
    fun showsIncomingAvatar(
        message: ImMessage,
        previous: ImMessage?,
        currentUserId: String?,
    ): Boolean = message.senderId != currentUserId && isGroupStart(message, previous)

    /** 对齐 Electron：仅群聊中的真人对方头像可进入私聊。 */
    fun canOpenSenderDirectMessage(
        message: ImMessage,
        isDm: Boolean,
        currentUserId: String?,
    ): Boolean = !isDm &&
        message.senderId != currentUserId &&
        !message.isFromAgent &&
        message.messageType != com.tabtin.mobile.data.im.ImMessageType.SYSTEM &&
        message.senderId != "system" &&
        message.senderId.isNotBlank()

    /**
     * 私聊不显示对方昵称；群聊仅组首、且非本人时显示。
     * 对齐 Electron `IMMessageBubble` / iOS `showsIncomingSenderName`。
     */
    fun showsIncomingSenderName(
        message: ImMessage,
        previous: ImMessage?,
        isDm: Boolean,
        currentUserId: String?,
    ): Boolean {
        if (isDm) return false
        if (message.senderId == currentUserId) return false
        return isGroupStart(message, previous)
    }

    /** 日期分割线文案：今天 / 昨天 / 月日（同年省略年）。 */
    fun formatDateDivider(
        raw: String?,
        todayLabel: String,
        yesterdayLabel: String,
        nowMs: Long = System.currentTimeMillis(),
    ): String {
        val ms = parseTimestampMs(raw) ?: return ""
        val date = Date(ms)
        val cal = Calendar.getInstance().apply { time = date }
        val nowCal = Calendar.getInstance().apply { timeInMillis = nowMs }
        if (cal.get(Calendar.YEAR) == nowCal.get(Calendar.YEAR) &&
            cal.get(Calendar.DAY_OF_YEAR) == nowCal.get(Calendar.DAY_OF_YEAR)
        ) {
            return todayLabel
        }
        val yesterdayCal = Calendar.getInstance().apply {
            timeInMillis = nowMs
            add(Calendar.DAY_OF_YEAR, -1)
        }
        if (cal.get(Calendar.YEAR) == yesterdayCal.get(Calendar.YEAR) &&
            cal.get(Calendar.DAY_OF_YEAR) == yesterdayCal.get(Calendar.DAY_OF_YEAR)
        ) {
            return yesterdayLabel
        }
        val locale = Locale.getDefault()
        val skeleton = if (cal.get(Calendar.YEAR) == nowCal.get(Calendar.YEAR)) "Md" else "yMd"
        val pattern = DateFormat.getBestDateTimePattern(locale, skeleton)
        return SimpleDateFormat(pattern, locale).format(date)
    }

    /** 组首时分（"14:30"），对齐 Electron `formatMessageClock`。 */
    fun formatMessageClock(raw: String?): String {
        val ms = parseTimestampMs(raw) ?: return ""
        return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
    }
}

internal object ImConversationAvatarPolicy {
    private const val ADMIN_ROLE = 2

    fun canEditGroupAvatar(
        detail: com.tabtin.mobile.data.im.ImConversationDetail,
        currentUserId: String?,
    ): Boolean = detail.isGroup &&
        !currentUserId.isNullOrBlank() &&
        detail.members.any { member ->
            !member.isAgent && member.userId == currentUserId && member.role >= ADMIN_ROLE
        }
}

/** 群成员管理权限只依赖 Django 会话角色，不借用组织角色或 Provider 身份。 */
internal object ImConversationMemberManagementPolicy {
    private const val ADMIN_ROLE = 2
    private const val OWNER_ROLE = 3

    fun canRemove(
        detail: com.tabtin.mobile.data.im.ImConversationDetail,
        currentUserId: String?,
        member: com.tabtin.mobile.data.im.ImMember,
        binding: com.tabtin.mobile.data.im.ImConversationAgentBinding?,
    ): Boolean {
        if (!detail.isGroup || detail.isTeamSpaceChannel || currentUserId.isNullOrBlank()) return false
        val currentRole = detail.members.firstOrNull {
            !it.isAgent && it.userId == currentUserId
        }?.role ?: return false

        if (member.isAgent) {
            // Agent 主人可解除自己的 binding；会话管理员也可移出群内 Agent。
            return binding?.canRebind == true || currentRole >= ADMIN_ROLE
        }
        if (member.userId.isNullOrBlank() || member.userId == currentUserId) return false
        return currentRole >= ADMIN_ROLE && member.role < OWNER_ROLE
    }
}

/** 跨天日期分割线（居中 caption）。 */
@Composable
internal fun ImMessageDateDivider(label: String) {
    if (label.isEmpty()) return
    Text(
        text = label,
        style = TTFonts.captionMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.sm),
    )
}

/** 组首且无私聊发送者名时（DM / 自己发的），单独展示时分戳。 */
@Composable
internal fun ImMessageClockLabel(clock: String, isMine: Boolean) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.xs),
        contentAlignment = if (isMine) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Text(
            text = clock,
            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
        )
    }
}
