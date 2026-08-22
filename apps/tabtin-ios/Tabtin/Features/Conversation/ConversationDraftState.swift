import Foundation

/// 尚未落到服务端 Session 的新对话输入态。
///
/// `draftId` 在用户首次发送前保持稳定：附件上传可先按它归档，首发失败时文本、上下文和
/// 附件仍能在同一草稿中继续编辑。持久化恢复属于后续草稿恢复工作，此处只负责单次页面生命期。
struct ConversationDraftState: Identifiable, Equatable, Sendable {
    let id: String
    let workspaceId: String
    let organizationId: String
    /// 首发前可选；Session 创建后由 coordinator 冻结，不能再经 Composer 改写。
    var agentId: String?
    let projectId: String?

    init(
        id: String = UUID().uuidString,
        workspaceId: String,
        organizationId: String,
        agentId: String?,
        projectId: String?
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.organizationId = organizationId
        self.agentId = agentId
        self.projectId = projectId
    }

    init(target: ConversationTarget) {
        self.init(
            workspaceId: target.workspaceId,
            organizationId: target.organizationId,
            agentId: target.agentId,
            projectId: target.projectId
        )
    }
}
