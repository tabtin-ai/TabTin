package com.tabtin.mobile.security

import com.tabtin.mobile.data.model.ApprovalActionRequest
import com.tabtin.mobile.data.repository.ChatRepository

/**
 * 把 `ApprovalPanelView` always-allow 决策转换成 `ChatRepository.ApprovalDecisionInput` 列表。
 *
 * 抽出独立函数有两个目的：
 *   1. **可测试**：JUnit 直接断言生成的 input 列表含 `patternKey` / `scopeDescription` /
 *      `decisionKind` 三字段，避免触碰 OkHttp / WebSocket。
 *   2. **跟 iOS / Electron 同构**：iOS `ApprovalDecisionPayloadBuilder` + Electron
 *      `ApprovalPanel.tsx::handleAlwaysAllow` 322-360 行的构造逻辑在 Android 跑一份等价实现。
 *
 * **wire schema 兼容性**（无需动 schema）：
 *   - `LocalRtUserResponseDecisionSchema` 用 `.passthrough()` 接受未声明字段
 *     （`packages/agent-wire/src/approval.ts:451-457`）
 *   - Python 端 `LocalRtUserResponseDecision` 用 `extra="allow"` 同样接受
 *     （`agent_wire.py:1033-1042`）
 *   - 三字段经 Django relay → Daemon → runtime 透传到 `local-permission-handler.ts:307-320`
 *     写入 memo entry。
 */
public object ApprovalDecisionPayloadBuilder {

    /**
     * 构造一组上行 wire decisions 输入。
     *
     * @param actionRequests 当前 batch 内的所有 ActionRequest（同 batchId）
     * @param outcome `"allow"` / `"deny"`；`"cancelled"` 由 ViewModel 本端 dismiss 处理，
     *   不进入本函数
     * @param scope 用户在 panel 上选的 scope（`"once"` / `"thread"` / `"always"`），
     *   只在 `outcome == "allow"` 时有意义；其他情况传 `null`
     *
     * 三字段附加规则：
     *   - 仅当 `outcome == "allow" && scope == "always"` 时**才**给每条 decision 计算
     *     `patternKey` / `scopeDescription` / `decisionKind`。其他 scope（`once` / `thread`）
     *     不写 memo，无需附带。
     *   - `decisionKind` 移动端**统一传 `"pattern"`**——只支持 scoped 粒度，不暴露
     *     "精确粒度"UI 选项。
     */
    public fun build(
        actionRequests: List<ApprovalActionRequest>,
        outcome: String,
        scope: String?,
    ): List<ChatRepository.ApprovalDecisionInput> {
        val effectiveScope = if (outcome == "allow") scope else null
        val isAlwaysAllow = outcome == "allow" && scope == "always"

        return actionRequests.map { ar ->
            if (!isAlwaysAllow) {
                ChatRepository.ApprovalDecisionInput(
                    toolCallId = ar.toolCallId,
                    outcome = outcome,
                    scope = effectiveScope,
                    requestId = ar.requestId,
                )
            } else {
                val inWorkspace = ar.workspaceZone == "inside"
                val subcmd = ApprovalKeyBuilder.extractShellSubcmd(ar.toolInputJson)
                val scopeStr = if (inWorkspace) "workspace-internal" else "workspace-external"

                ChatRepository.ApprovalDecisionInput(
                    toolCallId = ar.toolCallId,
                    outcome = outcome,
                    scope = effectiveScope,
                    requestId = ar.requestId,
                    patternKey = ApprovalKeyBuilder.buildScoped(
                        toolName = ar.toolName,
                        subcmd = subcmd,
                        inWorkspace = inWorkspace,
                    ),
                    scopeDescription = ScopeDescriptionBuilder.build(
                        toolName = ar.toolName,
                        subcmd = subcmd,
                        scope = scopeStr,
                    ),
                    decisionKind = "pattern",
                )
            }
        }
    }
}
