package com.tabtin.mobile.security

import com.tabtin.mobile.data.model.ApprovalActionRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * W6 M4.2 L-W6-30 单测：覆盖 Android always-allow 路径生成 `patternKey` /
 * `scopeDescription` / `decisionKind` 三字段。
 *
 * 测试范围：
 *   1. `ScopeDescriptionBuilder.build` 关键 case：execute_command / read_file /
 *      mcp_call_tool / 未知工具 fallback / 空 subcmd 边界 / scope='*' 通配。
 *   2. `ApprovalKeyBuilder.buildScoped / buildWildcard / extractShellSubcmd`。
 *   3. `ApprovalDecisionPayloadBuilder.build`：always-allow 整批 input 三字段断言；
 *      once / thread / deny 路径**不应**出现三字段（避免污染 memo）。
 *   4. SpaceSecurityScreen.MemoRow 等价 fallback 表达式（防 `?:` 反向衰退）。
 *
 * **跟 Electron 端文案对齐**——`packages/security-policy/src/scope-descriptions.ts`
 * 的 TEMPLATES 是 SSoT，本端只是 Kotlin 镜像。改动文案前先改 SSoT。
 */
class SecurityBuildersTest {

    // ---------------------------------------------------------------------
    // ScopeDescriptionBuilder
    // ---------------------------------------------------------------------

    @Test
    fun scopeDescription_executeCommand_withSubcmd() {
        val label = ScopeDescriptionBuilder.build(
            toolName = "execute_command",
            subcmd = "npm",
            scope = "workspace-internal",
        )
        assertEquals("执行 shell 命令 npm", label)
    }

    @Test
    fun scopeDescription_executeCommand_wildcardScope() {
        val label = ScopeDescriptionBuilder.build(
            toolName = "execute_command",
            subcmd = "rm",
            scope = "*",
        )
        // 通配 scope 下不带具体 subcmd，避免误导用户"以为只放行 rm"
        assertEquals("执行任意 shell 命令", label)
    }

    @Test
    fun scopeDescription_executeCommand_emptySubcmd() {
        val label = ScopeDescriptionBuilder.build(
            toolName = "execute_command",
            subcmd = "_",
            scope = "workspace-internal",
        )
        assertEquals("执行 shell 命令", label)
    }

    @Test
    fun scopeDescription_readFile_normalAndWildcard() {
        assertEquals(
            "读取文件",
            ScopeDescriptionBuilder.build("read_file", "_", "workspace-internal"),
        )
        assertEquals(
            "读取任意文件",
            ScopeDescriptionBuilder.build("read_file", "_", "*"),
        )
    }

    @Test
    fun scopeDescription_mcp_withServerToolSubcmd() {
        val label = ScopeDescriptionBuilder.build(
            toolName = "mcp_call_tool",
            subcmd = "stripe-list_charges",
            scope = "*",
        )
        assertEquals("调用 MCP 工具 stripe-list_charges", label)
    }

    @Test
    fun scopeDescription_unknownTool_fallbackUnderscoreToSpace() {
        val label = ScopeDescriptionBuilder.build(
            toolName = "tabsite_publish",
            subcmd = "_",
            scope = "workspace-internal",
        )
        // 未在 TEMPLATES 内的工具：`_` → 空格，subcmd 为 `_` 时只显示工具名
        assertEquals("tabsite publish", label)
    }

    @Test
    fun scopeDescription_deviceAction_withAndWithoutSubcmd() {
        assertEquals(
            "设备操作 screen_capture",
            ScopeDescriptionBuilder.build("device_action", "screen_capture", "*"),
        )
        assertEquals(
            "执行设备操作",
            ScopeDescriptionBuilder.build("device_action", "_", "*"),
        )
    }

    // ---------------------------------------------------------------------
    // ApprovalKeyBuilder
    // ---------------------------------------------------------------------

    @Test
    fun buildScoped_internalVsExternal() {
        assertEquals(
            "execute_command::rm:workspace-internal",
            ApprovalKeyBuilder.buildScoped("execute_command", "rm", inWorkspace = true),
        )
        assertEquals(
            "execute_command::rm:workspace-external",
            ApprovalKeyBuilder.buildScoped("execute_command", "rm", inWorkspace = false),
        )
    }

    @Test
    fun buildWildcard_mcpExample() {
        assertEquals(
            "mcp_call_tool::stripe-list_charges:*",
            ApprovalKeyBuilder.buildWildcard("mcp_call_tool", "stripe-list_charges"),
        )
    }

    @Test
    fun buildScoped_emptySubcmdFallsBackToUnderscore() {
        // spec 附录 B：subcmd 空时 fallback 到 `_`，避免出现 `tool::` 这种空段
        assertEquals(
            "read_file::_:workspace-internal",
            ApprovalKeyBuilder.buildScoped("read_file", "", inWorkspace = true),
        )
    }

    @Test
    fun extractShellSubcmd_typicalCommand() {
        val json = """{"command": "npm install --save-dev"}"""
        assertEquals("npm", ApprovalKeyBuilder.extractShellSubcmd(json))
    }

    @Test
    fun extractShellSubcmd_compositeCommandTakesFirstToken() {
        // L-W6-34 接受现状：`git push` 当前只取 `git`。复合 subcmd 跟 Electron 同步处理
        val json = """{"command": "git push origin main"}"""
        assertEquals("git", ApprovalKeyBuilder.extractShellSubcmd(json))
    }

    @Test
    fun extractShellSubcmd_whitespacePadded() {
        val json = """{"command": "   ls -la   "}"""
        assertEquals("ls", ApprovalKeyBuilder.extractShellSubcmd(json))
    }

    @Test
    fun extractShellSubcmd_missingFieldOrInvalidJson() {
        assertEquals("_", ApprovalKeyBuilder.extractShellSubcmd(null))
        assertEquals("_", ApprovalKeyBuilder.extractShellSubcmd(""))
        assertEquals("_", ApprovalKeyBuilder.extractShellSubcmd("""{"path":"/tmp"}"""))
        assertEquals("_", ApprovalKeyBuilder.extractShellSubcmd("not json"))
        assertEquals("_", ApprovalKeyBuilder.extractShellSubcmd("""{"command": ""}"""))
    }

    // ---------------------------------------------------------------------
    // ApprovalDecisionPayloadBuilder
    // ---------------------------------------------------------------------

    private fun shellInsideAR(): ApprovalActionRequest = ApprovalActionRequest(
        requestId = "req-1",
        toolCallId = "tc-1",
        toolName = "execute_command",
        toolNamespace = null,
        toolInputJson = """{"command": "rm -rf ./build"}""",
        decisionReasonType = null,
        decisionReasonFields = null,
        askHintSummary = null,
        askHintSuggestedScope = null,
        allowedScopes = listOf("once", "always"),
        allowedOutcomes = listOf("allow", "deny"),
        riskLevel = "medium",
        workspaceZone = "inside",
    )

    private fun readFileOutsideAR(): ApprovalActionRequest = ApprovalActionRequest(
        requestId = "req-2",
        toolCallId = "tc-2",
        toolName = "read_file",
        toolNamespace = null,
        toolInputJson = """{"path": "/etc/hosts"}""",
        decisionReasonType = null,
        decisionReasonFields = null,
        askHintSummary = null,
        askHintSuggestedScope = null,
        allowedScopes = listOf("once", "always"),
        allowedOutcomes = listOf("allow", "deny"),
        riskLevel = "low",
        workspaceZone = "outside",
    )

    @Test
    fun buildPayload_alwaysAllow_includesThreeFields_workspaceInternal() {
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(shellInsideAR()),
            outcome = "allow",
            scope = "always",
        )
        assertEquals(1, payload.size)
        val d = payload[0]
        assertEquals("tc-1", d.toolCallId)
        assertEquals("req-1", d.requestId)
        assertEquals("allow", d.outcome)
        assertEquals("always", d.scope)
        assertEquals("execute_command::rm:workspace-internal", d.patternKey)
        assertEquals("执行 shell 命令 rm", d.scopeDescription)
        assertEquals("pattern", d.decisionKind)
    }

    @Test
    fun buildPayload_alwaysAllow_workspaceExternal_readFile() {
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(readFileOutsideAR()),
            outcome = "allow",
            scope = "always",
        )
        assertEquals(1, payload.size)
        val d = payload[0]
        assertEquals("read_file::_:workspace-external", d.patternKey)
        assertEquals("读取文件", d.scopeDescription)
        assertEquals("pattern", d.decisionKind)
    }

    @Test
    fun buildPayload_onceScope_doesNotAttachThreeFields() {
        // once 不写 memo，附带三字段毫无意义；should be null
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(shellInsideAR()),
            outcome = "allow",
            scope = "once",
        )
        val d = payload[0]
        assertEquals("once", d.scope)
        assertNull(d.patternKey)
        assertNull(d.scopeDescription)
        assertNull(d.decisionKind)
    }

    @Test
    fun buildPayload_threadScope_doesNotAttachThreeFields() {
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(shellInsideAR()),
            outcome = "allow",
            scope = "thread",
        )
        val d = payload[0]
        assertEquals("thread", d.scope)
        assertNull(d.patternKey)
        assertNull(d.scopeDescription)
        assertNull(d.decisionKind)
    }

    @Test
    fun buildPayload_deny_neverHasScopeOrThreeFields() {
        // deny 路径：scope 字段不带（M4.2 不动 deny 既有逻辑）；三字段也不带
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(shellInsideAR()),
            outcome = "deny",
            scope = null,
        )
        val d = payload[0]
        assertEquals("deny", d.outcome)
        assertNull(d.scope)
        assertNull(d.patternKey)
        assertNull(d.scopeDescription)
        assertNull(d.decisionKind)
    }

    @Test
    fun buildPayload_batchOfTwo_eachGetsOwnPatternKey() {
        val payload = ApprovalDecisionPayloadBuilder.build(
            actionRequests = listOf(shellInsideAR(), readFileOutsideAR()),
            outcome = "allow",
            scope = "always",
        )
        assertEquals(2, payload.size)
        assertNotNull(payload[0].patternKey)
        assertNotNull(payload[1].patternKey)
        assertEquals("execute_command::rm:workspace-internal", payload[0].patternKey)
        assertEquals("read_file::_:workspace-external", payload[1].patternKey)
    }

    // ---------------------------------------------------------------------
    // SpaceSecurityScreen.MemoRow fallback (单测纯逻辑等价)
    // ---------------------------------------------------------------------

    /**
     * `SpaceSecurityScreen.MemoRow` 的 fallback 表达式：空字符串视同缺失，回退到 key。
     * 这条测试纯粹防 `?:` 反向衰退（Kotlin `?:` 只 fallback null，不 fallback ""）。
     */
    @Test
    fun memoLabelFallback_nilOrEmptyDescriptionFallsBackToKey() {
        val key = "execute_command::rm:workspace-internal"

        assertEquals(key, memoLabel(scopeDescription = null, key = key))
        assertEquals(key, memoLabel(scopeDescription = "", key = key))
        assertEquals(
            "工作区内的 rm 命令",
            memoLabel(scopeDescription = "工作区内的 rm 命令", key = key),
        )
    }

    /** 跟 SpaceSecurityScreen.MemoRow 同源的 fallback 表达式（隔离纯函数版）。 */
    private fun memoLabel(scopeDescription: String?, key: String): String =
        scopeDescription?.takeIf { it.isNotEmpty() } ?: key
}
