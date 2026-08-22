import Foundation

/// `GET /context/projects/tasks/current` 返回的 `resources[]` 单项。
/// 字段名对齐后端 `project_task_workbench_resources` 投影，供网络解码与 App 首页消费。
struct TaskWorkbenchResource: Decodable, Equatable, Hashable, Identifiable, Sendable {
    let contextItemId: String
    let resourceType: String
    let resourceId: String
    let title: String
    let preview: String?
    let summary: TaskWorkbenchResourceSummary?
    let organizationId: String
    let resourceSpaceId: String?
    let source: TaskWorkbenchResourceSource
    let taskRunId: String
    let isPrimary: Bool
    let canOpen: Bool
    let createdAt: String?
    let updatedAt: String?
    let lastVisitedAt: String?

    init(
        contextItemId: String,
        resourceType: String,
        resourceId: String,
        title: String,
        preview: String? = nil,
        summary: TaskWorkbenchResourceSummary? = nil,
        organizationId: String,
        resourceSpaceId: String? = nil,
        source: TaskWorkbenchResourceSource,
        taskRunId: String,
        isPrimary: Bool,
        canOpen: Bool,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        lastVisitedAt: String? = nil
    ) {
        self.contextItemId = contextItemId
        self.resourceType = resourceType
        self.resourceId = resourceId
        self.title = title
        self.preview = preview
        self.summary = summary
        self.organizationId = organizationId
        self.resourceSpaceId = resourceSpaceId
        self.source = source
        self.taskRunId = taskRunId
        self.isPrimary = isPrimary
        self.canOpen = canOpen
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastVisitedAt = lastVisitedAt
    }

    var id: String { resourceIdentity }

    var normalizedType: String {
        SpaceResource.normalizedType(resourceType)
    }

    var resourceIdentity: String {
        "\(normalizedType):\(resourceId)"
    }

    var createdAtDate: Date? { createdAt.flatMap(ISO8601DateParser.date(from:)) }
    var updatedAtDate: Date? { updatedAt.flatMap(ISO8601DateParser.date(from:)) }
    var lastVisitedAtDate: Date? { lastVisitedAt.flatMap(ISO8601DateParser.date(from:)) }

    /// 本地乐观访问时间；字段其余不变。
    func withLastVisitedAt(_ value: String) -> TaskWorkbenchResource {
        TaskWorkbenchResource(
            contextItemId: contextItemId,
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            preview: preview,
            summary: summary,
            organizationId: organizationId,
            resourceSpaceId: resourceSpaceId,
            source: source,
            taskRunId: taskRunId,
            isPrimary: isPrimary,
            canOpen: canOpen,
            createdAt: createdAt,
            updatedAt: updatedAt,
            lastVisitedAt: value
        )
    }

    enum CodingKeys: String, CodingKey {
        case title, preview, summary, source
        case contextItemId = "context_item_id"
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case organizationId = "organization_id"
        case resourceSpaceId = "resource_space_id"
        case taskRunId = "task_run_id"
        case isPrimary = "is_primary"
        case canOpen = "can_open"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastVisitedAt = "last_visited_at"
    }
}

enum TaskWorkbenchResourceSource: String, Decodable, Equatable, Hashable, Sendable {
    case candidate
    case deliverable
}

extension TaskWorkbenchResource {
    func asAppHomeResource() -> TaskResourceAppHomeResource {
        TaskResourceAppHomeResource(
            contextItemId: contextItemId,
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            preview: preview,
            summary: summary.map {
                TaskResourceAppHomeSummary(
                    recordCount: $0.recordCount,
                    fieldCount: $0.fieldCount,
                    fieldNames: $0.fieldNames
                )
            },
            organizationId: organizationId,
            resourceSpaceId: resourceSpaceId,
            source: source == .deliverable ? .deliverable : .candidate,
            taskRunId: taskRunId,
            isPrimary: isPrimary,
            canOpen: canOpen,
            createdAt: createdAtDate,
            updatedAt: updatedAtDate,
            lastVisitedAt: lastVisitedAtDate
        )
    }

    var openRequest: SpaceResourceOpenRequest {
        SpaceResourceOpenRequest(
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            locationHint: nil
        )
    }
}

/// 白名单摘要；缺字段或类型不对时解码为 nil / 空，不崩。
struct TaskWorkbenchResourceSummary: Decodable, Equatable, Hashable, Sendable {
    let recordCount: Int?
    let fieldCount: Int?
    let fieldNames: [String]?

    enum CodingKeys: String, CodingKey {
        case recordCount = "record_count"
        case fieldCount = "field_count"
        case fieldNames = "field_names"
    }

    init(recordCount: Int? = nil, fieldCount: Int? = nil, fieldNames: [String]? = nil) {
        self.recordCount = recordCount
        self.fieldCount = fieldCount
        self.fieldNames = fieldNames
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recordCount = Self.decodeFlexibleInt(container, forKey: .recordCount)
        fieldCount = Self.decodeFlexibleInt(container, forKey: .fieldCount)
        if let names = try? container.decodeIfPresent([String].self, forKey: .fieldNames) {
            fieldNames = names
        } else {
            fieldNames = nil
        }
    }

    private static func decodeFlexibleInt(
        _ container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> Int? {
        if let value = try? container.decodeIfPresent(Int.self, forKey: key) {
            return value
        }
        if let value = try? container.decodeIfPresent(Double.self, forKey: key), value.isFinite {
            return Int(value)
        }
        return nil
    }
}

/// `ApiEnvelope.data` 形态：`{ "workbench": { "resources": [...] , ... } }`。
/// 其它 CLI 字段忽略；兼容测试里直接给 `resources` 的扁平形状。
struct TaskWorkbenchCurrentResponse: Decodable, Sendable {
    let resources: [TaskWorkbenchResource]

    init(resources: [TaskWorkbenchResource]) {
        self.resources = resources
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let workbench = try container.decodeIfPresent(WorkbenchPayload.self, forKey: .workbench) {
            resources = workbench.resources
        } else {
            resources = (try? container.decodeIfPresent([TaskWorkbenchResource].self, forKey: .resources)) ?? []
        }
    }

    private struct WorkbenchPayload: Decodable {
        let resources: [TaskWorkbenchResource]

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            resources = (try? container.decodeIfPresent([TaskWorkbenchResource].self, forKey: .resources)) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case resources
        }
    }

    private enum CodingKeys: String, CodingKey {
        case workbench
        case resources
    }
}

/// 本地 `taskSnapshot.outputs` 的待确认项：服务端尚未收入正式 `resources` 前可展示「正在同步」。
struct TaskWorkbenchPendingOverlay: Equatable, Hashable, Identifiable, Sendable {
    let resourceType: String
    let resourceId: String
    let title: String
    let preview: String?

    var id: String { resourceIdentity }

    var normalizedType: String {
        SpaceResource.normalizedType(resourceType)
    }

    var resourceIdentity: String {
        "\(normalizedType):\(resourceId)"
    }

    func asAppHomeOverlay() -> TaskResourceAppHomePendingOverlay {
        TaskResourceAppHomePendingOverlay(
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            preview: preview
        )
    }
}

enum TaskWorkbenchPendingOverlayBuilder {
    /// 用 Agent 输出身份做乐观补充；已与服务端 `resources` 撞身份的项丢弃。
    static func build(
        outputs: [TaskWorkbenchOutput],
        confirmedResources: [TaskWorkbenchResource]
    ) -> [TaskWorkbenchPendingOverlay] {
        let confirmed = Set(confirmedResources.map(\.resourceIdentity))
        var seen = Set<String>()
        var overlays: [TaskWorkbenchPendingOverlay] = []

        for output in outputs {
            let type = SpaceResource.normalizedType(output.resourceType)
            let resourceId = output.resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !resourceId.isEmpty else { continue }
            let identity = "\(type):\(resourceId)"
            guard !confirmed.contains(identity), !seen.contains(identity) else { continue }
            seen.insert(identity)
            overlays.append(
                TaskWorkbenchPendingOverlay(
                    resourceType: type,
                    resourceId: resourceId,
                    title: output.title,
                    preview: output.preview
                )
            )
        }
        return overlays
    }
}
