package com.tabtin.mobile.security

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 *
 * **三段式**：`<tool_name>::<subcmd_or_access>:<scope>`
 *
 * scope 枚举：
 *   - `exact:<hex16>`        精确：本次调用的 fingerprint（**移动端本期不实现**）
 *   - `workspace-internal`   模式：工作区内同类
 *   - `workspace-external`   模式：工作区外同类
 *   - `*`                    通配：所有路径 / 所有参数
 *
 * **本 Android 实现仅覆盖 scoped / wildcard 路径**——`exact:hash16` 跨端 SHA-256 一致性
 * 留下 wave 处理。移动端 always-allow UI 不暴露"精确粒度"选项，统一走 scoped 即可。
 *
 * 参考实现：`packages/security-policy/src/pattern-key.ts:236-254` 的 `buildApprovalKey`
 * 在 scope='scoped' / 'wildcard' 分支下的字面量构造逻辑。
 */
internal object ApprovalKeyBuilder {

    private val LENIENT_JSON = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * scoped 粒度（推荐）：根据 `inWorkspace` 选 `workspace-internal` / `workspace-external`。
     *
     * 例：`execute_command::npm:workspace-internal`
     */
    internal fun buildScoped(toolName: String, subcmd: String, inWorkspace: Boolean): String {
        val t = if (toolName.isBlank()) "unknown_tool" else toolName
        val s = if (subcmd.isBlank()) "_" else subcmd
        val scope = if (inWorkspace) "workspace-internal" else "workspace-external"
        return "$t::$s:$scope"
    }

    /**
     * wildcard 粒度：所有 scope 通配。本 wave 主要给 mcp / 对象类工具用。
     *
     * 例：`mcp_call_tool::stripe-list_charges:*`
     */
    internal fun buildWildcard(toolName: String, subcmd: String): String {
        val t = if (toolName.isBlank()) "unknown_tool" else toolName
        val s = if (subcmd.isBlank()) "_" else subcmd
        return "$t::$s:*"
    }

    /**
     * 从 `toolInputJson`（wire 协议透传的工具入参 JSON 字符串）提取 shell 命令首 token。
     *
     * 与 Electron `ApprovalPanel.tsx:331-333` 行为一致：
     * `(toolArgs.command ?? "").trim().split(/\s+/)[0] ?? "_"`。
     *
     * 复合 subcmd（`git push` → `git-push`）按 spec 附录 B.2 提到的高级处理本期**不做**——
     * L-W6-34 已登记，跟 Electron 行为对齐即可。空命令 / 解析失败统一回落到 `_`。
     */
    internal fun extractShellSubcmd(toolInputJson: String?): String {
        if (toolInputJson.isNullOrBlank()) return "_"
        val cmd = runCatching {
            val element = LENIENT_JSON.parseToJsonElement(toolInputJson)
            val obj: JsonObject = element.jsonObject
            val commandPrim: JsonPrimitive? = obj["command"]?.jsonPrimitive
            commandPrim?.contentOrNull
        }.getOrNull() ?: return "_"

        val trimmed = cmd.trim()
        if (trimmed.isEmpty()) return "_"
        val first = trimmed.split(Regex("\\s+")).firstOrNull().orEmpty()
        return if (first.isEmpty()) "_" else first
    }
}
