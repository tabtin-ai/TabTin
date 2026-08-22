import Foundation

/// 云盘 / Memo App 首页启动上下文（计划 §6.1）。
///
/// `activeConversationSink` 仅在从任务对话工作台进入时存在；
/// 深链 / Sheet / 通知入口为空，此时不展示「发送到当前对话」。
struct AppHomeLaunchContext: Sendable {
    enum Source: String, Sendable, Hashable {
        case taskWorkbench
        case deepLink
        case sheet
    }

    let organizationId: String
    let source: Source

    var canOfferSendToConversation: Bool {
        source == .taskWorkbench
    }
}

/// 将资源注入当前任务对话 composer 的回调门面。
/// 文件夹永远不可调用；View 层在 `canOfferSendToConversation == false` 时不展示入口。
struct CloudDriveConversationSink {
    let send: (MentionContextRef) -> Void

    func sendResource(_ ref: MentionContextRef) {
        send(ref)
    }
}

/// 高风险操作能力判定：owner-only 移动、文件夹强确认、TabFiles FileRecord 操作。
enum CloudDriveHighRiskPolicy {
    /// 共享资源不可改变 owner 的个人文件夹位置；仅 `can_move == true`（后端 owner）可移动。
    static func canMoveResource(_ resource: SpaceResource) -> Bool {
        resource.canMove == true
    }

    static func canMoveShared(_ item: SharedResourceItem) -> Bool {
        item.canMove == true
    }

    /// 文件夹属当前用户个人树；All 非搜索且可写时开放 rename/move/delete。
    static func canManageFolders(canWrite: Bool, scope: CloudDriveScope, isSearching: Bool) -> Bool {
        canWrite && scope == .all && !isSearching
    }

    /// 优先尊重后端 `can_trash`；缺省时才回退 `can_delete`，不以单独 `can_edit` 放行。
    static func canTrashTabFile(_ resource: SpaceResource) -> Bool {
        guard resource.normalizedType == "tabfiles",
              let fileRecordId = resource.fileRecordId,
              !fileRecordId.isEmpty
        else { return false }
        if let canTrash = resource.canTrash {
            return canTrash
        }
        return resource.canDelete == true
    }

    static func canManageTabFileCollaborators(_ resource: SpaceResource) -> Bool {
        resource.normalizedType == "tabfiles"
            && resource.fileRecordId != nil
            && resource.canShare == true
    }

    static func canTrashSharedTabFile(_ item: SharedResourceItem) -> Bool {
        guard item.resourceType == .file else { return false }
        let fileRecordId = item.fileRecordId ?? item.resourceId
        guard !fileRecordId.isEmpty else { return false }
        if let canTrash = item.canTrash {
            return canTrash
        }
        return item.canDelete == true
    }

    static func canManageSharedTabFileCollaborators(_ item: SharedResourceItem) -> Bool {
        guard item.resourceType == .file else { return false }
        let fileRecordId = item.fileRecordId ?? item.resourceId
        return !fileRecordId.isEmpty && item.canShare == true
    }

    /// 文件夹移动强确认文案：源 → 目标（目标可为根）。
    static func moveFolderConfirmMessage(sourceName: String, targetName: String) -> String {
        L10n.CloudDrive.moveFolderConfirmMessage(sourceName, targetName)
    }

    /// 文件夹永远不可发送；资源在 sink 存在时才可发送。
    static func canSendToConversation(
        row: CloudDriveListRow,
        sink: CloudDriveConversationSink?
    ) -> Bool {
        guard sink != nil else { return false }
        switch row {
        case .folder:
            return false
        case .resource, .shared:
            return true
        }
    }

    static func mentionRef(for resource: SpaceResource, fallbackSpaceName: String?) -> MentionContextRef? {
        // tabfiles 必须用 FileRecordID 作为 resourceId（wire `file_id`）。
        if resource.normalizedType == "tabfiles" {
            guard let fileRecordId = resource.fileRecordId, !fileRecordId.isEmpty else { return nil }
            return MentionContextRef(
                type: .file,
                resourceId: fileRecordId,
                label: resource.displayTitle,
                preview: resource.preview,
                spaceId: resource.spaceId,
                spaceName: resource.spaceName ?? fallbackSpaceName
            )
        }
        return resource.toMentionContextRef(fallbackSpaceName: fallbackSpaceName)
    }

    static func mentionRef(for shared: SharedResourceItem, fallbackSpaceName: String?) -> MentionContextRef? {
        switch shared.resourceType {
        case .file:
            let fileRecordId = shared.fileRecordId ?? shared.resourceId
            guard !fileRecordId.isEmpty else { return nil }
            return MentionContextRef(
                type: .file,
                resourceId: fileRecordId,
                label: shared.displayTitle,
                preview: shared.preview,
                spaceId: shared.spaceId,
                spaceName: fallbackSpaceName
            )
        case .doc:
            return MentionContextRef(
                type: .document,
                resourceId: shared.resourceId,
                label: shared.displayTitle,
                preview: shared.preview,
                spaceId: shared.spaceId,
                spaceName: fallbackSpaceName
            )
        case .table:
            return MentionContextRef(
                type: .table,
                resourceId: shared.resourceId,
                label: shared.displayTitle,
                preview: shared.preview,
                spaceId: shared.spaceId,
                spaceName: fallbackSpaceName
            )
        }
    }
}
