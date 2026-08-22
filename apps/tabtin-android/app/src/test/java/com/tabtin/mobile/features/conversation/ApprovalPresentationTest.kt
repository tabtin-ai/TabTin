package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ApprovalActionRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批展示策略层的口径测试。与 iOS `HITLModelsTests` 中同名用例逐条对应——
 * 两端的分层规则一旦漂移，用户在手机和 iPad 上看到的「关键信息」就会不一样。
 */
class ApprovalPresentationTest {

    private fun action(
        riskLevel: String? = null,
        workspaceZone: String? = null,
        toolName: String = "execute_command",
        decisionReasonType: String? = null,
    ) = ApprovalActionRequest(
        requestId = "req-1",
        toolCallId = "call-1",
        toolName = toolName,
        toolNamespace = null,
        toolInputJson = null,
        decisionReasonType = decisionReasonType,
        decisionReasonFields = null,
        askHintSummary = null,
        askHintSuggestedScope = null,
        allowedScopes = listOf("once"),
        allowedOutcomes = listOf("allow", "deny"),
        riskLevel = riskLevel,
        workspaceZone = workspaceZone,
    )

    // MARK: 参数投射

    @Test
    fun `命令字段被提到独立命令块而不留在参数行`() {
        val layout = ApprovalPresentation.layout("""{"command":"rm -rf build","cwd":"/tmp/x"}""")

        assertEquals("rm -rf build", layout.command?.value)
        assertEquals(ApprovalValueStyle.CODE, layout.command?.style)
        assertTrue(layout.primaryRows.none { it.key == "command" })
    }

    @Test
    fun `主区最多两条已知字段其余进折叠`() {
        val layout = ApprovalPresentation.layout(
            """{"path":"/a/b.txt","cwd":"/a","url":"https://x.dev","query":"hello"}"""
        )

        assertEquals(2, layout.primaryRows.size)
        assertEquals(listOf("path", "cwd"), layout.primaryRows.map { it.key })
        assertEquals(listOf("url", "query"), layout.collapsedRows.map { it.key })
    }

    @Test
    fun `未知字段一律折叠不占主区`() {
        val layout = ApprovalPresentation.layout("""{"timeout_ms":5000,"path":"/a/b.txt"}""")

        assertEquals(listOf("path"), layout.primaryRows.map { it.key })
        assertEquals(listOf("timeout_ms"), layout.collapsedRows.map { it.key })
        assertTrue(layout.collapsedRows.first().label is ApprovalFieldLabel.Raw)
    }

    @Test
    fun `未知字段的名字把下划线换成空格`() {
        val rows = ApprovalPresentation.parameterRows("""{"max_output_tokens":10}""")

        assertEquals("max output tokens", (rows.single().label as ApprovalFieldLabel.Raw).text)
    }

    @Test
    fun `目录类字段被归到目录而不是落进未知字段`() {
        val rows = ApprovalPresentation.parameterRows("""{"working_dir":"/repo"}""")

        assertEquals(
            ApprovalFieldLabel.Res(R.string.chat_approval_field_directory),
            rows.single().label,
        )
        assertEquals(ApprovalValueStyle.PATH, rows.single().style)
    }

    @Test
    fun `explanation 不混进参数行`() {
        val json = """{"explanation":"要清理构建产物","command":"rm -rf build"}"""

        assertEquals("要清理构建产物", ApprovalPresentation.explanation(json))
        assertTrue(ApprovalPresentation.parameterRows(json).none { it.key == "explanation" })
    }

    @Test
    fun `Skill 调用的实参单独成行`() {
        val rows = ApprovalPresentation.parameterRows("""{"skill":"deploy","args":{"env":"prod"}}""")

        assertEquals(
            ApprovalFieldLabel.Res(R.string.chat_approval_field_args),
            rows.first { it.key == "args" }.label,
        )
        assertEquals("env：prod", rows.first { it.key == "args" }.value)
    }

    @Test
    fun `布尔值用调用方注入的本地化文案`() {
        val rows = ApprovalPresentation.parameterRows(
            """{"force":true}""",
            ApprovalValueLabels(yes = "Yes", no = "No"),
        )

        assertEquals("Yes", rows.single().value)
    }

    @Test
    fun `整数形态的浮点值不带小数点`() {
        assertEquals("3", ApprovalPresentation.parameterRows("""{"n":3.0}""").single().value)
    }

    @Test
    fun `坏 JSON 回落到空而不是把原文甩回 UI`() {
        assertEquals(ApprovalActionLayout.EMPTY, ApprovalPresentation.layout("{not json"))
        assertEquals(emptyList<ApprovalParameterRow>(), ApprovalPresentation.parameterRows(null))
    }

    // MARK: 风险提示

    @Test
    fun `低风险不产生风险提示行`() {
        assertNull(ApprovalPresentation.riskHint(riskLevel = "low", workspaceZone = "inside"))
        assertNull(ApprovalPresentation.riskHint(riskLevel = null, workspaceZone = null))
    }

    @Test
    fun `低风险越界或敏感资源仍保留风险提示行`() {
        val outside = ApprovalPresentation.riskHint(riskLevel = "low", workspaceZone = "outside")
        assertEquals(R.string.chat_approval_risk_medium, outside?.riskResId)
        assertEquals(R.string.chat_approval_risk_zone_outside, outside?.zoneResId)
        assertEquals(ApprovalRiskEmphasis.WARNING, outside?.emphasis)

        val sensitive = ApprovalPresentation.riskHint(riskLevel = "low", workspaceZone = "sensitive")
        assertEquals(R.string.chat_approval_risk_medium, sensitive?.riskResId)
        assertEquals(R.string.chat_approval_risk_zone_sensitive, sensitive?.zoneResId)
        assertEquals(ApprovalRiskEmphasis.WARNING, sensitive?.emphasis)
    }

    @Test
    fun `中风险只在越界或敏感时才提示`() {
        assertNull(ApprovalPresentation.riskHint(riskLevel = "medium", workspaceZone = "inside"))

        val hint = ApprovalPresentation.riskHint(riskLevel = "medium", workspaceZone = "outside")
        assertEquals(R.string.chat_approval_risk_medium, hint?.riskResId)
        assertEquals(R.string.chat_approval_risk_zone_outside, hint?.zoneResId)
        assertEquals(ApprovalRiskEmphasis.WARNING, hint?.emphasis)
    }

    @Test
    fun `高风险总是提示并标为 critical`() {
        val hint = ApprovalPresentation.riskHint(riskLevel = "high", workspaceZone = "inside")

        assertEquals(R.string.chat_approval_risk_high, hint?.riskResId)
        assertNull(hint?.zoneResId)
        assertEquals(ApprovalRiskEmphasis.CRITICAL, hint?.emphasis)
    }

    @Test
    fun `敏感区会追加受保护资源说明`() {
        val hint = ApprovalPresentation.riskHint(riskLevel = "high", workspaceZone = "sensitive")

        assertEquals(R.string.chat_approval_risk_zone_sensitive, hint?.zoneResId)
    }

    // MARK: 收起态直批门槛

    @Test
    fun `单条低风险工作区内允许收起态直批`() {
        assertTrue(
            ApprovalPresentation.allowsDirectApproval(
                listOf(action(riskLevel = "low", workspaceZone = "inside"))
            )
        )
    }

    @Test
    fun `高风险不允许收起态直批`() {
        assertFalse(
            ApprovalPresentation.allowsDirectApproval(
                listOf(action(riskLevel = "high", workspaceZone = "inside"))
            )
        )
    }

    @Test
    fun `敏感或越界不允许收起态直批`() {
        assertFalse(
            ApprovalPresentation.allowsDirectApproval(
                listOf(action(riskLevel = "low", workspaceZone = "sensitive"))
            )
        )
        assertFalse(
            ApprovalPresentation.allowsDirectApproval(
                listOf(action(riskLevel = "low", workspaceZone = "outside"))
            )
        )
    }

    @Test
    fun `多条操作一律要求展开确认`() {
        assertFalse(
            ApprovalPresentation.allowsDirectApproval(
                listOf(
                    action(riskLevel = "low", workspaceZone = "inside"),
                    action(riskLevel = "low", workspaceZone = "inside"),
                )
            )
        )
    }

    @Test
    fun `空批次不允许直批`() {
        assertFalse(ApprovalPresentation.allowsDirectApproval(emptyList()))
    }

    // MARK: 工作区归属的兜底（：workspace_zone 未下发）

    @Test
    fun `字段缺失时从判决理由反推越界并拦住直批`() {
        val outside = action(riskLevel = "low", decisionReasonType = "workspace_out")

        assertEquals("outside", ApprovalPresentation.workspaceZone(outside))
        assertFalse(ApprovalPresentation.allowsDirectApproval(listOf(outside)))
        assertEquals(ApprovalSeverity.WARNING, ApprovalPresentation.severity(listOf(outside)))
    }

    @Test
    fun `路径受限的判决理由同样算越界`() {
        listOf("deny_read_path", "deny_write_path").forEach { reason ->
            assertEquals(
                "outside",
                ApprovalPresentation.workspaceZone(action(decisionReasonType = reason)),
            )
        }
    }

    @Test
    fun `敏感资源的判决理由反推为敏感区`() {
        listOf("sensitive_in_ask", "sensitive_out_deny").forEach { reason ->
            val sensitive = action(riskLevel = "low", decisionReasonType = reason)
            assertEquals("sensitive", ApprovalPresentation.workspaceZone(sensitive))
            assertEquals(
                ApprovalSeverity.CRITICAL,
                ApprovalPresentation.severity(listOf(sensitive)),
            )
        }
    }

    @Test
    fun `字段有值时优先于判决理由`() {
        val zoned = action(workspaceZone = "sensitive", decisionReasonType = "workspace_out")

        assertEquals("sensitive", ApprovalPresentation.workspaceZone(zoned))
    }

    @Test
    fun `工作区内的判决理由不产生归属也不拦直批`() {
        val inside = action(riskLevel = "low", decisionReasonType = "user_interactive")

        assertNull(ApprovalPresentation.workspaceZone(inside))
        assertTrue(ApprovalPresentation.allowsDirectApproval(listOf(inside)))
    }

    // MARK: 严重度

    @Test
    fun `任一条高危即整批高危`() {
        val severity = ApprovalPresentation.severity(
            listOf(action(riskLevel = "low"), action(riskLevel = "high"))
        )

        assertEquals(ApprovalSeverity.CRITICAL, severity)
    }

    @Test
    fun `全部低风险时整批为中性`() {
        assertEquals(
            ApprovalSeverity.NEUTRAL,
            ApprovalPresentation.severity(listOf(action(riskLevel = "low"))),
        )
    }

    @Test
    fun `越界会把整批抬到 warning`() {
        assertEquals(
            ApprovalSeverity.WARNING,
            ApprovalPresentation.severity(
                listOf(action(riskLevel = "low", workspaceZone = "outside"))
            ),
        )
    }

    // MARK: 工具动作短语

    @Test
    fun `工具名映射到动作短语`() {
        assertEquals(R.string.chat_tool_verb_terminal, ToolVerbs.resIdFor("execute_command"))
        assertEquals(R.string.chat_tool_verb_terminal, ToolVerbs.resIdFor("BASH"))
        assertEquals(R.string.chat_tool_verb_delete_file, ToolVerbs.resIdFor("delete_file"))
    }

    @Test
    fun `未知工具回落通用动作短语`() {
        assertEquals(R.string.chat_tool_verb_generic, ToolVerbs.resIdFor("some_custom_mcp_tool"))
    }
}
