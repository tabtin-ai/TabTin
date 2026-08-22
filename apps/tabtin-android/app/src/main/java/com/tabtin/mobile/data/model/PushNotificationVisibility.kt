package com.tabtin.mobile.data.model

/**
 * 对齐 Electron `PushNotificationBubble` / `parsePushNotification`：
 * 后台 shell / 子 Agent 完成注入的 user-role 消息，对用户应显示为系统通知卡，
 * 绝不能当「我发的」气泡。纯子代理完成按桌面 fold 策略从主时间线抑制。
 */
internal object PushNotificationVisibility {
    const val TRIGGERED_BY = "push-notification"

    enum class Outcome { SUCCESS, STOPPED, FAILED }

    data class ParsedTask(
        val kind: Kind,
        val title: String,
        val description: String? = null,
        val outcome: Outcome,
        val killedReason: String? = null,
        val status: String? = null,
    ) {
        enum class Kind { SHELL, SUBAGENT }
    }

    data class Parsed(
        val tasks: List<ParsedTask>,
        val shellCount: Int,
        val subagentCount: Int,
        val failedCount: Int,
    )

    fun isPushNotification(triggeredBy: String?, text: String?): Boolean {
        if (triggeredBy == TRIGGERED_BY) return true
        return text?.contains("<task-notification") == true
    }

    fun shouldHideFromTimeline(triggeredBy: String?, text: String?): Boolean {
        if (!isPushNotification(triggeredBy, text)) return false
        val parsed = parse(text) ?: return false
        return parsed.subagentCount > 0 && parsed.shellCount == 0
    }

    fun displaySummary(triggeredBy: String?, text: String?): String {
        parse(text)?.let { return buildSummary(it) }
        val trimmed = text?.trim().orEmpty()
        return trimmed.ifEmpty { "系统通知" }
    }

    fun parse(content: String?): Parsed? {
        if (content.isNullOrEmpty()) return null
        val blockRe = Regex("""<task-notification(\s+kind="([^"]*)")?\s*>([\s\S]*?)</task-notification>""")
        val tasks = mutableListOf<ParsedTask>()
        var shellCount = 0
        var subagentCount = 0
        var failedCount = 0
        for (match in blockRe.findAll(content)) {
            val kindAttr = match.groupValues.getOrNull(2).orEmpty()
            val inner = match.groupValues.getOrNull(3).orEmpty()
            if (kindAttr == "subagent-completed") {
                val label = extractTag(inner, "label").orEmpty()
                val status = extractTag(inner, "status")
                val outcome = subagentOutcome(status)
                tasks += ParsedTask(
                    kind = ParsedTask.Kind.SUBAGENT,
                    title = label,
                    outcome = outcome,
                    status = status,
                )
                subagentCount += 1
                if (outcome == Outcome.FAILED) failedCount += 1
            } else {
                val command = extractTag(inner, "command").orEmpty()
                val description = extractTag(inner, "description")
                val exitedBy = extractTag(inner, "exited-by")
                val killedReason = extractTag(inner, "killed-reason")
                val outcome = shellOutcome(exitedBy, killedReason)
                tasks += ParsedTask(
                    kind = ParsedTask.Kind.SHELL,
                    title = command,
                    description = description,
                    outcome = outcome,
                    killedReason = killedReason,
                )
                shellCount += 1
                if (outcome == Outcome.FAILED) failedCount += 1
            }
        }
        if (tasks.isEmpty()) return null
        return Parsed(tasks, shellCount, subagentCount, failedCount)
    }

    fun buildSummary(parsed: Parsed): String {
        if (parsed.tasks.size == 1) {
            val task = parsed.tasks.first()
            if (task.kind == ParsedTask.Kind.SHELL) {
                val command = compactCommand(task.description ?: task.title).ifEmpty { "后台命令" }
                return when (task.outcome) {
                    Outcome.SUCCESS -> "后台命令完成：$command"
                    Outcome.STOPPED -> "后台命令已停止：$command"
                    Outcome.FAILED -> if (task.killedReason != null) {
                        "后台命令已终止：$command"
                    } else {
                        "后台命令失败：$command"
                    }
                }
            }
            val label = compactCommand(task.title).ifEmpty { "子 Agent" }
            return when (task.outcome) {
                Outcome.SUCCESS -> "子 Agent 完成：$label"
                Outcome.STOPPED -> "子 Agent 已停止：$label"
                Outcome.FAILED -> "子 Agent 异常结束：$label"
            }
        }
        return if (parsed.failedCount > 0) {
            "${parsed.tasks.size} 个后台任务完成（${parsed.failedCount} 个异常）"
        } else {
            "${parsed.tasks.size} 个后台任务完成"
        }
    }

    private val neutralKilledReasons = setOf("kill_tool", "user_interrupt")

    private fun shellOutcome(exitedBy: String?, killedReason: String?): Outcome {
        if (killedReason != null) {
            return if (killedReason in neutralKilledReasons) Outcome.STOPPED else Outcome.FAILED
        }
        if (exitedBy == "exec_failure" || exitedBy == "signal") return Outcome.FAILED
        return Outcome.SUCCESS
    }

    private fun subagentOutcome(status: String?): Outcome = when (status) {
        "completed" -> Outcome.SUCCESS
        "cancelled" -> Outcome.STOPPED
        else -> Outcome.FAILED
    }

    private fun extractTag(block: String, tag: String): String? {
        val re = Regex("<$tag>([\\s\\S]*?)</$tag>")
        val raw = re.find(block)?.groupValues?.getOrNull(1)?.trim() ?: return null
        return unescapeXml(raw)
    }

    private fun unescapeXml(value: String): String =
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")

    private fun compactCommand(value: String, limit: Int = 48): String {
        val firstLine = value.lineSequence().firstOrNull()?.trim().orEmpty()
        return if (firstLine.length > limit) firstLine.take(limit - 1) + "…" else firstLine
    }
}
