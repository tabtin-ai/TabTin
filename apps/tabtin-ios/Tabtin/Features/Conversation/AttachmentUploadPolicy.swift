import Foundation

/// Composer 中「资料」区域的纯状态投影。
///
/// 上下文引用不需要上传，视为可直接随消息发送；附件则必须先进入 `.ready`。
/// 发送页面和附件管理器都可复用这套规则，避免 UI 的提示与实际发送门槛漂移。
struct ComposerMaterialSummary: Equatable, Sendable {
    let attachmentCount: Int
    let contextReferenceCount: Int
    let readyAttachmentCount: Int
    let uploadingAttachmentCount: Int
    let failedAttachmentCount: Int

    var totalCount: Int { attachmentCount + contextReferenceCount }
    var readyCount: Int { readyAttachmentCount + contextReferenceCount }
    var cancellableUploadCount: Int { uploadingAttachmentCount }

    /// 与 `ConversationScreen.sendCurrentDraft` 的判断顺序对齐：先处理仍在上传，
    /// 再提示失败附件，避免用户在两个问题同时存在时收到互相矛盾的指引。
    var sendingBlocker: ComposerMaterialSendingBlocker? {
        if uploadingAttachmentCount > 0 { return .uploading(count: uploadingAttachmentCount) }
        if failedAttachmentCount > 0 { return .failed(count: failedAttachmentCount) }
        return nil
    }
}

enum ComposerMaterialSendingBlocker: Equatable, Sendable {
    case uploading(count: Int)
    case failed(count: Int)
}

enum AttachmentUploadPolicy {
    static let unsupportedDocumentMessage = "当前模型不支持文档直传，请切换到支持文档的模型后再发送。"

    /// Composer 有正文或至少一个已上传完成的附件时即可提交。
    /// 上传中和失败的附件不能单独构成一条消息。
    static func canSubmit(
        text: String,
        attachments: [ComposerLocalAttachment]
    ) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || attachments.contains { $0.status == .ready }
    }

    static func summary(
        attachments: [ComposerLocalAttachment],
        contextReferenceCount: Int
    ) -> ComposerMaterialSummary {
        let safeContextCount = max(0, contextReferenceCount)
        return ComposerMaterialSummary(
            attachmentCount: attachments.count,
            contextReferenceCount: safeContextCount,
            readyAttachmentCount: attachments.count { $0.status == .ready },
            uploadingAttachmentCount: attachments.count { $0.status.isInFlight },
            failedAttachmentCount: attachments.count { $0.status == .error }
        )
    }

    /// 「取消全部上传」只影响未完成的附件；已上传的资料及失败项仍留在 Composer，
    /// 让用户可以继续发送、重试，或明确单项移除。
    static func cancellableAttachmentIDs(in attachments: [ComposerLocalAttachment]) -> [String] {
        attachments.filter { $0.status.isInFlight }.map(\.id)
    }

    /// 图片仍由视觉能力链路处理；这里只对齐 Electron 的 `type=file` 文档门禁。
    static func hasUnsupportedDocumentAttachment(
        attachments: [ComposerLocalAttachment],
        supportsDocumentInput: Bool
    ) -> Bool {
        !supportsDocumentInput && attachments.contains { $0.kind == .file }
    }
}

/// 为附件上传解析稳定的组织归属。
///
/// 页面入口携带的 target/draft 是首选；旧会话或工作台入口可能缺失这些字段，
/// 此时依次使用服务端已加载的 Session 和当前选中组织，避免附件功能误报“未选择组织”。
enum AttachmentUploadScopeResolver {
    static func resolve(
        contextId: String?,
        targetOrganizationId: String?,
        draftOrganizationId: String?,
        sessionOrganizationId: String?,
        workspaceOrganizationId: String?
    ) -> UploadScope? {
        guard let contextId = normalized(contextId) else { return nil }
        let organizationId = [
            targetOrganizationId,
            draftOrganizationId,
            sessionOrganizationId,
            workspaceOrganizationId,
        ].lazy.compactMap(normalized).first
        guard let organizationId else { return nil }
        return UploadScope(
            module: "chat",
            contextType: "message",
            contextId: contextId,
            organizationId: organizationId,
            isPublic: false
        )
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
