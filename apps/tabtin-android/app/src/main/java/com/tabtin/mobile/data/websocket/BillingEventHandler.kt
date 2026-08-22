package com.tabtin.mobile.data.websocket

import android.content.Context
import android.util.Log
import android.widget.Toast
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.BillingApi
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.roundToInt

/**
 * 处理 billing.events.{organizationId} topic 的 WebSocket 事件。
 *
 * 对标 Electron 端 useBillingEventStream.ts，实现：
 * - 余额变化、配额耗尽等事件的 Toast 通知
 * - 触发钱包/用量数据的静默刷新
 *
 * 通过 [WebSocketService.onEnvelope] 注册为全局 envelope handler，
 * 过滤 `billing.*` 类型事件进行处理。
 */
@Singleton
public class BillingEventHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val webSocketService: WebSocketService,
    private val tokenManager: TokenManager,
    private val billingApi: BillingApi,
) {
    public companion object {
        private const val TAG = "BillingEventHandler"
        private const val HANDLER_KEY = "billing_events"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val _refreshRequired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    /** UI 层（如 WalletViewModel）收集此 Flow 触发钱包/用量数据刷新 */
    public val refreshRequired: SharedFlow<Unit> = _refreshRequired.asSharedFlow()

    private val _billingBlocked = MutableStateFlow(false)
    /** 计费阻断状态，对标 Electron useBillingStore.billingBlocked */
    public val billingBlocked: StateFlow<Boolean> = _billingBlocked.asStateFlow()

    private val _memberLimitBlocked = MutableStateFlow(false)
    /** 成员额度阻断状态，对标 Electron useBillingStore.memberLimitReached */
    public val memberLimitBlocked: StateFlow<Boolean> = _memberLimitBlocked.asStateFlow()

    private val _memberLimitReason = MutableStateFlow<String?>(null)
    /** 阻断原因: member_monthly_limit / member_daily_limit */
    public val memberLimitReason: StateFlow<String?> = _memberLimitReason.asStateFlow()

    /**
     * FE-56: credits_recharged + billing_unblocked 在同一充值操作中连续发出时
     * 只展示一条 toast。记录最近一次 CREDITS_RECHARGED 的时间戳，若 BILLING_UNBLOCKED
     * 在 2s 内到达则跳过其 toast。
     */
    @Volatile
    private var lastRechargedAtMs: Long = 0

    @Volatile
    private var isStarted = false

    public fun start() {
        if (isStarted) return
        isStarted = true
        webSocketService.onEnvelope(HANDLER_KEY) { envelope ->
            handleEnvelope(envelope)
        }
        webSocketService.onReconnected = { recheckMemberUsage() }
        Log.i(TAG, "Billing event handler registered")
    }

    public fun stop() {
        if (!isStarted) return
        isStarted = false
        webSocketService.removeHandler(HANDLER_KEY)
        webSocketService.onReconnected = null
        Log.i(TAG, "Billing event handler unregistered")
    }

    private fun handleEnvelope(envelope: WSEnvelope) {
        val msgType = envelope.type
        if (!msgType.startsWith("billing.")) return

        if (msgType in BillingEvents.DATA_REFRESH_EVENTS) {
            _refreshRequired.tryEmit(Unit)
        }

        when (msgType) {
            BillingEvents.BALANCE_LOW -> {
                val balance = envelope.payloadString("current_balance")
                val threshold = envelope.payloadString("threshold")
                showToast(buildBalanceLowMessage(balance, threshold), long = true)
            }

            BillingEvents.BILLING_BLOCKED -> {
                // 请求级余额不足由当前会话的 BillingErrorCard 承载，不锁住整个组织。
                if (!BillingBlockClassifier.isOrganizationGuard(envelope)) return
                val wasBlocked = _billingBlocked.value
                _billingBlocked.value = true
                if (!wasBlocked) {
                    val reason = envelope.payloadString("reason")
                    showToast(
                        reason ?: context.getString(R.string.billing_blocked_desc),
                        long = true,
                    )
                }
            }

            BillingEvents.BILLING_UNBLOCKED -> {
                _billingBlocked.value = false
                val isRechargeTriggered = System.currentTimeMillis() - lastRechargedAtMs < 2000
                if (!isRechargeTriggered) {
                    showToast(context.getString(R.string.billing_unblocked))
                }
            }

            BillingEvents.QUOTA_EXHAUSTED -> {
                // DATA_REFRESH_EVENTS 已刷新钱包和用量；正常资金路由不打断对话。
                Unit
            }

            BillingEvents.CREDITS_RECHARGED -> {
                _billingBlocked.value = false
                lastRechargedAtMs = System.currentTimeMillis()
                showToast(context.getString(R.string.billing_credits_recharged))
            }

            BillingEvents.MEMBERSHIP_ACTIVATED -> {
                showToast(context.getString(R.string.billing_membership_activated))
            }

            BillingEvents.BUDGET_WARNING -> {
                val desc = buildBudgetDesc(envelope)
                val msg = context.getString(R.string.billing_budget_warning) +
                    (desc?.let { "\n$it" } ?: "")
                showToast(msg, long = true)
            }

            BillingEvents.BUDGET_CRITICAL -> {
                val desc = buildBudgetDesc(envelope)
                val msg = context.getString(R.string.billing_budget_critical) +
                    (desc?.let { "\n$it" } ?: "")
                showToast(msg, long = true)
            }

            BillingEvents.BUDGET_RESOLVED -> {
                showToast(context.getString(R.string.billing_budget_resolved))
            }

            BillingEvents.MEMBERSHIP_EXPIRING -> {
                val daysLeft = envelope.payloadString("days_left")?.toIntOrNull()
                val msg = if (daysLeft != null) {
                    context.getString(R.string.billing_membership_expiring_days, daysLeft)
                } else {
                    context.getString(R.string.billing_membership_expiring)
                }
                showToast(msg, long = true)
            }

            BillingEvents.MEMBERSHIP_EXPIRED -> {
                showToast(context.getString(R.string.billing_membership_expired), long = true)
            }

            BillingEvents.AUTO_RENEW_FAILED -> {
                val reason = envelope.payloadString("reason")
                val msg = if (reason == "insufficient_balance") {
                    context.getString(R.string.billing_auto_renew_failed_balance)
                } else {
                    context.getString(R.string.billing_auto_renew_failed)
                }
                showToast(msg, long = true)
            }

            BillingEvents.MEMBERSHIP_DOWNGRADED_OVERLIMIT -> {
                val count = envelope.payloadString("exceeded_count")?.toIntOrNull() ?: 0
                showToast(
                    context.getString(R.string.billing_membership_downgraded, count),
                    long = true,
                )
            }

            BillingEvents.INVOICE_REFUNDED -> {
                showToast(context.getString(R.string.billing_invoice_refunded))
            }

            BillingEvents.MEMBERSHIP_RENEWAL_CANCELLED -> {
                showToast(context.getString(R.string.billing_renewal_cancelled), long = true)
            }

            BillingEvents.DEGRADATION_ALERT -> {
                val meterKey = envelope.payloadString("meter_key") ?: "unknown"
                showToast(
                    context.getString(R.string.billing_degradation_alert, meterKey),
                    long = true,
                )
            }

            BillingEvents.MEMBER_BUDGET_WARNING -> {
                val userId = envelope.payloadString("user_id")
                val currentUserId = tokenManager.userId
                if (currentUserId != null && userId != null && userId != currentUserId) return
                val pct = envelope.payloadString("usage_percent")
                    ?.toDoubleOrNull()?.roundToInt() ?: 80
                val budgetType = envelope.payloadString("budget_type")
                val msg = if (budgetType == "daily") {
                    context.getString(R.string.billing_member_budget_daily_warning, pct)
                } else {
                    context.getString(R.string.billing_member_budget_monthly_warning, pct)
                }
                showToast(msg, long = true)
            }

            BillingEvents.MEMBER_BUDGET_EXHAUSTED -> {
                val userId = envelope.payloadString("user_id")
                val currentUserId = tokenManager.userId
                if (currentUserId != null && userId != null && userId != currentUserId) return
                val budgetType = envelope.payloadString("budget_type")
                val reason = if (budgetType == "daily") "member_daily_limit" else "member_monthly_limit"
                _memberLimitBlocked.value = true
                _memberLimitReason.value = reason
                val msg = if (budgetType == "daily") {
                    context.getString(R.string.billing_member_budget_daily_exhausted)
                } else {
                    context.getString(R.string.billing_member_budget_monthly_exhausted)
                }
                showToast(msg, long = true)
            }

            BillingEvents.MEMBER_BUDGET_RESOLVED -> {
                val userId = envelope.payloadString("user_id")
                val currentUserId = tokenManager.userId
                val scope = envelope.payloadString("scope")
                if (scope == "personal") {
                    if (currentUserId != null && userId != null && userId != currentUserId) return
                    _memberLimitBlocked.value = false
                    _memberLimitReason.value = null
                    showToast(context.getString(R.string.billing_member_budget_resolved))
                } else {
                    recheckMemberUsage()
                }
            }

            BillingEvents.INVOICE_COLLECTION_SUCCEEDED -> {
                showToast(context.getString(R.string.billing_invoice_collection_succeeded))
            }

            BillingEvents.INVOICE_COLLECTION_FAILED -> {
                showToast(context.getString(R.string.billing_invoice_collection_failed), long = true)
            }

            BillingEvents.PLATFORM_REFUND_COMPLETED -> {
                showToast(context.getString(R.string.billing_platform_refund_completed))
            }

            BillingEvents.PLATFORM_REFUND_FAILED -> {
                showToast(context.getString(R.string.billing_platform_refund_failed), long = true)
            }

            BillingEvents.REFUND_PARTIAL_FAILURE -> {
                showToast(context.getString(R.string.billing_refund_partial_failure), long = true)
            }

            BillingEvents.STORAGE_WARNING -> {
                val pct = envelope.payloadString("usage_percent") ?: "90"
                showToast(context.getString(R.string.billing_storage_warning, pct), long = true)
            }

            BillingEvents.STORAGE_CRITICAL -> {
                val pct = envelope.payloadString("usage_percent") ?: "95"
                showToast(context.getString(R.string.billing_storage_critical, pct), long = true)
            }

            BillingEvents.STORAGE_RESOLVED -> {
                showToast(context.getString(R.string.billing_storage_resolved))
            }

            BillingEvents.STORAGE_PACKAGE_EXPIRING -> {
                val days = envelope.payloadString("days_left") ?: "7"
                showToast(context.getString(R.string.billing_storage_package_expiring, days), long = true)
            }

            BillingEvents.STORAGE_AUTO_RENEW_FAILED -> {
                showToast(context.getString(R.string.billing_storage_auto_renew_failed), long = true)
            }
        }
    }

    private fun buildBalanceLowMessage(balance: String?, threshold: String?): String {
        if (balance != null && threshold != null) {
            return context.getString(R.string.billing_balance_low_detail, balance, threshold)
        }
        return context.getString(R.string.billing_balance_low)
    }

    private fun buildBudgetDesc(envelope: WSEnvelope): String? {
        val pct = envelope.payloadString("usage_percent")
            ?.toDoubleOrNull()
            ?.roundToInt()
        val limit = envelope.payloadString("budget_limit")
            ?.toDoubleOrNull()
        return when {
            pct != null && limit != null ->
                context.getString(R.string.billing_budget_usage_pct_limit, pct, limit.toString())
            pct != null ->
                context.getString(R.string.billing_budget_usage_pct, pct)
            else -> null
        }
    }

    /**
     * 调用 my-usage API 校正 memberLimitBlocked 状态。
     * 对标 Electron _recheckMemberUsage：重连后 / RESOLVED 非 personal scope 时调用。
     * 加 0-5s 随机抖动避免大量客户端同时请求。
     */
    public fun recheckMemberUsage() {
        val organizationId = tokenManager.organizationId ?: return
        scope.launch(Dispatchers.IO) {
            delay((Math.random() * 5000).toLong())
            try {
                val usage = billingApi.getMyUsage(organizationId).data ?: return@launch
                if (usage.policySource == null) {
                    _memberLimitBlocked.value = false
                    _memberLimitReason.value = null
                    return@launch
                }
                val mUsed = usage.monthlyUsed?.toDoubleOrNull() ?: 0.0
                val mLimit = usage.monthlyLimit?.toDoubleOrNull() ?: Double.MAX_VALUE
                val dUsed = usage.dailyUsed?.toDoubleOrNull() ?: 0.0
                val dLimit = usage.dailyLimit?.toDoubleOrNull() ?: Double.MAX_VALUE
                when {
                    mLimit > 0 && mUsed >= mLimit -> {
                        _memberLimitBlocked.value = true
                        _memberLimitReason.value = "member_monthly_limit"
                    }
                    dLimit > 0 && dUsed >= dLimit -> {
                        _memberLimitBlocked.value = true
                        _memberLimitReason.value = "member_daily_limit"
                    }
                    else -> {
                        _memberLimitBlocked.value = false
                        _memberLimitReason.value = null
                    }
                }
                Log.d(TAG, "recheckMemberUsage: policy=${usage.policySource} mUsed=$mUsed/$mLimit dUsed=$dUsed/$dLimit blocked=${_memberLimitBlocked.value}")
            } catch (e: Exception) {
                Log.w(TAG, "recheckMemberUsage failed, keeping current state: ${e.message}")
            }
        }
    }

    private fun showToast(message: String, long: Boolean = false) {
        scope.launch(Dispatchers.Main) {
            Toast.makeText(
                context,
                message,
                if (long) Toast.LENGTH_LONG else Toast.LENGTH_SHORT,
            ).show()
        }
    }
}
