import Foundation

/// 后端 REST 路径常量（相对 AppConfig.apiBaseURL）。各 App 端点随对应 Phase 增量补入。
enum Endpoints {
    enum System {
        /// 健康检查走 API 主机根路径，实际拼接见 AppConfig.healthURL。
        static let health = "/health"
    }

    enum Client {
        /// 移动端版本门禁（匿名）：GET /client/version-gate?platform=ios&build=N。
        static let versionGate = "/client/version-gate"
    }

    enum Auth {
        static let login = "/auth/login"
        static let loginWithCode = "/auth/login/verification-code"
        static let sendCode = "/auth/send-verification-code"
        static let redeemInviteCode = "/auth/invite-code/redeem"
        static let refreshToken = "/auth/refresh-token"
        static let logout = "/auth/logout"
        static let profile = "/auth/profile"
        static let profileSettings = "/auth/profile/settings"
        /// 账号级 UI 偏好（theme / colorScheme / fontSize 等 namespace，per-namespace LWW）。
        static let profileUISettings = "/auth/profile/ui-settings"
        static let verifyEmail = "/auth/verify-email"
        static let verifyPhone = "/auth/verify-phone"
        static let sendEmailVerification = "/auth/send-email-verification"
        static let sendPhoneVerification = "/auth/send-phone-verification"
        static let changePassword = "/auth/change-password"
        static let sendCurrentPasswordResetCode = "/auth/send-current-password-reset-code"
        static let resetCurrentPassword = "/auth/reset-current-password"
    }

    /// Agent 身份 CRUD — 挂载 /api/agents（与 Space/Workspace 的 /api/context 分离，）。
    enum Agent {
        static let create = "/agents"
        static let list = "/agents"
        static let templates = "/agents/templates"

        static func detail(_ id: String) -> String {
            "/agents/\(id)"
        }

        static func reactivate(_ id: String) -> String {
            "/agents/\(id)/reactivate"
        }

        static func permanent(_ id: String) -> String {
            "/agents/\(id)/permanent"
        }

        static func preferredModel(_ id: String) -> String {
            "/agents/\(id)/preferred-model"
        }

        static func skills(_ id: String) -> String {
            "/agents/\(id)/skills"
        }

        static func skill(_ id: String, key: String) -> String {
            let escaped = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return "/agents/\(id)/skills/\(escaped)"
        }

        static func deactivated(organizationId: String) -> String {
            let escaped = organizationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? organizationId
            return "/agents/deactivated?organization_id=\(escaped)"
        }
    }

    enum Notifications {
        static let list = "/notifications/"
        static let unreadCount = "/notifications/unread-count"
        static let markAllRead = "/notifications/read-all"

        static func markRead(_ id: String) -> String {
            "/notifications/\(id)/read"
        }

        static func acknowledgeAgentSession(_ sessionId: String) -> String {
            "/notifications/agent-sessions/\(sessionId)/acknowledge"
        }
    }

    enum Context {
        static let organizations = "/context/organizations"
        ///  已退役；列表请用 `workspaces` / `projects`。
        static let spaces = "/context/spaces"
        static let workspaces = "/context/workspaces"
        static let botSpaces = "/context/bot-spaces"
        static let devices = "/context/devices/"
        static let projects = "/context/projects"
        static let pendingProjectInvitations = "/context/projects/invitations/pending"
        /// 移动端推送 token 上报 / 反注册（ 远程推送叫醒）。
        static let devicePushToken = "/context/devices/push-token"
        static let devicePushTokenRevoke = "/context/devices/push-token/revoke"

        /// 当前用户拥有的设备连接器列表（只读展示）。
        static func deviceMcpConnections(deviceId: String) -> String {
            "/context/devices/\(deviceId)/mcp-connections"
        }

        static func organization(_ id: String) -> String {
            "/context/organizations/\(id)"
        }

        static func organizationAppCatalog(_ id: String) -> String {
            "/context/organizations/\(id)/app-catalog"
        }

        static func organizationLeave(_ id: String) -> String {
            "/context/organizations/\(id)/leave"
        }

        static func organizationMembers(_ id: String) -> String {
            "/context/organizations/\(id)/members"
        }

        /// 人员字段选择器：按 search / offset / limit 拉组织成员。
        /// 与 `organizationMembers` 同路径，独立入口避免和全量成员列表调用缠在一起。
        static func organizationMembersSearch(_ id: String) -> String {
            "/context/organizations/\(id)/members"
        }

        static func organizationMemberIdentitySnapshots(_ id: String) -> String {
            "/context/organizations/\(id)/members/identity-snapshots"
        }

        static func organizationMemberBatchProfiles(_ id: String) -> String {
            "/context/organizations/\(id)/members/batch-profiles"
        }

        static func organizationMember(_ organizationId: String, userId: String) -> String {
            "/context/organizations/\(organizationId)/members/\(userId)"
        }

        static func organizationTransferOwnership(_ id: String) -> String {
            "/context/organizations/\(id)/transfer-ownership"
        }

        static func organizationInvitationsEmail(_ id: String) -> String {
            "/context/organizations/\(id)/invitations/email"
        }

        static func organizationInvitationsPhone(_ id: String) -> String {
            "/context/organizations/\(id)/invitations/phone"
        }

        static func organizationInvitationsLink(_ id: String) -> String {
            "/context/organizations/\(id)/invitations/link"
        }

        static func organizationInvitationsDirect(_ id: String) -> String {
            "/context/organizations/\(id)/invitations/direct"
        }

        static func organizationInvitations(_ id: String) -> String {
            "/context/organizations/\(id)/invitations"
        }

        static func organizationInvitation(_ organizationId: String, invitationId: String) -> String {
            "/context/organizations/\(organizationId)/invitations/\(invitationId)"
        }

        static let invitationsMyPending = "/context/invitations/my-pending"

        static func invitationInfo(_ token: String) -> String {
            "/context/invitations/\(encodedPathComponent(token))"
        }

        static func invitationAccept(_ token: String) -> String {
            "\(invitationInfo(token))/accept"
        }

        static func invitationRespond(_ invitationId: String) -> String {
            "/context/invitations/\(invitationId)/respond"
        }

        private static func encodedPathComponent(_ value: String) -> String {
            var allowed = CharacterSet.urlPathAllowed
            allowed.remove(charactersIn: "/")
            return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
        }

        /// Workspace 审批记忆（执行现场维度，非 Agent 身份）。
        static func approvalMemo(workspaceId: String) -> String {
            "/context/workspaces/\(workspaceId)/approval-memo"
        }

        static func workspace(_ id: String) -> String {
            "/context/workspaces/\(id)"
        }

        static func workspaceApps(_ id: String) -> String {
            "/context/workspaces/\(id)/apps"
        }

        static func approvalMemoEntry(workspaceId: String, key: String) -> String {
            let escaped = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return "\(approvalMemo(workspaceId: workspaceId))/\(escaped)"
        }

        ///  / ：`/context/spaces/{id}` CRUD 已 410 `SPACE_RETIRED`。
        /// 实际指向正式路径 `/context/workspaces/{id}`；请用 `workspace(_:)`。
        @available(*, deprecated, message: "Use Endpoints.Context.workspace(_:) — /context/spaces/{id} CRUD is retired ")
        static func space(_ id: String) -> String {
            workspace(id)
        }

        static func project(_ id: String) -> String {
            "/context/projects/\(id)"
        }

        static func projectInvitationReject(_ id: String) -> String {
            "/context/projects/\(id)/invitations/reject"
        }

        static func projectPrimaryAgent(_ id: String) -> String {
            "/context/projects/\(id)/primary-agent"
        }

        static func spaceActivities(_ id: String) -> String {
            "/context/spaces/\(id)/activities"
        }

        static func spaceMemberships(_ id: String) -> String {
            "/context/spaces/\(id)/memberships"
        }

        /// 一个 Space 的内嵌 App 实例列表（context-items）。
        static func contextItems(spaceId: String) -> String {
            "/context/spaces/\(spaceId)/context-items"
        }

        /// 组织级云端资源列表。组织直属的 TabDoc/TabData/TabFiles 没有 Space 宿主。
        static func organizationContextItems(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/context-items"
        }

        static func organizationKnowledgeTree(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/knowledge-tree"
        }

        static func organizationKnowledgeTreeChildren(organizationId: String, nodeId: String) -> String {
            "/context/organizations/\(organizationId)/knowledge-tree/nodes/\(nodeId)/children"
        }

        static func agentProjectTasks(organizationId: String, agentId: String) -> String {
            "/context/organizations/\(organizationId)/agents/\(agentId)/tasks"
        }

        /// 组织级远程 MCP 连接列表（不含本机 attachedAgentIds；挂载态仍在 Electron LocalMcpService）。
        static func organizationMcpConnections(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/mcp-connections"
        }

        /// 当前执行会话绑定的 Project Task Workbench（含  `resources`）。
        /// 必须带真实 chat session id：`X-Tabtin-Session-Id`，不能用标题或 Workspace ID。
        static let currentTaskWorkbench = "/context/projects/tasks/current"

        static func projectTaskWorkbench(projectId: String, taskId: String) -> String {
            "/context/projects/\(projectId)/tasks/\(taskId)/workbench"
        }

        static func contextItem(_ id: String) -> String {
            "/context/context-items/\(id)"
        }

        static func contextItemAccess(_ id: String) -> String {
            "/context/context-items/\(id)/access"
        }

        static func organizationSearch(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/search"
        }

        static func cloudDriveSharedFeed(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/cloud-drive/shared-feed"
        }

        static func organizationCollections(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/collections"
        }

        static func collection(_ collectionId: String) -> String {
            "/context/collections/\(collectionId)"
        }

        static func organizationCollectionsMoveItems(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/collections/move-items"
        }

        static func organizationFileDownloadURL(organizationId: String, contextItemId: String) -> String {
            "/context/organizations/\(organizationId)/files/\(contextItemId)/download-url"
        }

        /// OSS confirm 后把 FileRecord 挂到 Organization 云盘（非同一事务）。
        static func organizationFilesUpload(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/files/upload"
        }

        /// TabFiles 回收站 / 恢复 / 永久删除 —— 路径参数必须是 FileRecordID，不是 ContextItemID。
        static func organizationFileTrash(organizationId: String, fileRecordId: String) -> String {
            "/context/organizations/\(organizationId)/files/\(fileRecordId)/trash"
        }

        static func organizationFileRestore(organizationId: String, fileRecordId: String) -> String {
            "/context/organizations/\(organizationId)/files/\(fileRecordId)/restore"
        }

        static func organizationFilePermanent(organizationId: String, fileRecordId: String) -> String {
            "/context/organizations/\(organizationId)/files/\(fileRecordId)/permanent"
        }

        /// TabFiles 协作者（FileRecordID）。无公开链接，与 TabDoc/TabData share 端点分离。
        static func fileCollaborators(fileRecordId: String) -> String {
            "/context/files/\(fileRecordId)/collaborators"
        }

        static func fileCollaborator(fileRecordId: String, userId: String) -> String {
            "/context/files/\(fileRecordId)/collaborators/\(userId)"
        }

        /// - Warning: Space 宿主下的 skills 子资源已随  / Space CRUD 退役。
        /// 请改用 `Endpoints.Skills`（`organization_id` + `agent_id`）。
        @available(*, deprecated, message: "Use Endpoints.Skills with organization_id + agent_id ")
        static func spaceSkills(spaceId: String) -> String {
            "/context/spaces/\(spaceId)/skills"
        }

        @available(*, deprecated, message: "Use Endpoints.Skills with organization_id + agent_id ")
        static func spaceSkill(spaceId: String, skillId: String) -> String {
            "/context/spaces/\(spaceId)/skills/\(skillId)"
        }
    }

    enum Chat {
        static let sessions = "/chat/sessions"
        /// 跨 Space 对话聚合（「最近」tab 用），带 agent/space 元信息。
        static let sessionsAll = "/chat/sessions/all"
        static func session(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)"
        }
        static func sessionFork(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/fork"
        }
        static func sharedFork(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/shared-fork"
        }
        static func sessionMessages(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/messages"
        }
        static func sessionRead(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/read"
        }
        static func sessionModel(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/model"
        }
        static func sessionContextTier(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/context-tier"
        }
        static func sessionModelParams(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/model-params"
        }
        static let pendingInteractions = "/chat/pending-interactions"
        static func sessionPendingInteractions(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/pending-interactions"
        }
        static func dismissPendingInteraction(_ interactionId: String) -> String {
            "/chat/pending-interactions/\(interactionId)/dismiss"
        }
        static func rollbackPreview(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/rollback/preview"
        }
        static func rollback(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/rollback"
        }
        static func rollbackExecute(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/rollback/execute"
        }
        static func unrevert(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/unrevert"
        }
        static func revertHistory(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/revert-history"
        }
        static func rollbackResources(_ sessionId: String) -> String {
            "/chat/sessions/\(sessionId)/rollback/resources"
        }
        static func rollbackAgentRun(_ agentRunId: String) -> String {
            "/collab/v1/agent-run/\(agentRunId)/rollback"
        }
    }

    enum AgentMemory {
        static let memories = "/agent-memory/memories/"
        static let workspaceSettings = "/agent-memory/workspace-settings/"
        static let workspaceMemoryModels = "/agent-memory/workspace-settings/models/"

        static func forget(_ memoryId: String) -> String {
            "/agent-memory/memories/\(memoryId)/forget/"
        }

        static func correct(_ memoryId: String) -> String {
            "/agent-memory/memories/\(memoryId)/correct/"
        }
    }

    enum IM {
        static let conversations = "/im/conversations"
    }

    /// Skills HTTP：锚点为 `organization_id` + `agent_id`，不再接受 `space_id`。
    enum Skills {
        /// UI Skill 面板：含未启用项。
        static let visible = "/skills/visible"
        /// Agent runtime 索引（已启用过滤）。
        static let index = "/skills/index"
        static let market = "/skills/market"
        static let config = "/skills/config"

        /// 对齐 Electron `encodeURIComponent`：canonical key 含 `:`（如 `user:slug`）。
        private static func encodeSkillKey(_ skillKey: String) -> String {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            return skillKey.addingPercentEncoding(withAllowedCharacters: allowed) ?? skillKey
        }

        static func config(_ skillKey: String) -> String {
            "/skills/config/\(encodeSkillKey(skillKey))"
        }
        static func enable(_ skillKey: String) -> String {
            "/skills/\(encodeSkillKey(skillKey))/enable"
        }
        static func disable(_ skillKey: String) -> String {
            "/skills/\(encodeSkillKey(skillKey))/disable"
        }
    }

    enum CredentialVault {
        static let list = "/credential-vault/list"
    }

    enum Orchestration {
        static func subagentTemplates(spaceId: String) -> String {
            "/orchestration/spaces/\(spaceId)/subagent-templates"
        }

        static func subagentTemplate(spaceId: String, templateId: String) -> String {
            "/orchestration/spaces/\(spaceId)/subagent-templates/\(templateId)"
        }
    }

    enum TabMemo {
        static let memos = "/tabmemo/memos/"
        static let recordStyle = "/tabmemo/record-style/"
        static let heatmap = "/tabmemo/stats/heatmap/"
        static let tagStats = "/tabmemo/tags/stats/"
        /// Organization 级跨 Agent diary（AgentMemory 正典，非 TabMemo source=agent）。
        static let diaryFeed = "/agent-memory/diary-feed/"

        static func memo(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/"
        }

        static func archive(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/archive/"
        }

        static func restore(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/restore/"
        }

        static func retag(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/retag/"
        }

        static func pin(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/pin/"
        }

        static func trash(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/trash/"
        }

        static func restoreFromTrash(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/restore-from-trash/"
        }

        static func attachments(_ memoId: String) -> String {
            "/tabmemo/memos/\(memoId)/attachments/"
        }
    }

    enum Trash {
        private struct ModulePath {
            let prefix: String
            let resource: String
            let trailingSlash: Bool
        }

        private static let legacyToCanonical: [String: String] = [
            "document": "tabdoc", "table": "tabdata", "slide": "tabslide",
            "video": "tabvideo", "code": "tabcode",
            "memo": "tabmemo", "canvas": "tabwhiteboard", "ppt": "tabslide",
        ]

        private static let modules: [String: ModulePath] = [
            "tabdoc": ModulePath(prefix: "/tabdoc", resource: "documents", trailingSlash: false),
            "tabdata": ModulePath(prefix: "/tabdata", resource: "tables", trailingSlash: false),
            "tabslide": ModulePath(prefix: "/tabslide", resource: "projects", trailingSlash: true),
            "tabvideo": ModulePath(prefix: "/tabvideo", resource: "projects", trailingSlash: true),
            "tabwhiteboard": ModulePath(prefix: "/tabwhiteboard", resource: "canvases", trailingSlash: true),
            "tabmemo": ModulePath(prefix: "/tabmemo", resource: "memos", trailingSlash: true),
        ]

        static func list(spaceId: String) -> String {
            "/context/spaces/\(spaceId)/trash"
        }

        static func organizationList(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/trash"
        }

        static func empty(spaceId: String) -> String {
            "/context/spaces/\(spaceId)/trash/empty"
        }

        static func organizationEmpty(organizationId: String) -> String {
            "/context/organizations/\(organizationId)/trash/empty"
        }

        static func restore(itemType: String, resourceId: String, spaceId: String) -> String {
            let type = legacyToCanonical[itemType] ?? itemType
            guard let module = modules[type] else {
                return "/context/spaces/\(spaceId)/trash/\(resourceId)/restore"
            }
            let suffix = module.trailingSlash ? "/" : ""
            return "\(module.prefix)/\(module.resource)/\(resourceId)/restore-from-trash\(suffix)"
        }

        static func permanent(itemType: String, resourceId: String, spaceId: String) -> String {
            let type = legacyToCanonical[itemType] ?? itemType
            guard let module = modules[type] else {
                return "/context/spaces/\(spaceId)/trash/\(resourceId)/permanent"
            }
            let suffix = module.trailingSlash ? "/" : ""
            return "\(module.prefix)/\(module.resource)/\(resourceId)/permanent\(suffix)"
        }
    }

    enum LLM {
        /// 可用模型目录（use_case=chat + organization_id）。发送消息需带其中一个 sendable 模型的 model_id，
        /// 否则后端按 default scene 解析、dev 环境常因 default 未激活而失败。
        static let catalog = "/services/llm/catalog"

        /// 团队维度模型列表（团队设置 AI 能力页用，与 Android LlmApi.getModels 同口径）。
        static func organizationModels(_ organizationId: String) -> String {
            "/services/llm/organizations/\(organizationId)/models"
        }

        /// 设置团队默认模型（PUT，body: `{ model_id }`）。
        static func organizationDefaultModel(_ organizationId: String) -> String {
            "/services/llm/organizations/\(organizationId)/default-model"
        }
    }

    enum Wallet {
        static func organizationWallet(_ organizationId: String) -> String {
            "/wallet/organizations/\(organizationId)/wallet"
        }

        static func organizationTransactions(_ organizationId: String) -> String {
            "/wallet/organizations/\(organizationId)/transactions"
        }
    }

    enum Billing {
        static let myUsage = "/services/billing/my-usage"

        static func usageDashboard(organizationId: String) -> String {
            "/services/billing/organizations/\(organizationId)/usage-dashboard"
        }
    }

    enum OSS {
        static let presignUpload = "/services/oss/presign-upload"
        static let confirmUpload = "/services/oss/confirm-upload"
        static let deactivateUsage = "/services/oss/deactivate-usage"

        static func file(_ id: String) -> String {
            "/services/oss/files/\(id)"
        }
    }

    enum Plan {
        /// 标记 plan 草稿 approved → 后端读最新正文派生 approved markdown。
        static let exit = "/plan/exit"
    }

    enum TabSlide {
        static let projects = "/tabslide/projects/"

        /// 单个幻灯片工程详情（含 pages）。
        static func project(_ id: String) -> String {
            "/tabslide/projects/\(id)/"
        }
    }

    enum TabSite {
        static func site(_ id: String) -> String {
            "/tabsite/sites/\(id)/"
        }
    }

    enum TabDoc {
        static let documents = "/tabdoc/documents"
        /// 别人分享给当前用户的文档（query: organization_id）。
        static let sharedWithMe = "/tabdoc/shared-with-me"

        static func document(_ id: String) -> String {
            "/tabdoc/documents/\(id)"
        }

        static func documentContent(_ id: String) -> String {
            "/tabdoc/documents/\(id)/content"
        }

        static func documentVersions(_ id: String) -> String {
            "/collab/v1/docs/\(id)/versions"
        }

        static func documentRestore(_ id: String) -> String {
            "/collab/v1/docs/\(id)/restore"
        }

        static func documentImageAsset(_ documentId: String, fileId: String) -> String {
            "/tabdoc/documents/\(documentId)/image-assets/\(fileId)"
        }

        /// 公开链接的增删查。GET 不带 share_type 时返回当前生效的那条。
        static func documentShare(_ id: String) -> String {
            "/tabdoc/documents/\(id)/share"
        }

        /// 轮换 share_id，旧链接立即失效。TabData 侧没有对称端点。
        static func documentShareRefresh(_ id: String) -> String {
            "/tabdoc/documents/\(id)/share/refresh"
        }

        static func documentCommentThreads(_ id: String) -> String {
            "/tabdoc/documents/\(id)/comment-threads"
        }
    }

    /// TabTracker 自动化。URL path 沿用后端 ``/tracker/events``（波次 4 一刀切后
    /// 唯一前缀，无 agenda 兼容 alias）；step-level checkpoint 已下线，不再暴露。
    enum TabTracker {
        static let events = "/tracker/events"
        static let templates = "/tracker/templates"
        /// 未来执行点预览（组织 / Workspace 级，只读展开 cron / interval / at，不落库）。
        static let schedulePreview = "/tracker/schedule-preview"

        static func event(_ id: String) -> String {
            "/tracker/events/\(id)"
        }

        static func activate(_ id: String) -> String {
            "/tracker/events/\(id)/activate"
        }

        static func pause(_ id: String) -> String {
            "/tracker/events/\(id)/pause"
        }

        static func resume(_ id: String) -> String {
            "/tracker/events/\(id)/resume"
        }

        static func trigger(_ id: String) -> String {
            "/tracker/events/\(id)/trigger"
        }

        static func runs(_ trackerId: String) -> String {
            "/tracker/events/\(trackerId)/runs"
        }

        static func cancelRun(trackerId: String, runId: String) -> String {
            "/tracker/events/\(trackerId)/runs/\(runId)/cancel"
        }
    }

    enum TabData {
        static let tables = "/tabdata/tables"
        static let fieldsCreate = "/tabdata/fields"
        /// 别人分享给当前用户的多维表（query: organization_id）。
        static let sharedWithMe = "/tabdata/shared-with-me"

        static func table(_ id: String) -> String {
            "/tabdata/tables/\(id)"
        }

        /// 公开链接的增删查。与 TabDoc 不同：公网范围的 share_type 是 `data` 而非
        /// `public`，且没有 `/refresh`——轮换要靠 DELETE 再 POST。
        static func tableShare(_ id: String) -> String {
            "/tabdata/tables/\(id)/share"
        }

        static func fields(tableId: String) -> String {
            "/tabdata/tables/\(tableId)/fields"
        }

        static func records(tableId: String) -> String {
            "/tabdata/tables/\(tableId)/records"
        }

        static func views(tableId: String) -> String {
            "/tabdata/tables/\(tableId)/views"
        }

        static func viewRecords(_ viewId: String) -> String {
            "/tabdata/views/\(viewId)/records"
        }

        static func record(_ recordId: String) -> String {
            "/tabdata/records/\(recordId)"
        }

        static let recordsCreate = "/tabdata/records"
        /// 与桌面端一致：不带 expected_version，写入不被版本 CAS 拒绝。
        static let recordsBulkUpdate = "/tabdata/records/bulk-update"
    }
}

/// `POST /api/plan/exit` 响应（`{success,data}` 解包后的 data）。
/// 后端读 plan 文档最新正文标记 approved 并派生 approvedPlanMarkdown；客户端切回 agent 模式后
/// 把 approved markdown 作为续聊 user 消息发出。
struct PlanExitResponse: Decodable, Sendable {
    let outcome: String?
    let approvedPlanMarkdown: String?
    let planWasEditedByUser: Bool?

    enum CodingKeys: String, CodingKey {
        case outcome
        case approvedPlanMarkdown = "approved_plan_markdown"
        case planWasEditedByUser = "plan_was_edited_by_user"
    }
}
