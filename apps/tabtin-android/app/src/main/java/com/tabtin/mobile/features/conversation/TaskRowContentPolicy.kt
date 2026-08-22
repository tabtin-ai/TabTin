package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.data.model.AllChatSession

/**
 * 任务行第二行放什么。对齐 iOS `TaskRowContentPolicy`。
 *
 * 第二行回答「这条任务讲到哪了」——默认给**最后一条消息的预览**（Agent 说的
 * 或你说的都算）。这是列表里信息量最大的一行：扫一眼就知道该不该点进去。
 *
 * 唯一压过预览的是**要你动手**的状态（等你确认 / 运行失败）：那不是进展播报，
 * 是行动号召，必须先喊住人。「运行中 / 已暂停」不抢——头像上的光环已经说清楚了，
 * 再用文字重复一遍就是把最有用的那行让给了废话。
 *
 * 归属名（Workspace / Project）降为兜底：它是筛选维度，顶部范围选择器已经常驻
 * 显示，没必要每行再抄一遍；只有连预览都没有（空会话）时才用它填坑。
 */
internal object TaskRowContentPolicy {

    internal enum class Kind {
        /** 等你确认 / 失败——有话要说，且要你动手 */
        STATUS,
        /** 最后一条消息的预览 */
        PREVIEW,
        /** 只剩归属信息 */
        LOCATION,
        /** 什么都没有 */
        EMPTY,
    }

    /**
     * @param text 直接可显示的文本（预览 / 归属）；状态文案走 [statusTextRes] 取资源。
     */
    internal data class SecondLine(
        val kind: Kind,
        val text: String?,
        @StringRes val statusTextRes: Int?,
        val status: TaskRowStatus,
        val isArchived: Boolean,
    ) {
        val isOccupied: Boolean get() = kind != Kind.EMPTY || isArchived
    }

    fun secondLine(session: AllChatSession, status: TaskRowStatus): SecondLine {
        val isArchived = session.isArchivedSession

        fun line(kind: Kind, text: String? = null, @StringRes res: Int? = null) =
            SecondLine(kind, text, res, status, isArchived)

        blockingStatusTextRes(status)?.let { return line(Kind.STATUS, res = it) }
        messagePreview(session)?.let { return line(Kind.PREVIEW, text = it) }
        runningStatusTextRes(status)?.let { return line(Kind.STATUS, res = it) }
        session.taskRowLocationName()?.let { return line(Kind.LOCATION, text = it) }
        return line(Kind.EMPTY)
    }

    /**
     * 消息预览是多行原文，直接塞进单行会把换行渲染成断头文本——先把所有空白折成单空格。
     */
    fun messagePreview(session: AllChatSession): String? {
        val raw = session.lastMessagePreview?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return raw.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
            .takeIf { it.isNotEmpty() }
    }

    /** 两行文本预算：第二行为空时标题才放开到两行，否则整列高度会被撑乱。 */
    fun titleMaxLines(secondLine: SecondLine): Int = if (secondLine.isOccupied) 1 else 2

    /** 要人动手的状态。压过预览，因为用户点进去是为了「做事」而不是「读上一句」。 */
    @StringRes
    private fun blockingStatusTextRes(status: TaskRowStatus): Int? = when (status) {
        TaskRowStatus.WAITING_USER, TaskRowStatus.FAILED ->
            TaskRowStatusPresentation.statusTextRes(status)
        else -> null
    }

    /** 不需要人动手的进行态。仅在没有预览可显示时兜底，避免和头像光环重复。 */
    @StringRes
    private fun runningStatusTextRes(status: TaskRowStatus): Int? = when (status) {
        TaskRowStatus.RUNNING, TaskRowStatus.PAUSED ->
            TaskRowStatusPresentation.statusTextRes(status)
        else -> null
    }
}
