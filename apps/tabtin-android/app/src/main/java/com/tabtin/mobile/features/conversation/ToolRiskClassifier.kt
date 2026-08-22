package com.tabtin.mobile.features.conversation

/**
 * 步骤卡折叠分组的只读工具启发式（ 收敛）。
 *
 * **不是权限/风险判定**：审批卡的风险徽章消费 wire `approval_requested.risk_level`
 * （low/medium/high，服务端权威值），本对象只回答「这个已完成的工具步骤是否
 * 足够无聊、可以和相邻步骤折叠成一组」——纯 UX 启发式。
 *
 * 历史：原名 ToolRiskClassifier 带 LOW/MEDIUM/HIGH/CRITICAL 四档 `classify()`
 * 本地按工具名猜风险——与 wire SSoT 脱钩且私造 CRITICAL 档，除 `isLowRisk`
 * 外全部零消费，已随  权限词表精简删除。
 */
public object ToolRiskClassifier {
    private val collapsibleReadonlyTools = setOf(
        "file_read", "read_file", "Read", "document_read",
        "web_search", "web_fetch", "WebSearch", "WebFetch",
        "grep", "glob", "code_search", "semantic_search", "code_grep",
        "Grep", "Glob", "GlobTool", "SearchFiles",
        "code_glob", "code_semantic_search", "list_files",
        "browse_url", "fetch_url",
    )

    /** 已完成的只读工具步骤可折叠成组（AgentStepCard 消费）。 */
    public fun isLowRisk(toolName: String): Boolean = toolName in collapsibleReadonlyTools
}
