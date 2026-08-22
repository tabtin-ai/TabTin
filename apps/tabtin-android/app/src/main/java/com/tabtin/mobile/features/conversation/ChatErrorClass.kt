package com.tabtin.mobile.features.conversation

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

internal enum class ChatErrorSeverity { ERROR, WARNING, NEUTRAL }

internal data class ChatErrorClassInfo(
    val errorClass: String,
    val title: String,
    val suggestion: String,
    val severity: ChatErrorSeverity,
    val retryable: Boolean,
    /**
     * Wave 5 Review：与 Electron `ErrorClassInfo.suggestedAction`（errorClassMap.ts:16）对齐。
     * 后端在 metadata 里下发的动作码，前端用它决定是否渲染"去充值 / 重新登录 / 新建对话"等
     * actionable 按钮（对齐 Electron MessageBubble ErrorClassCard 的 ACTION_LABELS）。
     * 为 null 时 ChatErrorClassCard 只展示 title + suggestion，不显示按钮。
     */
    val suggestedAction: String? = null,
)

private data class ChatErrorClassConfig(
    @StringRes val titleRes: Int,
    @StringRes val suggestionRes: Int,
    val severity: ChatErrorSeverity,
    val retryable: Boolean,
)

private val ERROR_CLASS_CONFIG: Map<String, ChatErrorClassConfig> = mapOf(
    "LLM_PROVIDER_ERROR" to ChatErrorClassConfig(
        R.string.chat_error_class_llm_provider_title,
        R.string.chat_error_class_llm_provider_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = true,
    ),
    "LLM_ERROR" to ChatErrorClassConfig(
        R.string.chat_error_class_llm_error_title,
        R.string.chat_error_class_llm_error_suggestion,
        ChatErrorSeverity.WARNING,
        retryable = true,
    ),
    "CONTEXT_OVERFLOW" to ChatErrorClassConfig(
        R.string.chat_error_class_context_overflow_title,
        R.string.chat_error_class_context_overflow_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = false,
    ),
    "TOOL_EXECUTION_ERROR" to ChatErrorClassConfig(
        R.string.chat_error_class_tool_execution_title,
        R.string.chat_error_class_tool_execution_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = true,
    ),
    "iteration_budget_exhausted" to ChatErrorClassConfig(
        R.string.chat_error_class_iteration_budget_title,
        R.string.chat_error_class_iteration_budget_suggestion,
        ChatErrorSeverity.WARNING,
        retryable = false,
    ),
    "token_budget_exhausted" to ChatErrorClassConfig(
        R.string.chat_error_class_token_budget_title,
        R.string.chat_error_class_token_budget_suggestion,
        ChatErrorSeverity.WARNING,
        retryable = false,
    ),
    "BUDGET_EXHAUSTED" to ChatErrorClassConfig(
        R.string.chat_error_class_budget_exhausted_title,
        R.string.chat_error_class_budget_exhausted_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = false,
    ),
    "RATE_LIMITED" to ChatErrorClassConfig(
        R.string.chat_error_class_rate_limited_title,
        R.string.chat_error_class_rate_limited_suggestion,
        ChatErrorSeverity.WARNING,
        retryable = true,
    ),
    "INTERNAL" to ChatErrorClassConfig(
        R.string.chat_error_class_internal_title,
        R.string.chat_error_class_internal_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = true,
    ),
    "LLM_KEY_EXHAUSTED" to ChatErrorClassConfig(
        R.string.chat_error_class_llm_key_exhausted_title,
        R.string.chat_error_class_llm_key_exhausted_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = false,
    ),
    //  / Electron ：用户主动 Stop 是中性事件，不走 Warning 错误卡。
    // title 指向 chat_message_interrupted「已中断」；Card 层对 NEUTRAL 会降级为 inline 徽标。
    "ABORT" to ChatErrorClassConfig(
        R.string.chat_message_interrupted,
        R.string.chat_message_interrupted,
        ChatErrorSeverity.NEUTRAL,
        retryable = false,
    ),
    "BYOK_PROVIDER_UNAVAILABLE" to ChatErrorClassConfig(
        R.string.chat_error_class_byok_provider_unavailable_title,
        R.string.chat_error_class_byok_provider_unavailable_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = true,
    ),
    "BYOK_RATE_LIMIT_EXCEEDED" to ChatErrorClassConfig(
        R.string.chat_error_class_byok_rate_limit_title,
        R.string.chat_error_class_byok_rate_limit_suggestion,
        ChatErrorSeverity.WARNING,
        retryable = true,
    ),
    "BYOK_QUOTA_EXHAUSTED" to ChatErrorClassConfig(
        R.string.chat_error_class_byok_quota_exhausted_title,
        R.string.chat_error_class_byok_quota_exhausted_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = false,
    ),
    "BYOK_INVALID_KEY" to ChatErrorClassConfig(
        R.string.chat_error_class_byok_invalid_key_title,
        R.string.chat_error_class_byok_invalid_key_suggestion,
        ChatErrorSeverity.ERROR,
        retryable = false,
    ),
)

private val DEFAULT_ERROR_CLASS_CONFIG = ChatErrorClassConfig(
    R.string.chat_error_class_unknown_title,
    R.string.chat_error_class_unknown_suggestion,
    ChatErrorSeverity.ERROR,
    retryable = true,
)

// Wave 6 §7 + 协议对照 Review P1-2：与 iOS `ChatErrorClassCard.swift:149-168
// categoryToErrorClass` 全量对齐（11 项）。
//
// 为什么 category 层和 code 层要同时映射：
//   `resolveErrorClassInfo` 优先级是 explicit_class → category → code。若后端只下发
//   `error_category`（不带 code，如旧 agent 路径），Android 仍需在 category 层命中，
//   否则会落 DEFAULT 通用卡——与 iOS 体验分叉。
//
// 5 项新增语义（与 iOS 同）：
//   - "quota"              → BUDGET_EXHAUSTED（conversation_quota_exceeded 的简名）
//   - "persist_error"      → INTERNAL（result_finalizer persist 失败）
//   - "internal_error"     → INTERNAL（chat_send_message 兜底分类）
//   - "route_failed"       → INTERNAL（route_none / runtime_failed 归类）
//   - "configuration_error"→ INTERNAL（missing_organization_id / service_disabled 归类）
//
// 这些 category 的 error_code 路径映射已在 ERROR_CODE_TO_ERROR_CLASS 覆盖，但保持 category
// 路径与 iOS 同口径能处理 "只有 category 没 code" 的场景（Wave 5 协议对照 Review 遗留项）。
private val CATEGORY_TO_ERROR_CLASS: Map<String, String> = mapOf(
    "llm_provider_error" to "LLM_PROVIDER_ERROR",
    "context_overflow" to "CONTEXT_OVERFLOW",
    "tool_exec" to "TOOL_EXECUTION_ERROR",
    "billing" to "BUDGET_EXHAUSTED",
    "quota" to "BUDGET_EXHAUSTED",
    "rate_limited" to "RATE_LIMITED",
    "aborted" to "ABORT",
    "persist_error" to "INTERNAL",
    "internal_error" to "INTERNAL",
    "route_failed" to "INTERNAL",
    "configuration_error" to "INTERNAL",
    "byok_provider_unavailable" to "BYOK_PROVIDER_UNAVAILABLE",
    "byok_rate_limit_exceeded" to "BYOK_RATE_LIMIT_EXCEEDED",
    "byok_quota_exhausted" to "BYOK_QUOTA_EXHAUSTED",
    "byok_invalid_key" to "BYOK_INVALID_KEY",
)

/**
 * Wave 5 协议 Review P2：与 iOS `ChatErrorClassCard.errorClassAliases`（Wave 5-iOS
 * 核心改动）对齐。后端 runtime 可能把 `AgentErrorCode` 原生枚举（TOOL_ERROR /
 * LLM_RATE_LIMIT / MAX_TURNS_EXCEEDED 等）直接塞进 `error_class` 字段——这些值不在
 * `ERROR_CLASS_CONFIG` 的 11 个 Electron 键目里，原实现会落 `DEFAULT_ERROR_CLASS_CONFIG`
 * "出了点问题"通用卡，用户看不出真正错因。
 *
 * 把 runtime 原生值别名到 Electron 对齐的类目：
 *   - TOOL_* → TOOL_EXECUTION_ERROR
 *   - LLM_RATE_LIMIT → RATE_LIMITED
 *   - LLM_BILLING_ERROR / MAX_CREDITS_EXCEEDED → BUDGET_EXHAUSTED
 *   - MAX_TURNS_EXCEEDED / DOOM_LOOP_DETECTED → iteration_budget_exhausted
 *   - PERMISSION_* → TOOL_EXECUTION_ERROR
 *   - CAP_NOT_BOUND → INTERNAL
 *
 * SYNC: packages/agent-runtime/src/engine/types.ts `AgentErrorCode`
 * SYNC: apps/tabtin-ios/.../ChatErrorClassCard.swift errorClassAliases
 */
private val ERROR_CLASS_ALIASES: Map<String, String> = mapOf(
    "TOOL_ERROR" to "TOOL_EXECUTION_ERROR",
    "TOOL_TIMEOUT" to "TOOL_EXECUTION_ERROR",
    "LLM_RATE_LIMIT" to "RATE_LIMITED",
    "LLM_BILLING_ERROR" to "BUDGET_EXHAUSTED",
    "MAX_CREDITS_EXCEEDED" to "BUDGET_EXHAUSTED",
    "MAX_TURNS_EXCEEDED" to "iteration_budget_exhausted",
    "DOOM_LOOP_DETECTED" to "iteration_budget_exhausted",
    "PERMISSION_DENIED" to "TOOL_EXECUTION_ERROR",
    "PERMISSION_TIMEOUT" to "TOOL_EXECUTION_ERROR",
    "CAP_NOT_BOUND" to "INTERNAL",
)

private val ERROR_CODE_TO_ERROR_CLASS: Map<String, String> = mapOf(
    "context_overflow" to "CONTEXT_OVERFLOW",
    "tool_exec" to "TOOL_EXECUTION_ERROR",
    "tool_timeout" to "TOOL_EXECUTION_ERROR",
    "llm_provider_error" to "LLM_PROVIDER_ERROR",
    "llm_call" to "LLM_PROVIDER_ERROR",
    "llm_timeout" to "LLM_ERROR",
    "iteration_budget_exhausted" to "iteration_budget_exhausted",
    "token_budget_exhausted" to "token_budget_exhausted",
    "internal_error" to "INTERNAL",
    // Wave 5 协议 Review P5：unknown_error 此前映射 "UNKNOWN"（不在 ERROR_CLASS_CONFIG，
    // 落 DEFAULT_ERROR_CLASS_CONFIG 通用卡）；iOS `codeToErrorClass["unknown_error"] = "INTERNAL"`，
    // 两移动端应统一。"INTERNAL" 有专属文案"内部错误，可重试"，比 UNKNOWN 的"出了点问题"更有动作指引。
    "unknown_error" to "INTERNAL",
    "device_offline" to "INTERNAL",
    "device_busy" to "INTERNAL",
    // Wave 5 独立验证 🟡-3 补齐：把 iOS `ChatErrorClassCard.swift:190-222` 里多出的 9 个
    // error_code 同步进来。iOS 注释写"对齐 Wave 5-Android"，但 Android 原版只有 device_offline /
    // device_busy；这里把设备链路（device_unreachable / device_dropped / runtime_failed /
    // route_failed / route_none）、持久化（persist_error）、认证（auth_required）归到 INTERNAL，
    // 权限（permission_denied）归到 TOOL_EXECUTION_ERROR，LLM 进程级超时（process_timeout）归到
    // LLM_ERROR（warning + retryable）。让这些后端原生 error_code 能落结构化错误卡而不是通用卡。
    "device_unreachable" to "INTERNAL",
    "device_dropped" to "INTERNAL",
    "runtime_failed" to "INTERNAL",
    "route_failed" to "INTERNAL",
    "route_none" to "INTERNAL",
    "persist_error" to "INTERNAL",
    "auth_required" to "INTERNAL",
    "permission_denied" to "TOOL_EXECUTION_ERROR",
    "process_timeout" to "LLM_ERROR",
    "cancelled" to "ABORT",
    "aborted" to "ABORT",
    "rate_limited" to "RATE_LIMITED",
    "insufficient_credits" to "BUDGET_EXHAUSTED",
    "organization_insufficient_credits" to "BUDGET_EXHAUSTED",
    "budget_exceeded" to "BUDGET_EXHAUSTED",
    "conversation_quota_exceeded" to "BUDGET_EXHAUSTED",
)

/**
 * Wave 5 协议 Review R-1 补丁：与 iOS `ChatErrorClassCard.contextOverflowFallbackActions`
 * 对齐。后端对这三类 error_class 经常不下发 suggested_action（老 agent 路径或产品描述性
 * 错误），但"新建对话"是用户唯一的恢复动作，iOS Wave 5 已补兜底；Android 这里同步补上，
 * 保证两移动端体验一致。
 *
 * 逻辑：resolveErrorClassInfo 解出 errorClass 后，若 suggestedAction 仍为空或不是已知动作码，
 * 且 errorClass 属于"上下文/预算超限"类，兜底为 `shorten_context`。
 *
 * 严格比 Electron 基线多做一步（Electron 自己没这个兜底）——本轮按"两移动端优先对齐"原则
 * 覆盖，记入 §7 遗留项若后续产品决策要求严格对齐 Electron 可轻量回退（删这个常量 + 相关分支）。
 */
private val CONTEXT_OVERFLOW_FALLBACK_CLASSES = setOf(
    "CONTEXT_OVERFLOW",
    "iteration_budget_exhausted",
    "token_budget_exhausted",
)

internal fun ChatMessage.resolveErrorClassInfo(context: Context): ChatErrorClassInfo? {
    val explicitClass = metadataString("errorClass")
        ?: metadataString("error_class")
        ?: errorClass
    val category = metadataString("errorCategory")
        ?: metadataString("error_category")
        ?: errorCategory
    val code = metadataString("errorCode")
        ?: metadataString("error_code")
        ?: errorCode
    val rawErrorClass = explicitClass
        ?: category?.let { CATEGORY_TO_ERROR_CLASS[it] }
        ?: code?.let { ERROR_CODE_TO_ERROR_CLASS[it] ?: ERROR_CODE_TO_ERROR_CLASS[it.lowercase()] }
        ?: return null
    // Wave 5 协议 Review P2：后端 runtime 原生 AgentErrorCode（TOOL_ERROR / LLM_RATE_LIMIT
    // / MAX_TURNS_EXCEEDED 等）直接塞 error_class 时，先走别名表归一到 Electron 键目，
    // 再匹配 ERROR_CLASS_CONFIG。与 iOS 相同别名表（Wave 5-iOS 同改）。
    val errorClass = ERROR_CLASS_ALIASES[rawErrorClass] ?: rawErrorClass
    val config = ERROR_CLASS_CONFIG[errorClass] ?: DEFAULT_ERROR_CLASS_CONFIG
    val defaultSuggestion = context.getString(config.suggestionRes)
    val rawSuggestedAction = metadataString("suggestedAction")
        ?: metadataString("suggested_action")
        ?: suggestedAction
    val suggestion = if (!rawSuggestedAction.isNullOrBlank() && !rawSuggestedAction.matches(Regex("^[a-z_]+$"))) {
        rawSuggestedAction
    } else {
        defaultSuggestion
    }

    // 仅保留 lower_snake_case 形态的 action 码（人类可读文本已被用作 suggestion）
    val normalizedAction = rawSuggestedAction?.takeIf { it.matches(Regex("^[a-z_]+$")) }

    // R-1 兜底：上下文超限类 error_class + action 缺失时强制补 shorten_context
    val resolvedAction = normalizedAction
        ?: if (errorClass in CONTEXT_OVERFLOW_FALLBACK_CLASSES) "shorten_context" else null

    return ChatErrorClassInfo(
        errorClass = errorClass,
        title = context.getString(config.titleRes),
        suggestion = suggestion,
        severity = config.severity,
        retryable = config.retryable,
        suggestedAction = resolvedAction,
    )
}

internal fun ChatMessage.metadataString(key: String): String? {
    val value = metadata?.get(key) ?: return null
    return value.stringValue()?.takeIf { it.isNotBlank() }
}

private fun JsonElement.stringValue(): String? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
}

/**
 * Wave 5：解析 suggestedAction 为本地化按钮标签。
 *
 * 与 Electron MessageBubble ErrorClassCard ACTION_LABELS（MessageBubble.tsx:383-387）
 * 一一对应：check_billing / relogin / shorten_context。
 * 未知 action 返回 null → 不渲染按钮（避免出现无反馈的死按钮，这是 Wave 3-iOS Y2 反思教训）。
 */
@Composable
private fun suggestedActionLabel(suggestedAction: String?): String? =
    when (suggestedAction) {
        "check_billing" -> stringResource(R.string.chat_error_action_check_billing)
        "relogin" -> stringResource(R.string.chat_error_action_relogin)
        "shorten_context" -> stringResource(R.string.chat_error_action_new_session)
        else -> null
    }

/**
 * Wave 5：ChatErrorClassCard actionable 按钮。
 *
 * 参数说明：
 * - onNavigateToWallet：check_billing 动作的 handler，来自 ConversationView 入参。
 * - onStartNewSession：shorten_context 动作的 handler。null 时按钮不渲染（避免死按钮）。
 * - onRelogin：relogin 动作的 handler。点击按钮后先弹 AlertDialog 二次确认，用户确认后
 *   才调用本 handler。null 时按钮不渲染（避免死按钮）。handler 本身应负责清理 session +
 *   跳转 Login（对齐 iOS `AuthService.shared.logout()`、Electron `ConfirmDialog → logout`）。
 *
 * 未提供 handler 的动作码降级为仅展示 title + suggestion 文本（与 Electron "suggestedAction
 * 存在但 handler 未接入"的降级行为一致）。
 */
/**
 * ：中性「已中断」徽标（对齐 Electron muted badge / iOS caption 灰字标签）。
 * 灰底小胶囊 + 灰字，不带故障感。
 */
@Composable
internal fun InterruptedBadge(
    modifier: Modifier = Modifier,
) {
    Text(
        text = stringResource(R.string.chat_message_interrupted),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        modifier = modifier
            .background(
                ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                RoundedCornerShape(TTRadius.sm),
            )
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xxs),
    )
}

@Composable
internal fun ChatErrorClassCard(
    info: ChatErrorClassInfo,
    onNavigateToWallet: (() -> Unit)? = null,
    onStartNewSession: (() -> Unit)? = null,
    onRelogin: (() -> Unit)? = null,
) {
    // ：ABORT / NEUTRAL 不渲染错误卡，只出中性徽标（对齐 iOS AssistantErrorCard）。
    if (info.severity == ChatErrorSeverity.NEUTRAL || info.errorClass == "ABORT") {
        InterruptedBadge()
        return
    }

    val isWarning = info.severity == ChatErrorSeverity.WARNING
    val bg = if (isWarning) {
        ttColor(Color(0xFFFFFBEB), Color(0xFF3A3420))
    } else {
        ttColor(Color(0xFFFEF2F2), Color(0xFF3A2020))
    }
    val border = if (isWarning) {
        ttColor(Color(0xFFFDE68A), Color(0xFF5C5030))
    } else {
        ttColor(Color(0xFFFECACA), Color(0xFF5C3030))
    }
    val iconTint = if (isWarning) {
        ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    } else {
        ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    }

    // Wave 5 用户视角 Review：relogin 走 AlertDialog 二次确认。直接点击就登出会丢失当前
    // 对话未发送的 composer 内容（与 Electron ConfirmDialog / iOS alert 对齐）。
    var showReloginConfirm by remember { mutableStateOf(false) }

    val actionLabel = suggestedActionLabel(info.suggestedAction)
    val actionHandler: (() -> Unit)? = when (info.suggestedAction) {
        "check_billing" -> onNavigateToWallet
        "shorten_context" -> onStartNewSession
        // relogin：这里返回"显示确认框"，真正的 logout 走 onRelogin（AlertDialog 确认后触发）
        "relogin" -> if (onRelogin != null) {
            { showReloginConfirm = true }
        } else null
        else -> null
    }
    val canShowAction = actionLabel != null && actionHandler != null

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, border, RoundedCornerShape(12.dp))
            .background(bg, RoundedCornerShape(12.dp))
            .padding(TTSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(
                imageVector = if (isWarning) Icons.Outlined.Info else Icons.Outlined.ErrorOutline,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = iconTint,
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = info.title,
                    style = TTFonts.bodySemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
                Text(
                    text = info.suggestion,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier.padding(top = TTSpacing.xxs),
                )
                if (canShowAction) {
                    Spacer(Modifier.height(TTSpacing.sm))
                    // 与 Electron ErrorClassCard 视觉风格一致：次要按钮（透明背景 + 彩色边框 + 彩色文字）
                    androidx.compose.material3.OutlinedButton(
                        onClick = actionHandler,
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, iconTint.copy(alpha = 0.4f)),
                        colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                            contentColor = iconTint,
                        ),
                    ) {
                        Text(
                            text = actionLabel,
                            style = TTFonts.caption,
                        )
                    }
                }
            }
        }
    }

    if (showReloginConfirm && onRelogin != null) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showReloginConfirm = false },
            title = { Text(stringResource(R.string.chat_error_relogin_confirm_title)) },
            text = { Text(stringResource(R.string.chat_error_relogin_confirm_message)) },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = {
                        showReloginConfirm = false
                        onRelogin()
                    },
                ) {
                    Text(
                        text = stringResource(R.string.chat_error_action_relogin),
                        color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    )
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(
                    onClick = { showReloginConfirm = false },
                ) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}
