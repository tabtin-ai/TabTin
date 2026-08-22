import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Billing

struct BillingBlockedBanner: View {
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "creditcard.trianglebadge.exclamationmark")
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.textCritical)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(message)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(.tt.bgCritical.opacity(0.1))
    }
}

struct BillingToast: Identifiable, Equatable {
    let id = UUID()
    let message: String
    let isDestructive: Bool
}

private struct MemberUsageResponse: Decodable {
    let monthlyUsed: String?
    let monthlyLimit: String?
    let dailyUsed: String?
    let dailyLimit: String?
    let policySource: String?

    enum CodingKeys: String, CodingKey {
        case monthlyUsed = "monthly_used"
        case monthlyLimit = "monthly_limit"
        case dailyUsed = "daily_used"
        case dailyLimit = "daily_limit"
        case policySource = "policy_source"
    }
}

enum BillingEvents {
    static let balanceLow = "billing.balance_low"
    static let billingBlocked = "billing.billing_blocked"
    static let billingUnblocked = "billing.billing_unblocked"
    static let quotaExhausted = "billing.quota_exhausted"
    static let creditsRecharged = "billing.credits_recharged"
    static let membershipActivated = "billing.membership_activated"
    static let budgetWarning = "billing.budget_warning"
    static let budgetCritical = "billing.budget_critical"
    static let budgetResolved = "billing.budget_resolved"
    static let degradationAlert = "billing.degradation_alert"
    static let invoiceRefunded = "billing.invoice_refunded"
    static let membershipExpiring = "billing.membership_expiring"
    static let membershipExpired = "billing.membership_expired"
    static let autoRenewFailed = "billing.auto_renew_failed"
    static let membershipDowngradedOverlimit = "billing.membership_downgraded_overlimit"
    static let membershipRenewalCancelled = "billing.membership_renewal_cancelled"
    static let usageAggregated = "billing.usage_aggregated"
    static let invoiceCollectionSucceeded = "billing.invoice_collection_succeeded"
    static let invoiceCollectionFailed = "billing.invoice_collection_failed"
    static let platformRefundCompleted = "billing.platform_refund_completed"
    static let platformRefundFailed = "billing.platform_refund_failed"
    static let refundPartialFailure = "billing.refund_partial_failure"
    static let memberBudgetWarning = "billing.member_budget_warning"
    static let memberBudgetExhausted = "billing.member_budget_exhausted"
    static let memberBudgetResolved = "billing.member_budget_resolved"
    static let memberBudgetPolicyChanged = "billing.member_budget_policy_changed"
    static let storageWarning = "billing.storage_warning"
    static let storageCritical = "billing.storage_critical"
    static let storageResolved = "billing.storage_resolved"
    static let storagePackageExpiring = "billing.storage_package_expiring"
    static let storageAutoRenewFailed = "billing.storage_auto_renew_failed"

    static let topicPrefix = "billing.events"

    static func topicForOrganization(_ organizationId: String) -> String {
        "\(topicPrefix).\(organizationId)"
    }

    static let refreshEvents: Set<String> = [
        balanceLow, billingBlocked, billingUnblocked, quotaExhausted, creditsRecharged,
        membershipActivated, budgetWarning, budgetCritical, budgetResolved,
        degradationAlert, invoiceRefunded, membershipExpiring, membershipExpired,
        autoRenewFailed, membershipDowngradedOverlimit, membershipRenewalCancelled,
        usageAggregated, invoiceCollectionSucceeded, invoiceCollectionFailed,
        platformRefundCompleted, platformRefundFailed, refundPartialFailure,
        memberBudgetWarning, memberBudgetExhausted, memberBudgetResolved,
        memberBudgetPolicyChanged, storageWarning, storageCritical, storageResolved,
        storagePackageExpiring, storageAutoRenewFailed,
    ]
}

/// 服务端的 `billing.billing_blocked` 同时承载单次请求资金不足与组织级计费保护。
/// 单次请求不足由该会话里的错误卡片说明；只有组织 Guard 才应锁住 Composer。
enum BillingBlockClassification {
    static func isOrganizationGuard(
        blockType: String?,
        reason: String?,
        code: String?,
        errorCode: String?
    ) -> Bool {
        switch blockType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "request_insufficient_credits": return false
        case "organization_billing_guard": return true
        default: break
        }

        // 兼容尚未发送 block_type 的旧事件：明确的单次请求资金不足码仅影响当前发送；
        // `chat.send_message.nak` 只暴露 billing_precheck_failed 时也不能升级成组织级锁定。
        // 其余未知事件保守维持组织 Guard，不能弱化真实的组织保护。
        let legacyCode = (errorCode ?? code ?? reason ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        return ![
            "ORGANIZATION_INSUFFICIENT_CREDITS",
            "BILLING_WALLET_INSUFFICIENT",
            "INSUFFICIENT_CREDITS",
            "BILLING_PRECHECK_FAILED",
        ].contains(legacyCode)
    }

    static func isOrganizationGuard(_ envelope: WSEnvelope) -> Bool {
        isOrganizationGuard(
            blockType: envelope.payloadString("block_type"),
            reason: envelope.payloadString("reason"),
            code: envelope.payloadString("code"),
            errorCode: envelope.payloadString("error_code")
        )
    }
}

@MainActor @Observable
final class BillingEventHandler {
    static let shared = BillingEventHandler()
    static let refreshNotification = Notification.Name("com.tabtin.billing.refreshRequired")

    private(set) var activeToast: BillingToast?
    private(set) var billingBlocked = false
    private(set) var memberLimitReached = false
    private(set) var memberLimitReason: String?

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "BillingEventHandler")
    private let listenerKey = "billing-events-global"
    private var isStarted = false
    private var lastRechargedAt: Date = .distantPast
    private var toastDismissTask: Task<Void, Never>?

    private init() {}

    func start() {
        guard !isStarted else {
            subscribeCurrentOrganization()
            return
        }
        isStarted = true
        RealtimeGateway.shared.addEnvelopeListener(key: listenerKey) { [weak self] envelope in
            self?.handleEnvelope(envelope)
        }
        subscribeCurrentOrganization()
        logger.info("Billing event handler registered")
    }

    func stop() {
        guard isStarted else { return }
        isStarted = false
        RealtimeGateway.shared.removeEnvelopeListener(key: listenerKey)
        toastDismissTask?.cancel()
        activeToast = nil
        billingBlocked = false
        memberLimitReached = false
        memberLimitReason = nil
        logger.info("Billing event handler unregistered")
    }

    func subscribeCurrentOrganization() {
        guard let organizationId = WorkspaceStore.shared.selectedOrganizationId else { return }
        RealtimeGateway.shared.subscribe([BillingEvents.topicForOrganization(organizationId)])
    }

    func handleEnvelope(_ envelope: WSEnvelope) {
        guard envelope.type.hasPrefix("billing.") else { return }

        if BillingEvents.refreshEvents.contains(envelope.type) {
            NotificationCenter.default.post(name: Self.refreshNotification, object: nil)
        }

        switch envelope.type {
        case BillingEvents.balanceLow:
            showToast(
                envelope.payloadString("message")
                    ?? buildBalanceLowMessage(balance: envelope.payloadDisplayString("current_balance"),
                                              threshold: envelope.payloadDisplayString("threshold")),
                destructive: true
            )

        case BillingEvents.billingBlocked:
            // 请求级余额不足已由当前会话的错误卡承载，不锁住组织，也不重复弹全局 toast。
            guard BillingBlockClassification.isOrganizationGuard(envelope) else { return }
            let wasBlocked = billingBlocked
            billingBlocked = true
            if !wasBlocked {
                showToast(
                    envelope.payloadString("reason")
                        ?? envelope.payloadString("message")
                        ?? "当前组织余额或额度不足，请处理后重试。",
                    destructive: true
                )
            }

        case BillingEvents.billingUnblocked:
            billingBlocked = false
            let isRechargeTriggered = Date().timeIntervalSince(lastRechargedAt) < 2
            if !isRechargeTriggered {
                showToast("计费限制已解除", destructive: false)
            }

        case BillingEvents.quotaExhausted:
            // DATA_REFRESH_EVENTS 已刷新额度展示；正常资金路由不应打断当前对话。
            break

        case BillingEvents.creditsRecharged:
            billingBlocked = false
            lastRechargedAt = Date()
            showToast("充值已到账", destructive: false)

        case BillingEvents.membershipActivated:
            showToast("组织套餐已生效", destructive: false)

        case BillingEvents.budgetWarning:
            showToast(envelope.payloadString("message") ?? buildBudgetMessage(title: "组织预算即将用完", envelope), destructive: true)

        case BillingEvents.budgetCritical:
            showToast(envelope.payloadString("message") ?? buildBudgetMessage(title: "组织预算已接近上限", envelope), destructive: true)

        case BillingEvents.budgetResolved:
            showToast("组织预算限制已恢复", destructive: false)

        case BillingEvents.membershipExpiring:
            if let days = envelope.payloadInt("days_left") {
                showToast("组织套餐将在 \(days) 天后到期", destructive: true)
            } else {
                showToast("组织套餐即将到期", destructive: true)
            }

        case BillingEvents.membershipExpired:
            showToast("组织套餐已到期，请续费后继续使用", destructive: true)

        case BillingEvents.autoRenewFailed:
            let reason = envelope.payloadString("reason")
            let message = reason == "insufficient_balance"
                ? "自动续费失败：余额不足，请充值后重试"
                : "自动续费失败，请检查支付方式或联系管理员"
            showToast(message, destructive: true)

        case BillingEvents.membershipDowngradedOverlimit:
            let count = envelope.payloadInt("exceeded_count") ?? 0
            let suffix = count > 0 ? "，\(count) 项资源或成员超出新套餐限制" : ""
            showToast("组织套餐已变更\(suffix)", destructive: true)

        case BillingEvents.invoiceRefunded:
            showToast("账单退款已完成", destructive: false)

        case BillingEvents.membershipRenewalCancelled:
            showToast("组织套餐自动续费已取消", destructive: true)

        case BillingEvents.degradationAlert:
            let meterKey = envelope.payloadString("meter_key") ?? "unknown"
            showToast("用量计量出现异常：\(meterKey)，请稍后查看账单", destructive: true)

        case BillingEvents.memberBudgetWarning:
            guard eventBelongsToCurrentUser(envelope) else { return }
            let budgetType = envelope.payloadString("budget_type")
            let pct = envelope.payloadDouble("usage_percent").map { Int($0.rounded()) } ?? 80
            let desc = budgetType == "daily"
                ? "你的今日成员额度已使用 \(pct)%"
                : "你的成员额度已使用 \(pct)%"
            showToast(envelope.payloadString("message") ?? "成员额度提醒\n\(desc)", destructive: true)

        case BillingEvents.memberBudgetExhausted:
            guard eventBelongsToCurrentUser(envelope) else { return }
            // 硬阻断只设 flag：会话内 `BillingBlockedBanner`（billingBannerInfo 里
            // memberLimitReached 分支）+ Composer 禁用已拥有这个事实，不再叠 Toast。
            let budgetType = envelope.payloadString("budget_type")
            memberLimitReached = true
            memberLimitReason = budgetType == "daily" ? "member_daily_limit" : "member_monthly_limit"

        case BillingEvents.memberBudgetResolved:
            let scope = envelope.payloadString("scope")
            if scope == "personal" || scope == nil {
                guard eventBelongsToCurrentUser(envelope) else { return }
                memberLimitReached = false
                memberLimitReason = nil
                showToast("成员额度已恢复", destructive: false)
            } else if let organizationId = WorkspaceStore.shared.selectedOrganizationId {
                Task { await recheckMemberUsage(organizationId: organizationId) }
            }

        case BillingEvents.invoiceCollectionSucceeded:
            showToast("账单回款已完成", destructive: false)

        case BillingEvents.invoiceCollectionFailed:
            showToast("账单回款失败，请稍后重试或联系管理员", destructive: true)

        case BillingEvents.platformRefundCompleted:
            showToast("平台退款已完成", destructive: false)

        case BillingEvents.platformRefundFailed:
            showToast("平台退款失败，请稍后重试或联系管理员", destructive: true)

        case BillingEvents.refundPartialFailure:
            showToast("部分退款未完成，请查看账单或联系管理员", destructive: true)

        case BillingEvents.storageWarning, BillingEvents.storageCritical:
            let fallback: String
            if envelope.type == BillingEvents.storageCritical {
                let pct = envelope.payloadDisplayString("usage_percent") ?? "95"
                fallback = "存储用量已达到 \(pct)%，部分能力可能受限"
            } else {
                let pct = envelope.payloadDisplayString("usage_percent") ?? "90"
                fallback = "存储用量已达到 \(pct)%，请关注剩余额度"
            }
            showToast(envelope.payloadString("message") ?? fallback, destructive: true)

        case BillingEvents.storageResolved:
            showToast("组织存储额度已恢复", destructive: false)

        case BillingEvents.storagePackageExpiring:
            let days = envelope.payloadDisplayString("days_remaining")
                ?? envelope.payloadDisplayString("days_left")
                ?? "7"
            showToast("存储包将在 \(days) 天后到期", destructive: true)

        case BillingEvents.storageAutoRenewFailed:
            showToast("存储包自动续费失败，请检查余额或支付方式", destructive: true)

        case BillingEvents.memberBudgetPolicyChanged:
            if let organizationId = WorkspaceStore.shared.selectedOrganizationId {
                Task { await recheckMemberUsage(organizationId: organizationId) }
            }

        default:
            break
        }
    }

    func dismissToast() {
        toastDismissTask?.cancel()
        activeToast = nil
    }

    private func eventBelongsToCurrentUser(_ envelope: WSEnvelope) -> Bool {
        guard let eventUserId = envelope.payloadString("user_id"), !eventUserId.isEmpty else { return true }
        guard let currentUserId = AuthService.shared.currentUser?.id else { return true }
        return eventUserId == currentUserId
    }

    private func buildBalanceLowMessage(balance: String?, threshold: String?) -> String {
        if let balance, let threshold {
            return "组织余额偏低：当前 \(balance)，低于提醒阈值 \(threshold)。"
        }
        return "组织余额偏低，请留意后续用量。"
    }

    private func buildBudgetMessage(title: String, _ envelope: WSEnvelope) -> String {
        var parts = [title]
        if let pct = envelope.payloadDouble("usage_percent").map({ Int($0.rounded()) }) {
            parts.append("当前已使用 \(pct)%")
        }
        if let limit = envelope.payloadDouble("budget_limit") {
            parts.append("预算上限 \(String(format: "%.1f", limit))")
        }
        return parts.joined(separator: "\n")
    }

    func recheckMemberUsage(organizationId: String) async {
        do {
            let usage: MemberUsageResponse = try await APIClient.shared.get(
                path: Endpoints.Billing.myUsage,
                query: ["organization_id": organizationId]
            )

            guard usage.policySource != nil else {
                memberLimitReached = false
                memberLimitReason = nil
                return
            }

            let monthlyUsed = Double(usage.monthlyUsed ?? "0") ?? 0
            let monthlyLimit = usage.monthlyLimit.flatMap { Double($0) } ?? .infinity
            let dailyUsed = Double(usage.dailyUsed ?? "0") ?? 0
            let dailyLimit = usage.dailyLimit.flatMap { Double($0) } ?? .infinity

            if monthlyLimit > 0 && monthlyUsed >= monthlyLimit {
                memberLimitReached = true
                memberLimitReason = "member_monthly_limit"
            } else if dailyLimit > 0 && dailyUsed >= dailyLimit {
                memberLimitReached = true
                memberLimitReason = "member_daily_limit"
            } else {
                memberLimitReached = false
                memberLimitReason = nil
            }
        } catch {
            logger.warning("recheckMemberUsage failed, keeping current state: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func showToast(_ message: String, destructive: Bool) {
        activeToast = BillingToast(message: message, isDestructive: destructive)
        toastDismissTask?.cancel()
        let seconds: TimeInterval = destructive ? 8 : 5
        toastDismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.activeToast = nil
        }
    }
}
