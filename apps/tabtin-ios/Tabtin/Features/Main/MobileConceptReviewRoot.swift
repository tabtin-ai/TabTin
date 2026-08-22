#if DEBUG
import SwiftUI

/// TabDoc / TabData 原生移动形态的确定性设备验收入口。
/// 只替换正式页面的数据请求；布局、编辑控件、保存反馈和高风险降级都走生产组件。
struct NativeCloudDocsReviewRoot: View {
    @State private var selectedTab: ReviewTab = .document

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("文档", systemImage: "doc.text", value: ReviewTab.document) {
                NavigationStack {
                    NativeTabDocEditorScreen(
                        documentId: NativeCloudDocsReviewFixtures.documentId,
                        organizationId: NativeCloudDocsReviewFixtures.organizationId,
                        spaceId: "review-space",
                        fallbackTitle: "移动端原生文档",
                        locationHint: nil,
                        session: NativeCloudDocsReviewFixtures.documentSession(complex: false)
                    )
                }
            }

            Tab("多维表", systemImage: "rectangle.grid.1x2", value: ReviewTab.table) {
                NavigationStack {
                    NativeTabDataScreen(
                        tableId: NativeCloudDocsReviewFixtures.tableId,
                        organizationId: NativeCloudDocsReviewFixtures.organizationId,
                        spaceId: "review-space",
                        fallbackTitle: "移动端验收清单",
                        locationHint: nil,
                        session: NativeCloudDocsReviewFixtures.tableSession()
                    )
                }
            }

            Tab("复杂文档", systemImage: "lock.doc", value: ReviewTab.complexDocument) {
                NavigationStack {
                    NativeTabDocEditorScreen(
                        documentId: NativeCloudDocsReviewFixtures.complexDocumentId,
                        organizationId: NativeCloudDocsReviewFixtures.organizationId,
                        spaceId: "review-space",
                        fallbackTitle: "复杂文档只读验收",
                        locationHint: nil,
                        session: NativeCloudDocsReviewFixtures.documentSession(complex: true)
                    )
                }
            }
        }
        .tint(.tt.bgAccent)
    }

    private enum ReviewTab: Hashable {
        case document
        case table
        case complexDocument
    }
}

@MainActor
private enum NativeCloudDocsReviewFixtures {
    static let organizationId = "review-organization"
    static let documentId = "review-document"
    static let complexDocumentId = "review-complex-document"
    static let tableId = "review-table"

    static func documentSession(complex: Bool) -> NativeTabDocSession {
        let id = complex ? complexDocumentId : documentId
        let detail = documentDetail(id: id, complex: complex, version: 8)
        return NativeTabDocSession(
            documentId: id,
            organizationId: organizationId,
            fallbackTitle: detail.document.title,
            userId: "review-user",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in detail },
            writeRequest: { _, draft in
                try? await Task.sleep(for: .milliseconds(650))
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: id,
                    organizationId: organizationId,
                    spaceId: "review-space",
                    title: draft.title,
                    latestVersion: 9,
                    updatedAt: "2026-08-13T08:30:00Z",
                    currentUserRole: "editor"
                ))
            }
        )
    }

    static func tableSession() -> NativeTabDataSession {
        let metadata = tableMetadata()
        var remoteRecords = tableRecords()
        return NativeTabDataSession(
            tableId: tableId,
            organizationId: organizationId,
            userId: "review-user",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            metadataRequest: { _ in metadata },
            recordsRequest: { _, _, query in
                try? await Task.sleep(for: .milliseconds(220))
                let search = query["search"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let visible = search?.isEmpty == false
                    ? remoteRecords.filter { record in
                        record.fields.values.contains { value in
                            NativeTabDataDisplayText.make(value).lowercased().contains(search ?? "")
                        }
                    }
                    : remoteRecords
                return NativeTabDataRecordList(
                    records: visible,
                    total: visible.count,
                    matchedTotal: visible.count,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { recordId, draft in
                try? await Task.sleep(for: .milliseconds(650))
                guard let current = remoteRecords.first(where: { $0.id == recordId }) else {
                    throw APIError.serverError(404, "记录不存在")
                }
                let body = draft.updateBody()["fields"] as? [String: Any] ?? [:]
                var fields = current.fields
                for (key, value) in body { fields[key] = AnyCodable(value) }
                let updated = NativeTabDataRecord(
                    id: current.id,
                    tableId: tableId,
                    fields: fields,
                    version: current.version + 1
                )
                if let index = remoteRecords.firstIndex(where: { $0.id == recordId }) {
                    remoteRecords[index] = updated
                }
                return NativeTabDataRecordUpdateResult(record: updated)
            },
            createRequest: { draft in
                try? await Task.sleep(for: .milliseconds(650))
                let body = draft.createBody()["fields"] as? [String: Any] ?? [:]
                let created = NativeTabDataRecord(
                    id: "record-created",
                    tableId: tableId,
                    fields: body.mapValues(AnyCodable.init),
                    version: 1
                )
                remoteRecords.insert(created, at: 0)
                return created
            },
            deleteRequest: { request in
                try? await Task.sleep(for: .milliseconds(450))
                remoteRecords.removeAll { $0.id == request.recordId }
            }
        )
    }

    private static func documentDetail(id: String, complex: Bool, version: Int) -> NativeTabDocDetail {
        let title = complex ? "复杂文档 · 原生只读" : "移动端原生云文档方案"
        let content: [[String: Any]] = complex ? [
            ["type": "heading", "attrs": ["level": 1], "content": [["type": "text", "text": "季度发布总览"]]],
            ["type": "paragraph", "content": [["type": "text", "text": "这篇文档包含移动端暂时不能无损编辑的画板结构，但正文仍可直接阅读。"]]],
            ["type": "whiteboard", "attrs": ["title": "跨端发布依赖图", "nodeCount": 18]],
            ["type": "paragraph", "content": [["type": "text", "text": "需要修改复杂结构时，可切换到 Web 完整编辑器。"]]],
        ] : [
            ["type": "heading", "attrs": ["level": 1], "content": [["type": "text", "text": "原生体验验收"]]],
            ["type": "paragraph", "content": [["type": "text", "text": "移动端不复刻桌面画布，而是把内容整理成适合单手阅读和编辑的纵向信息流。"]]],
            ["type": "bulletList", "content": [
                ["type": "listItem", "content": [["type": "paragraph", "content": [["type": "text", "text": "标题与正文直接编辑"]]]]],
                ["type": "listItem", "content": [["type": "paragraph", "content": [["type": "text", "text": "离开页面前自动保存"]]]]],
            ]],
            ["type": "taskList", "content": [
                ["type": "taskItem", "attrs": ["checked": true], "content": [["type": "paragraph", "content": [["type": "text", "text": "双端原生入口"]]]]],
                ["type": "taskItem", "attrs": ["checked": false], "content": [["type": "paragraph", "content": [["type": "text", "text": "设备视觉验收"]]]]],
            ]],
            ["type": "blockquote", "content": [["type": "paragraph", "content": [["type": "text", "text": "样式可以不同，但用户任务必须完整。"]]]]],
            ["type": "codeBlock", "content": [["type": "text", "text": "入口 → 原生页面 → 自动保存"]]],
        ]
        return NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: id,
                organizationId: organizationId,
                spaceId: "review-space",
                title: title,
                latestVersion: version,
                updatedAt: "2026-08-13T08:00:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable(content),
                ],
                descriptionMarkdown: "",
                descriptionPlaintext: ""
            )
        )
    }

    private static func tableMetadata() -> NativeTabDataSession.MetadataResponse {
        let table: NativeTabDataTable = decode([
            "id": tableId,
            "name": "移动端验收清单",
            "organization_id": organizationId,
            "default_view_id": "view-all",
            "current_user_role": "editor",
        ])
        let fields: [NativeTabDataField] = [
            decode(["id": "title", "name": "事项", "field_type": "text", "is_primary": true, "order": 0]),
            decode(["id": "owner", "name": "负责人", "field_type": "text", "order": 1]),
            decode(["id": "status", "name": "状态", "field_type": "single_select", "order": 2, "options": ["choices": [
                ["value": "todo", "label": "待处理", "color": "#8B95A5"],
                ["value": "doing", "label": "进行中", "color": "#4D7CFE"],
                ["value": "done", "label": "已完成", "color": "#30A46C"],
            ]]]),
            decode(["id": "priority", "name": "优先级", "field_type": "single_select", "order": 3, "options": ["choices": ["P0", "P1", "P2"]]]),
            decode(["id": "due", "name": "截止日期", "field_type": "date", "order": 4]),
            decode(["id": "note", "name": "备注", "field_type": "long_text", "order": 5]),
        ]
        let views: [NativeTabDataView] = [
            decode(["id": "view-all", "name": "全部记录", "view_type": "grid", "order": 0, "visible_fields": fields.map(\.id), "field_order": fields.map(\.id), "config": ["card_title_field": "title"]]),
            decode(["id": "view-progress", "name": "按状态", "view_type": "list", "order": 1, "visible_fields": fields.map(\.id), "field_order": fields.map(\.id), "config": ["card_title_field": "title"]]),
        ]
        return (table, NativeTabDataFieldList(fields: fields), NativeTabDataViewList(views: views))
    }

    private static func tableRecords() -> [NativeTabDataRecord] {
        [
            NativeTabDataRecord(id: "record-1", tableId: tableId, fields: [
                "title": AnyCodable("iOS 键盘与安全区验收"), "owner": AnyCodable("林晓"),
                "status": AnyCodable("doing"), "priority": AnyCodable("P0"),
                "due": AnyCodable("2026-08-15"), "note": AnyCodable("覆盖标题、长文本和保存反馈"),
            ], version: 4),
            NativeTabDataRecord(id: "record-2", tableId: tableId, fields: [
                "title": AnyCodable("Android 卡片与记录表单"), "owner": AnyCodable("陈默"),
                "status": AnyCodable("todo"), "priority": AnyCodable("P1"),
                "due": AnyCodable("2026-08-16"), "note": AnyCodable("不复刻桌面二维网格"),
            ], version: 2),
            NativeTabDataRecord(id: "record-3", tableId: tableId, fields: [
                "title": AnyCodable("复杂结构降级回程"), "owner": AnyCodable("小锡"),
                "status": AnyCodable("done"), "priority": AnyCodable("P1"),
                "due": AnyCodable("2026-08-13"), "note": AnyCodable("原生只读，Web 完整编辑"),
            ], version: 6),
        ]
    }

    private static func decode<T: Decodable>(_ object: [String: Any]) -> T {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(T.self, from: data)
    }
}

/// Space / Project 移动端信息架构的确定性视觉夹具。
/// 仅由 Debug 启动参数 `--mobile-concept-review` 打开，复用正式卡片与详情页组件。
struct MobileConceptReviewRoot: View {
    @State private var selectedSection: ReviewSection = .space
    @State private var showDesktopNotice = false
    @State private var selectedTab: MainNavTab = .agents
    @State private var theme = ThemeManager.shared
    @State private var language = LanguageManager.shared

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab(value: MainNavTab.recent) {
                ReviewRecentScreen()
            } label: {
                Label(MainNavTab.recent.title, systemImage: MainNavTab.recent.icon)
            }

            Tab(value: MainNavTab.agents) {
                NavigationStack {
                    VStack(spacing: 0) {
                        Picker(L10n.Common.tabSpace, selection: $selectedSection) {
                            ForEach(ReviewSection.allCases) { section in
                                Text(section.title).tag(section)
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal, TTSpacing.md)
                        .padding(.vertical, TTSpacing.sm)

                        if selectedSection == .space {
                            ReviewSpaceList()
                        } else {
                            ReviewProjectList(showDesktopNotice: $showDesktopNotice)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
                    .ttRootNavigationTitle(L10n.Common.tabSpace)
                    .ttToolbarBackground()
                }
            } label: {
                Label(MainNavTab.agents.title, systemImage: MainNavTab.agents.icon)
            }

            Tab(value: MainNavTab.cloudDocs) {
                ReviewPlaceholder(title: MainNavTab.cloudDocs.title, icon: MainNavTab.cloudDocs.icon)
            } label: {
                Label(MainNavTab.cloudDocs.title, systemImage: MainNavTab.cloudDocs.icon)
            }

            Tab(value: MainNavTab.profile) {
                ReviewPlaceholder(title: MainNavTab.profile.title, icon: MainNavTab.profile.icon)
            } label: {
                Label(MainNavTab.profile.title, systemImage: MainNavTab.profile.icon)
            }
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .tint(.tt.bgAccent)
        .preferredColorScheme(theme.resolvedColorScheme)
        .environment(\.locale, language.effectiveLocale)
        .id(language.language)
        .alert(L10n.Project.desktopAcceptTitle, isPresented: $showDesktopNotice) {
            Button(L10n.Common.confirm, role: .cancel) {}
        } message: {
            Text(L10n.Project.desktopAcceptBody)
        }
    }
}

private enum ReviewSection: String, CaseIterable, Identifiable {
    case space
    case project

    var id: String { rawValue }
    var title: String { self == .space ? L10n.Project.segmentSpace : L10n.Project.segmentProject }
}

private struct ReviewSpaceList: View {
    var body: some View {
        List {
            ForEach(MobileConceptReviewFixtures.spaces, id: \.space.id) { item in
                SpaceRow(
                    space: item.space,
                    agent: item.agent,
                    device: item.device,
                    isMetadataLoading: false
                )
                .listRowInsets(EdgeInsets(
                    top: TTSpacing.xs,
                    leading: TTSpacing.md,
                    bottom: TTSpacing.xs,
                    trailing: TTSpacing.md
                ))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault)
    }
}

private struct ReviewProjectList: View {
    @Binding var showDesktopNotice: Bool
    @State private var selectedProject: Project?

    var body: some View {
        List {
            Section(L10n.Project.invitations) {
                ProjectInvitationRow(invitation: MobileConceptReviewFixtures.invitation) {
                    showDesktopNotice = true
                }
                .listRowBackground(Color.clear)
            }

            Section {
                ForEach(MobileConceptReviewFixtures.projects) { project in
                    Button {
                        selectedProject = project
                    } label: {
                        ProjectListCard(project: project)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(
                        top: TTSpacing.xs,
                        leading: TTSpacing.md,
                        bottom: TTSpacing.xs,
                        trailing: TTSpacing.md
                    ))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault)
        .navigationDestination(
            isPresented: Binding(
                get: { selectedProject != nil },
                set: { if !$0 { selectedProject = nil } }
            )
        ) {
            if let selectedProject {
                ProjectDetailScreen(
                    project: selectedProject,
                    snapshot: MobileConceptReviewFixtures.projectSnapshot
                )
            }
        }
    }
}

private struct ReviewRecentScreen: View {
    var body: some View {
        NavigationStack {
            List {
                ReviewRecentRow(title: "整理发布检查清单", source: L10n.Project.sourceSpace, name: "产品研发", isProject: false)
                    .listRowBackground(Color.clear)
                ReviewRecentRow(title: "移动端协作方案", source: L10n.Project.sourceProject, name: "移动端焕新", isProject: true)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
            .ttRootNavigationTitle(L10n.Recent.title)
            .ttToolbarBackground()
        }
    }
}

private struct ReviewRecentRow: View {
    let title: String
    let source: String
    let name: String
    let isProject: Bool

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            RoundedRectangle(cornerRadius: 10)
                .fill(.tt.bgAccent.opacity(0.15))
                .frame(width: 40, height: 40)
                .overlay(Text(String(name.prefix(1))).font(.tt.bodySemibold).foregroundStyle(.tt.iconAccent))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(title).font(.tt.bodySemibold).foregroundStyle(.tt.textPrimary)
                HStack(spacing: TTSpacing.xs) {
                    Text("[\(source)]")
                        .font(.tt.captionMedium)
                        .foregroundStyle(isProject ? .tt.iconAccent : .tt.textSecondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(isProject ? Color.tt.bgAccent.opacity(0.10) : Color.tt.bgSubtleSecondary, in: Capsule())
                    Text(name).font(.tt.caption).foregroundStyle(.tt.textSecondary)
                }
                Text("Agent 已完成整理，等待你确认下一步")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, TTSpacing.sm)
    }
}

private struct ReviewPlaceholder: View {
    let title: String
    let icon: String

    var body: some View {
        ContentUnavailableView(title, systemImage: icon)
    }
}

private enum MobileConceptReviewFixtures {
    struct SpaceItem {
        let space: Space
        let agent: AgentSummary?
        let device: RuntimeDevice?
    }

    static let spaces: [SpaceItem] = [
        SpaceItem(
            space: Space(
                id: "space-1", organizationId: "organization-1", type: "workspace",
                agentId: "agent-1", executionAgentId: "agent-1", executionBindingSource: "explicit",
                boundDeviceId: "device-1", controlDeviceId: "device-1", name: "产品研发",
                description: "需求梳理、原型与客户端开发", icon: nil, avatar: nil, color: nil,
                status: "active", tableCount: 3, order: 0, isArchived: false, isDefault: true,
                configVersion: 8, createdAt: "2026-07-01T08:00:00Z", updatedAt: "2026-07-18T01:00:00Z"
            ),
            agent: AgentSummary(
                id: "agent-1", organizationId: "organization-1", userId: nil, ownerUserId: nil,
                name: "小锡 · 产品搭档",
                type: "general", isActive: true, boundDeviceId: "device-1", controlDeviceId: "device-1"
            ),
            device: RuntimeDevice(
                id: "device-1", name: "Allen 的 MacBook Pro", deviceType: "electron",
                status: "online", lastHeartbeatAt: "2026-07-18T02:00:00Z"
            )
        ),
        SpaceItem(
            space: Space(
                id: "space-2", organizationId: "organization-1", type: "workspace",
                agentId: "agent-2", executionAgentId: "agent-2", executionBindingSource: "explicit",
                boundDeviceId: "device-2", controlDeviceId: "device-2", name: "增长实验",
                description: "竞品调研与市场内容", icon: nil, avatar: nil, color: nil,
                status: "active", tableCount: 1, order: 1, isArchived: false, isDefault: false,
                configVersion: 3, createdAt: "2026-07-02T08:00:00Z", updatedAt: "2026-07-17T10:00:00Z"
            ),
            agent: AgentSummary(
                id: "agent-2", organizationId: "organization-1", userId: nil, ownerUserId: nil,
                name: "增长研究员",
                type: "research", isActive: true, boundDeviceId: "device-2", controlDeviceId: "device-2"
            ),
            device: RuntimeDevice(
                id: "device-2", name: "办公室 Mac mini", deviceType: "daemon",
                status: "offline", lastHeartbeatAt: "2026-07-17T10:00:00Z"
            )
        ),
    ]

    static let invitation = PendingProjectInvitation(
        projectId: "project-invite", projectName: "品牌官网改版", organizationId: "organization-1",
        role: "editor", inviterName: "林晓", invitedAt: "2026-07-18T00:30:00Z"
    )

    static let projects: [Project] = [
        Project(
            id: "project-1", organizationId: "organization-1", type: "team_space",
            name: "移动端焕新", description: "一起完成 iOS 与 Android 的概念升级和交付",
            avatar: nil, color: nil, status: "active", isArchived: false, visibility: "private",
            memberCount: 6, primaryAgentId: "agent-1", canManage: true,
            lastActivityAt: "2026-07-18T02:00:00Z",
            createdAt: "2026-07-01T08:00:00Z", updatedAt: "2026-07-18T02:00:00Z",
            myWorkspace: ProjectCompanionWorkspace(
                id: "workspace-1", name: "产品研发", agentId: "agent-1", executionAgentId: "agent-1",
                workingDir: "/Users/demo/mobile",
                controlDeviceId: "device-1", controlDeviceStatus: "online", isCompanion: true
            )
        ),
        Project(
            id: "project-2", organizationId: "organization-1", type: "team_space",
            name: "企业版发布", description: "跨团队准备发布材料、验收证据和客户通知",
            avatar: nil, color: nil, status: "active", isArchived: false, visibility: "private",
            memberCount: 12, primaryAgentId: nil, canManage: false,
            lastActivityAt: "2026-07-17T11:00:00Z",
            createdAt: "2026-06-25T08:00:00Z", updatedAt: "2026-07-17T11:00:00Z",
            myWorkspace: nil
        ),
    ]

    static let projectSnapshot = ProjectDetailSnapshot(
        discussions: [
            ProjectDiscussion.reviewFixture(id: "discussion-1", name: "#general", preview: "林晓：设计稿已经更新，请大家确认"),
            ProjectDiscussion.reviewFixture(id: "discussion-2", name: "#agent-updates", preview: "小锡完成了 iOS 构建与模型测试"),
        ],
        assets: [
            SpaceResource(
                id: "asset-1", itemType: "tabdoc", title: "移动端概念说明",
                preview: nil, resourceId: "document-1", spaceId: "project-1", organizationId: "organization-1", metadata: nil,
                isArchived: false, isPinned: true, pinnedAt: "2026-07-18T01:30:00Z",
                updatedAt: "2026-07-18T01:30:00Z", createdAt: "2026-07-17T08:00:00Z",
                spaceName: "移动端焕新"
            ),
            SpaceResource(
                id: "asset-2", itemType: "tabdata", title: "双端验收清单",
                preview: nil, resourceId: "table-1", spaceId: "project-1", organizationId: "organization-1", metadata: nil,
                isArchived: false, isPinned: false, pinnedAt: nil,
                updatedAt: "2026-07-17T11:00:00Z", createdAt: "2026-07-17T10:00:00Z",
                spaceName: "移动端焕新"
            ),
        ],
        activities: [
            ProjectActivityEvent.reviewFixture(
                id: "activity-1", eventType: "agent_run_completed", actorName: "小锡",
                targetName: "iOS Space / Project 概念拆分", createdAt: "2026-07-18T01:50:00Z"
            ),
            ProjectActivityEvent.reviewFixture(
                id: "activity-2", eventType: "member_joined", actorName: "Allen",
                targetName: "林晓", createdAt: "2026-07-17T08:20:00Z"
            ),
        ],
        participants: [
            ProjectParticipant(
                id: "member-1", name: "Allen", kind: .member, role: "owner",
                roleLabel: nil, responsibility: nil, userId: "user-allen", agentId: nil,
                ownedByCurrentUser: false, isPrimary: false
            ),
            ProjectParticipant(
                id: "member-2", name: "林晓", kind: .member, role: "editor",
                roleLabel: nil, responsibility: nil, userId: "user-linxiao", agentId: nil,
                ownedByCurrentUser: false, isPrimary: false
            ),
            ProjectParticipant(
                id: "agent-membership-1", name: "小锡 · 产品搭档", kind: .agent, role: "editor",
                roleLabel: "主要负责 Agent", responsibility: "统筹需求、拆解任务并汇总交付结果",
                userId: nil, agentId: "agent-1", ownedByCurrentUser: true, isPrimary: true
            ),
            ProjectParticipant(
                id: "agent-membership-2", name: "质量守门员", kind: .agent, role: "viewer",
                roleLabel: "质量验收", responsibility: "检查双端一致性、测试证据和发布风险",
                userId: nil, agentId: "agent-2", ownedByCurrentUser: false, isPrimary: false
            ),
        ]
    )
}

private extension ProjectDiscussion {
    static func reviewFixture(id: String, name: String, preview: String) -> Self {
        let data = Data("""
        {"id":"\(id)","organization_id":"organization-1","space_id":"project-1","space_name":"移动端焕新","is_team_space_channel":true,"name":"\(name)","member_count":6,"is_archived":false,"last_message_at":"2026-07-18T02:00:00Z","last_message_preview":"\(preview)","unread_count":2}
        """.utf8)
        return try! JSONDecoder().decode(Self.self, from: data)
    }
}

private extension ProjectActivityEvent {
    static func reviewFixture(
        id: String,
        eventType: String,
        actorName: String,
        targetName: String,
        createdAt: String
    ) -> Self {
        let data = Data("""
        {"id":"\(id)","event_type":"\(eventType)","actor_name":"\(actorName)","target_name":"\(targetName)","metadata":{},"created_at":"\(createdAt)"}
        """.utf8)
        return try! JSONDecoder().decode(Self.self, from: data)
    }
}
#endif
