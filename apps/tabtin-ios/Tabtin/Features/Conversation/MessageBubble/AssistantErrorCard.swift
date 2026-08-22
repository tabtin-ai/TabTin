import SwiftUI
import UIKit
@preconcurrency import MarkdownUI

// MARK: - Assistant error

enum ChatErrorAction: Equatable, Sendable {
    case retry
    case switchModel
    case recharge
    case relogin
    case newConversation
}

struct ChatErrorPresentation: Equatable {
    enum Severity { case neutral, warning, error }

    private struct Config {
        let zhTitle: String
        let enTitle: String
        let zhSuggestion: String
        let enSuggestion: String
        let severity: Severity
        let retryable: Bool

        init(
            zhTitle: String,
            enTitle: String,
            zhSuggestion: String,
            enSuggestion: String,
            severity: Severity,
            retryable: Bool = true
        ) {
            self.zhTitle = zhTitle
            self.enTitle = enTitle
            self.zhSuggestion = zhSuggestion
            self.enSuggestion = enSuggestion
            self.severity = severity
            self.retryable = retryable
        }
    }

    let title: String
    let suggestion: String
    let severity: Severity
    let action: ChatErrorAction?
    let actionTitle: String?

    static func shouldPresent(message: ChatMessage) -> Bool {
        if [
            message.errorMessage,
            message.errorClass,
            message.errorCategory,
            message.errorCode,
            message.suggestedAction,
        ].contains(where: { trimmed($0) != nil }) {
            return true
        }
        return isAbortSignal(message.stopReason)
    }

    static func isNeutralInterruption(message: ChatMessage) -> Bool {
        shouldPresent(message: message)
            && resolve(message: message, fallbackMessage: message.errorMessage ?? "").severity == .neutral
    }

    static func isRuntimeAbortDiagnostic(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value == "run aborted by user."
            || value == "run aborted by user"
            || value == "conversation aborted"
            || value == "aborted"
            || value == "cancelled"
            || value == "canceled"
            || value == "对话已中止"
    }

    static func resolve(message: ChatMessage, fallbackMessage: String) -> ChatErrorPresentation {
        let rawSuggestedAction = message.suggestedAction?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawErrorClass = trimmed(message.errorClass)
            ?? errorClass(forCategory: message.errorCategory)
            ?? errorClass(forCode: message.errorCode)
            ?? heuristicErrorClass(message: message, fallbackMessage: fallbackMessage)
        let errorClass = normalizedErrorClass(rawErrorClass)
        let config = configs[errorClass] ?? defaultConfig

        let normalizedAction = rawSuggestedAction.flatMap {
            isSnakeCaseAction($0) && action(for: $0) != nil ? $0 : nil
        }
        let actionCode = resolveActionCode(
            errorClass: errorClass,
            normalizedAction: normalizedAction,
            config: config
        )

        return .init(
            title: localized(zh: config.zhTitle, en: config.enTitle),
            suggestion: suggestion(
                fallbackMessage: fallbackMessage,
                rawSuggestedAction: rawSuggestedAction,
                config: config,
                usesDefaultConfig: configs[errorClass] == nil
            ),
            severity: config.severity,
            action: action(for: actionCode),
            actionTitle: actionTitle(for: actionCode)
        )
    }

    private static func resolveActionCode(
        errorClass: String,
        normalizedAction: String?,
        config: Config
    ) -> String? {
        if errorClass == "ABORT" {
            return nil
        }
        if errorClass == "MAX_CREDITS_EXCEEDED" {
            // 运行级用量墙不是钱包余额不足；与 Electron 一致，允许用户调整限制后重试。
            return "retry_later"
        }
        if let normalizedAction {
            return normalizedAction
        }
        if contextOverflowFallbackActions.contains(errorClass) {
            return "shorten_context"
        }
        switch errorClass {
        case "BUDGET_EXHAUSTED":
            return "check_billing"
        case "AUTH_REQUIRED":
            return "relogin"
        case "LLM_CAPABILITY_GATE":
            return "switch_model"
        default:
            return config.retryable ? "retry_later" : nil
        }
    }

    private static let configs: [String: Config] = [
        "LLM_PROVIDER_ERROR": .init(
            zhTitle: "模型服务暂时不可用",
            enTitle: "Model service temporarily unavailable",
            zhSuggestion: "请稍后重试，如果持续出现可尝试切换模型",
            enSuggestion: "Please try again later, or try switching to a different model",
            severity: .error
        ),
        "LLM_ERROR": .init(
            zhTitle: "对话中断",
            enTitle: "Conversation interrupted",
            zhSuggestion: "刚才的回复被中断了。可以稍等片刻再重试，或检查网络后重新发送。",
            enSuggestion: "The previous reply was interrupted. Please wait a moment and retry, or check your network and resend.",
            severity: .warning
        ),
        "CONTEXT_OVERFLOW": .init(
            zhTitle: "对话内容过长",
            enTitle: "Conversation too long",
            zhSuggestion: "请开始新对话继续",
            enSuggestion: "Please start a new conversation to continue",
            severity: .error,
            retryable: false
        ),
        "TOOL_EXECUTION_ERROR": .init(
            zhTitle: "工具执行出错",
            enTitle: "Tool execution error",
            zhSuggestion: "请重试，或换一种方式描述你的需求",
            enSuggestion: "Please try again, or describe your request differently",
            severity: .error
        ),
        "iteration_budget_exhausted": .init(
            zhTitle: "任务已完成（达到执行上限）",
            enTitle: "Task completed (execution limit reached)",
            zhSuggestion: "Agent 已尽力完成工作，如需继续请开始新对话",
            enSuggestion: "The agent has done its best. Start a new conversation to continue",
            severity: .warning,
            retryable: false
        ),
        "token_budget_exhausted": .init(
            zhTitle: "对话用量已达上限",
            enTitle: "Conversation usage limit reached",
            zhSuggestion: "本次对话的用量已到限制，请开始新对话",
            enSuggestion: "This conversation has reached its usage limit. Please start a new one",
            severity: .warning,
            retryable: false
        ),
        "BUDGET_EXHAUSTED": .init(
            zhTitle: "配额已用完",
            enTitle: "Quota exhausted",
            zhSuggestion: "当前账户的 AI 使用额度已耗尽，请联系管理员",
            enSuggestion: "Your account's AI usage quota is exhausted. Please contact your admin",
            severity: .error,
            retryable: false
        ),
        "MAX_CREDITS_EXCEEDED": .init(
            zhTitle: "本次运行已达用量上限",
            enTitle: "This run reached its usage limit",
            zhSuggestion: "调整执行限制后，可以重试同一条指令",
            enSuggestion: "Adjust the run limit, then retry the same prompt",
            severity: .warning
        ),
        "RATE_LIMITED": .init(
            zhTitle: "请求过于频繁",
            enTitle: "Too many requests",
            zhSuggestion: "请稍等片刻后重试",
            enSuggestion: "Please wait a moment and try again",
            severity: .warning
        ),
        "INTERNAL": .init(
            zhTitle: "内部错误",
            enTitle: "Internal error",
            zhSuggestion: "系统遇到意外问题，请重试",
            enSuggestion: "The system encountered an unexpected issue. Please try again",
            severity: .error
        ),
        "AGENT_RUNTIME_UNREACHABLE": .init(
            zhTitle: "桌面 Agent 未接收任务",
            enTitle: "Desktop Agent did not receive the task",
            zhSuggestion: "请确认对应桌面端在线，并稍后重新发送",
            enSuggestion: "Make sure the desktop app is online, then resend the message",
            severity: .warning
        ),
        "LLM_KEY_EXHAUSTED": .init(
            zhTitle: "当前渠道暂时不可用",
            enTitle: "Current channel temporarily unavailable",
            zhSuggestion: "服务暂时中断，请稍后重试或联系管理员",
            enSuggestion: "Service is temporarily interrupted. Please try again later or contact your admin",
            severity: .error,
            retryable: false
        ),
        "AUTH_REQUIRED": .init(
            zhTitle: "登录状态已过期",
            enTitle: "Session expired",
            zhSuggestion: "请重新登录后继续",
            enSuggestion: "Please sign in again to continue",
            severity: .warning,
            retryable: false
        ),
        "LLM_CAPABILITY_GATE": .init(
            zhTitle: "当前模型不支持这项内容",
            enTitle: "The current model cannot handle this content",
            zhSuggestion: "请选择支持所需能力的模型后再试",
            enSuggestion: "Choose a model that supports this content, then try again",
            severity: .error,
            retryable: false
        ),
        "BYOK_PROVIDER_UNAVAILABLE": .init(
            zhTitle: "自备 Key 的 Provider 暂时无法访问",
            enTitle: "BYOK Provider Temporarily Unavailable",
            zhSuggestion: "您组织配置的 BYOK 渠道调用上游服务时返回 503/超时。这通常是上游服务商临时故障，过几分钟会自动恢复。",
            enSuggestion: "Your team's BYOK channel returned 503/timeout from upstream. Usually this is an upstream outage that auto-recovers in a few minutes.",
            severity: .error
        ),
        "BYOK_RATE_LIMIT_EXCEEDED": .init(
            zhTitle: "自备 Key 触发了上游限速",
            enTitle: "BYOK Rate Limit Hit",
            zhSuggestion: "BYOK 渠道的 API Key 触发了上游的 RPM/TPM 限制。请等几分钟再试，或在组织设置中启用更多 Key 轮询。",
            enSuggestion: "Your team's BYOK channel's API Key hit upstream RPM/TPM limits. Wait a few minutes or add more keys for rotation.",
            severity: .warning
        ),
        "BYOK_QUOTA_EXHAUSTED": .init(
            zhTitle: "自备 Key 的账号余额耗尽",
            enTitle: "BYOK Account Out of Funds",
            zhSuggestion: "BYOK 渠道的 API Key 在上游服务商的账号余额已耗尽，需要您前往上游服务商充值。",
            enSuggestion: "Your team's BYOK channel's API Key has exhausted its quota at upstream. Top up at the upstream provider.",
            severity: .error,
            retryable: false
        ),
        "BYOK_INVALID_KEY": .init(
            zhTitle: "自备 Key 已失效",
            enTitle: "BYOK API Key Invalid",
            zhSuggestion: "BYOK 渠道的 API Key 上游返回 401 invalid_api_key，可能已被吊销或填写错误。请到组织设置中替换该 Key。",
            enSuggestion: "Your team's BYOK channel's API Key returned 401 invalid_api_key from upstream. May be revoked or misentered. Replace it in Team Settings.",
            severity: .error,
            retryable: false
        ),
        "ABORT": .init(
            zhTitle: "已中断",
            enTitle: "Interrupted",
            zhSuggestion: "",
            enSuggestion: "",
            severity: .neutral,
            retryable: false
        ),
        "text_loop_terminated": .init(
            zhTitle: "已自动停止",
            enTitle: "Stopped automatically",
            zhSuggestion: "检测到回复内容反复重复。可以重试，或换种说法继续。",
            enSuggestion: "The response started repeating. Retry or rephrase your request.",
            severity: .warning
        ),
        "tool_loop_terminated": .init(
            zhTitle: "已自动停止",
            enTitle: "Stopped automatically",
            zhSuggestion: "同一工具反复失败或重复执行。可以重试，或调整指令。",
            enSuggestion: "A tool repeatedly failed or ran in a loop. Retry or adjust your request.",
            severity: .warning
        ),
    ]

    private static let defaultConfig = Config(
        zhTitle: "出了点问题",
        enTitle: "Something went wrong",
        zhSuggestion: "请重试，如果持续出现请反馈给我们",
        enSuggestion: "Please try again. If the issue persists, let us know",
        severity: .error
    )

    private static let categoryToErrorClass: [String: String] = [
        "llm_provider_error": "LLM_PROVIDER_ERROR",
        "context_overflow": "CONTEXT_OVERFLOW",
        "tool_exec": "TOOL_EXECUTION_ERROR",
        "billing": "BUDGET_EXHAUSTED",
        "quota": "BUDGET_EXHAUSTED",
        "rate_limited": "RATE_LIMITED",
        "aborted": "ABORT",
        "auth": "AUTH_REQUIRED",
        "unauthorized": "AUTH_REQUIRED",
        "persist_error": "INTERNAL",
        "internal_error": "INTERNAL",
        "route_failed": "AGENT_RUNTIME_UNREACHABLE",
        "device_offline": "AGENT_RUNTIME_UNREACHABLE",
        "device_busy": "AGENT_RUNTIME_UNREACHABLE",
        "device_unreachable": "AGENT_RUNTIME_UNREACHABLE",
        "device_dropped": "AGENT_RUNTIME_UNREACHABLE",
        "runtime_failed": "AGENT_RUNTIME_UNREACHABLE",
        "configuration_error": "INTERNAL",
        "byok_provider_unavailable": "BYOK_PROVIDER_UNAVAILABLE",
        "byok_rate_limit_exceeded": "BYOK_RATE_LIMIT_EXCEEDED",
        "byok_quota_exhausted": "BYOK_QUOTA_EXHAUSTED",
        "byok_invalid_key": "BYOK_INVALID_KEY",
        "member_daily_limit": "BUDGET_EXHAUSTED",
        "member_monthly_limit": "BUDGET_EXHAUSTED",
        "member_budget": "BUDGET_EXHAUSTED",
        "member_model_restricted": "LLM_CAPABILITY_GATE",
    ]

    private static let codeToErrorClass: [String: String] = [
        "context_overflow": "CONTEXT_OVERFLOW",
        "tool_exec": "TOOL_EXECUTION_ERROR",
        "tool_timeout": "TOOL_EXECUTION_ERROR",
        "llm_call": "LLM_PROVIDER_ERROR",
        "llm_provider_error": "LLM_PROVIDER_ERROR",
        "llm_timeout": "LLM_ERROR",
        "rate_limited": "RATE_LIMITED",
        "budget_exceeded": "BUDGET_EXHAUSTED",
        "insufficient_credits": "BUDGET_EXHAUSTED",
        "organization_insufficient_credits": "BUDGET_EXHAUSTED",
        "conversation_quota_exceeded": "BUDGET_EXHAUSTED",
        "member_daily_limit": "BUDGET_EXHAUSTED",
        "member_monthly_limit": "BUDGET_EXHAUSTED",
        "member_budget": "BUDGET_EXHAUSTED",
        "member_model_restricted": "LLM_CAPABILITY_GATE",
        "token_budget_exhausted": "token_budget_exhausted",
        "iteration_budget_exhausted": "iteration_budget_exhausted",
        "max_credits_exceeded": "MAX_CREDITS_EXCEEDED",
        "text_loop_terminated": "text_loop_terminated",
        "tool_loop_terminated": "tool_loop_terminated",
        "cancelled": "ABORT",
        "aborted": "ABORT",
        "internal_error": "INTERNAL",
        "unknown_error": "INTERNAL",
        "device_offline": "AGENT_RUNTIME_UNREACHABLE",
        "device_busy": "AGENT_RUNTIME_UNREACHABLE",
        "device_unreachable": "AGENT_RUNTIME_UNREACHABLE",
        "device_dropped": "AGENT_RUNTIME_UNREACHABLE",
        "runtime_failed": "AGENT_RUNTIME_UNREACHABLE",
        "route_failed": "AGENT_RUNTIME_UNREACHABLE",
        "route_none": "AGENT_RUNTIME_UNREACHABLE",
        "persist_error": "INTERNAL",
        "auth_required": "AUTH_REQUIRED",
        "unauthorized": "AUTH_REQUIRED",
        "permission_denied": "TOOL_EXECUTION_ERROR",
        "process_timeout": "LLM_ERROR",
    ]

    private static let errorClassAliases: [String: String] = [
        "TOOL_ERROR": "TOOL_EXECUTION_ERROR",
        "TOOL_TIMEOUT": "TOOL_EXECUTION_ERROR",
        "LLM_RATE_LIMIT": "RATE_LIMITED",
        "LLM_BILLING_ERROR": "BUDGET_EXHAUSTED",
        "MAX_CREDITS_EXCEEDED": "MAX_CREDITS_EXCEEDED",
        "MAX_TURNS_EXCEEDED": "iteration_budget_exhausted",
        "DOOM_LOOP_DETECTED": "iteration_budget_exhausted",
        "PERMISSION_DENIED": "TOOL_EXECUTION_ERROR",
        "PERMISSION_TIMEOUT": "TOOL_EXECUTION_ERROR",
        "CAP_NOT_BOUND": "INTERNAL",
    ]

    private static let contextOverflowFallbackActions: Set<String> = [
        "CONTEXT_OVERFLOW",
        "token_budget_exhausted",
        "iteration_budget_exhausted",
    ]

    private static func errorClass(forCategory category: String?) -> String? {
        trimmed(category).flatMap { categoryToErrorClass[$0.lowercased()] }
    }

    private static func errorClass(forCode code: String?) -> String? {
        trimmed(code).flatMap { codeToErrorClass[$0.lowercased()] }
    }

    private static func normalizedErrorClass(_ raw: String?) -> String {
        guard let raw = trimmed(raw) else { return "INTERNAL" }
        if let alias = errorClassAliases[raw] ?? errorClassAliases[raw.uppercased()] {
            return alias
        }
        if configs[raw] != nil { return raw }
        let upper = raw.uppercased()
        if configs[upper] != nil { return upper }
        return raw
    }

    private static func heuristicErrorClass(message: ChatMessage, fallbackMessage: String) -> String? {
        let raw = [message.errorCode, message.errorCategory, message.stopReason, fallbackMessage]
            .compactMap { $0?.lowercased() }
            .joined(separator: " ")
        if raw.contains("auth") || raw.contains("unauthorized") || raw.contains("relogin") {
            return "AUTH_REQUIRED"
        }
        if raw.contains("abort") || raw.contains("cancel") { return "ABORT" }
        if raw.contains("context_overflow") { return "CONTEXT_OVERFLOW" }
        if raw.contains("token_budget_exhausted") { return "token_budget_exhausted" }
        if raw.contains("iteration_budget_exhausted") { return "iteration_budget_exhausted" }
        if raw.contains("max_credits_exceeded") { return "MAX_CREDITS_EXCEEDED" }
        if raw.contains("text_loop_terminated") { return "text_loop_terminated" }
        if raw.contains("tool_loop_terminated") { return "tool_loop_terminated" }
        if raw.contains("billing") || raw.contains("quota") || raw.contains("credit") || raw.contains("budget") || raw.contains("member_") {
            return "BUDGET_EXHAUSTED"
        }
        if raw.contains("rate_limited") || raw.contains("rate limit") { return "RATE_LIMITED" }
        if raw.contains("device_") || raw.contains("route_failed") || raw.contains("runtime_failed") {
            return "AGENT_RUNTIME_UNREACHABLE"
        }
        if raw.contains("tool") { return "TOOL_EXECUTION_ERROR" }
        return nil
    }

    private static func suggestion(
        fallbackMessage: String,
        rawSuggestedAction: String?,
        config: Config,
        usesDefaultConfig: Bool
    ) -> String {
        if let rawSuggestedAction, !rawSuggestedAction.isEmpty, !isSnakeCaseAction(rawSuggestedAction) {
            return rawSuggestedAction
        }
        if usesDefaultConfig, !fallbackMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fallbackMessage
        }
        return localized(zh: config.zhSuggestion, en: config.enSuggestion)
    }

    private static func action(for actionCode: String?) -> ChatErrorAction? {
        switch actionCode {
        case "retry", "retry_later": return .retry
        case "switch_model": return .switchModel
        case "check_billing": return .recharge
        case "relogin": return .relogin
        case "shorten_context", "new_conversation", "new_task": return .newConversation
        default: return nil
        }
    }

    private static func actionTitle(for actionCode: String?) -> String? {
        switch actionCode {
        case "retry", "retry_later": return L10n.Common.retry
        case "switch_model": return L10n.ErrorRecovery.switchModel
        case "check_billing": return L10n.ErrorRecovery.topUp
        case "relogin": return L10n.ErrorRecovery.relogin
        case "shorten_context", "new_conversation", "new_task":
            return L10n.ErrorRecovery.newTask
        default: return nil
        }
    }

    private static func isAbortSignal(_ value: String?) -> Bool {
        guard let value = trimmed(value)?.lowercased() else { return false }
        return value.contains("abort") || value.contains("cancel")
    }

    private static func isSnakeCaseAction(_ value: String) -> Bool {
        value.range(of: #"^[a-z_]+$"#, options: .regularExpression) != nil
    }

    private static func localized(zh: String, en: String) -> String {
        LanguageManager.shared.effectiveLocale.identifier.lowercased().hasPrefix("zh") ? zh : en
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

/// 助手错误卡：按错误类型给用户明确下一步，覆盖 billing / relogin / shorten_context 等旧版成熟路径。
struct AssistantErrorCard: View {
    let message: ChatMessage
    let fallbackMessage: String
    var onAction: (ChatErrorAction) -> Void

    private var presentation: ChatErrorPresentation {
        ChatErrorPresentation.resolve(message: message, fallbackMessage: fallbackMessage)
    }

    private var tintColor: Color {
        switch presentation.severity {
        case .neutral:
            return .tt.textSecondary
        case .warning:
            return .tt.textWarning
        case .error:
            return .tt.textCritical
        }
    }

    private var icon: String {
        switch presentation.severity {
        case .neutral:
            return "stop.circle"
        case .warning:
            return "exclamationmark.triangle.fill"
        case .error:
            return "exclamationmark.circle.fill"
        }
    }

    @ViewBuilder
    var body: some View {
        if presentation.severity == .neutral {
            Label(presentation.title, systemImage: icon)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .padding(.vertical, TTSpacing.xxs)
                .accessibilityElement(children: .combine)
        } else {
            errorCard
        }
    }

    private var errorCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: icon)
                    .font(.tt.iconCaption)
                    .foregroundStyle(tintColor)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(presentation.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(tintColor)
                    Text(presentation.suggestion)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .copyOnLongPress(presentation.suggestion)
                }
            }

            if let action = presentation.action, let title = presentation.actionTitle {
                Button {
                    onAction(action)
                } label: {
                    Label(title, systemImage: action.symbolName)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(tintColor)
                        .padding(.horizontal, TTSpacing.md)
                        .frame(minHeight: 44)
                        .background(
                            RoundedRectangle(cornerRadius: TTRadius.sm)
                                .strokeBorder(tintColor.opacity(0.3), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .padding(.leading, 24)
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .fill(tintColor.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: TTRadius.md)
                        .strokeBorder(tintColor.opacity(0.24), lineWidth: 1)
                )
        )
    }
}

private extension ChatErrorAction {
    var symbolName: String {
        switch self {
        case .retry:
            return "arrow.clockwise"
        case .switchModel:
            return "cpu"
        case .recharge:
            return "creditcard"
        case .relogin:
            return "person.crop.circle.badge.exclamationmark"
        case .newConversation:
            return "plus.bubble"
        }
    }
}
