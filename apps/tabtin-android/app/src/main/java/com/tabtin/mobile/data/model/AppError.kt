package com.tabtin.mobile.data.model

import android.content.Context
import androidx.annotation.StringRes
import com.tabtin.mobile.R

public enum class ActionLabel(@StringRes public val labelRes: Int) {
    LOGIN(R.string.error_label_login),
    FETCH_CONFIG(R.string.error_label_fetch_config),
    GET_PRESIGN(R.string.error_label_get_presign),
    CONFIRM_UPLOAD(R.string.error_label_confirm_upload),
    LOAD_AGENTS(R.string.error_label_load_agents),
    LOAD_SESSIONS(R.string.error_label_load_sessions),
    CREATE_SESSION(R.string.error_label_create_session),
    LOAD_MESSAGES(R.string.error_label_load_messages),
    SUBMIT_ANSWER(R.string.error_label_submit_answer),
    SUBMIT_PERMISSION(R.string.error_label_submit_permission),
    FORK_SESSION(R.string.error_label_fork_session),
    ROLLBACK_PREVIEW(R.string.error_label_rollback_preview),
    ROLLBACK(R.string.error_label_rollback),
    UNREVERT(R.string.error_label_unrevert),
    RESTORE_RESOURCES(R.string.error_label_restore_resources),
}

public sealed class AppError(message: String? = null) : Exception(message) {

    public abstract fun toUserMessage(context: Context): String

    // ── Auth ──────────────────────────────────────────────

    public data object InvalidPhone : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_invalid_phone)
    }

    public data class SendCodeFailed(val serverMessage: String? = null) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String =
            serverMessage ?: context.getString(R.string.error_send_code_failed)
    }

    public data object NotLoggedIn : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_not_logged_in)
    }

    // ── Session / Organization ───────────────────────────────

    public data object NoOrganization : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_no_workspace)
    }

    public data object SessionNotLoaded : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_session_not_loaded)
    }

    public data object NetworkUnavailable : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_network)
    }

    // ── Generic API ──────────────────────────────────────

    public data class RequestFailed(
        val serverMessage: String? = null,
        val errorCode: String? = null,
    ) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String =
            serverMessage ?: context.getString(R.string.error_request_failed)
    }

    public data object InviteCodeRateLimited : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_rate_limited)
    }

    /** 文档创建额度已用尽；[used] / [limit] 来自服务端额度契约，缺失时仍保留可行动提示。 */
    public data class DocumentQuotaExceeded(
        val used: Int? = null,
        val limit: Int? = null,
        val serverMessage: String? = null,
    ) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String =
            serverMessage ?: context.getString(R.string.doc_quota_exceeded_message)
    }

    /** 已上传的对象不能再用不同范围确认；必须丢弃旧确认并重新选择附件。 */
    public data object PresignScopeMismatch : AppError("上传签名范围已失效，请重新选择图片后重试。") {
        override fun toUserMessage(context: Context): String = message.orEmpty()
    }

    public data object VersionConflict : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.doc_save_conflict)
    }

    public data class ActionFailed(
        val label: ActionLabel,
        val serverMessage: String? = null,
    ) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String {
            if (serverMessage != null) return serverMessage
            return context.getString(R.string.common_action_failed, context.getString(label.labelRes))
        }
    }

    // ── Streaming / WebSocket ────────────────────────────

    public data object WsTimeout : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_ws_timeout)
    }

    public data object SubscribeFailed : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_subscribe_failed)
    }

    public data object SubscribeTimedOut : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_subscribe_timeout)
    }

    public data object SubscribeDisconnected : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_subscribe_disconnected)
    }

    public data class SubscribeRejected(
        val errorCode: String,
        val serverMessage: String?,
    ) : AppError(serverMessage ?: errorCode) {
        override fun toUserMessage(context: Context): String =
            if (errorCode == "WS_1005_PERMISSION_DENIED") {
                context.getString(R.string.error_subscribe_denied)
            } else {
                context.getString(R.string.error_subscribe_rejected)
            }
    }

    public data object AgentStartTimeout : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_agent_start_timeout)
    }

    public data class SendFailed(val originalMessage: String? = null) : AppError(originalMessage) {
        override fun toUserMessage(context: Context): String =
            originalMessage ?: context.getString(R.string.error_send_failed)
    }

    public data object AgentTimeout : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_agent_timeout)
    }

    public data object ReconnectTimeout : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_reconnect_timeout)
    }

    public data class AgentExecution(
        val serverMessage: String? = null,
        val errorClass: String? = null,
        val suggestedAction: String? = null,
        val errorCategory: String? = null,
        val errorCode: String? = null,
    ) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String {
            val code = errorCode?.trim()?.lowercase()
            val category = errorCategory?.trim()?.lowercase()
            if (code == "device_offline" || category == "device_offline") {
                return context.getString(R.string.chat_error_device_offline)
            }
            val raw = serverMessage?.trim().orEmpty()
            if (raw.equals("device_offline", ignoreCase = true) ||
                raw.startsWith("[device_offline]", ignoreCase = true)
            ) {
                return context.getString(R.string.chat_error_device_offline)
            }
            return raw.ifEmpty { context.getString(R.string.error_agent_execution) }
        }
    }

    public data class BillingBlocked(
        val errorCategory: String,
        val errorCode: String,
        private val serverMessage: String,
    ) : AppError(serverMessage) {
        override fun toUserMessage(context: Context): String {
            val resId = BILLING_MESSAGE_MAP[errorCategory]
            return if (resId != null) context.getString(resId) else serverMessage
        }

        public companion object {
            /**
             * Wave 5 协议 Review P3：与 Electron `BILLING_ERROR_CATEGORIES`（apps/tabtin-electron/
             * src/renderer/src/components/chat/BillingErrorCard.tsx:11-14）和 iOS
             * `StreamManager.billingErrorCategories` 对齐。
             *
             * 改动说明：
             *   - **移除** `rate_limited`：按 Electron / iOS 约定，限流不属于 Billing。它应该走
             *     `ChatErrorClass.RATE_LIMITED` 结构化错误卡（warning + retryable）。之前 Android
             *     把 rate_limited 塞进 Billing 卡片会触发 `onNavigateToWallet`，但去钱包也解决不了
             *     RPM 限流——用户等一分钟就好。
             *   - **移除** `conversation_quota_exceeded`：Electron 也不在 Billing 集合里；走
             *     `ChatErrorClass.BUDGET_EXHAUSTED`（走 ERROR_CODE_TO_ERROR_CLASS 的 code 映射）
             *     + suggested_action=shorten_context 让用户新建对话。
             *   - **新增** `quota` / `billing`：Electron/iOS 的 category 集合包含这两个，是后端对
             *     "还没细分到哪种 Billing 超限"场景的兜底命名。
             *
             * SYNC: apps/tabtin-electron/src/renderer/src/components/chat/BillingErrorCard.tsx
             *       BILLING_ERROR_CATEGORIES
             * SYNC: apps/tabtin-ios/.../StreamManager.swift billingErrorCategories
             */
            public val CATEGORIES: Set<String> = setOf(
                "insufficient_credits",
                "organization_insufficient_credits",
                "budget_exceeded",
                "quota",
                "billing",
                "member_monthly_limit",
                "member_daily_limit",
                "member_model_restricted",
                "member_budget",
            )

            private val BILLING_MESSAGE_MAP: Map<String, Int> = mapOf(
                "insufficient_credits" to R.string.chat_billing_insufficient_credits,
                "organization_insufficient_credits" to R.string.chat_billing_organization_insufficient_credits,
                "budget_exceeded" to R.string.chat_billing_budget_exceeded,
                // quota / billing 是后端粗粒度兜底分类，走默认"额度不足"文案，与桌面端兜底一致
                "quota" to R.string.chat_billing_budget_exceeded,
                "billing" to R.string.chat_billing_budget_exceeded,
                "member_monthly_limit" to R.string.chat_billing_member_monthly_limit,
                "member_daily_limit" to R.string.chat_billing_member_daily_limit,
                "member_model_restricted" to R.string.chat_billing_member_model_restricted,
                "member_budget" to R.string.chat_billing_member_monthly_limit,
            )
        }
    }

    // ── Conversation ─────────────────────────────────────

    public data object WaitUpload : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_wait_upload)
    }

    public data object AllAttachmentsFailed : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_all_attachments_failed)
    }

    // ── Attachment / Upload ──────────────────────────────

    public data class AttachmentLimit(val max: Int) : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_attachment_limit, max)
    }

    public data object CannotReadFileInfo : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_cannot_read_file_info)
    }

    public data class UnsupportedFileType(val mimeType: String) : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_unsupported_file_type, mimeType)
    }

    public data class FileTooLarge(val maxMB: Long) : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_file_too_large, maxMB)
    }

    public data object UploadFailed : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_upload_failed)
    }

    public data object CannotReadFile : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_cannot_read_file)
    }

    // ── OSS ──────────────────────────────────────────────

    public data object InstantNoFileId : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_instant_no_file_id)
    }

    public data object MissingPresignedUrl : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_missing_presigned_url)
    }

    public data object MissingObjectKey : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_missing_object_key)
    }

    public data class OssPutFailed(val statusCode: Int) : AppError() {
        override fun toUserMessage(context: Context): String =
            context.getString(R.string.error_oss_put_failed, statusCode)
    }
}
