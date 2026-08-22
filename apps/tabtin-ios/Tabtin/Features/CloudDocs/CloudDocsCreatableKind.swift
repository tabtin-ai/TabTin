import Foundation

/// 云文档「新建」可扩展条目。
///
/// UI（右上角 Menu）只遍历 ``enabledKinds``，不感知具体 HTTP / DTO。
/// 已有打开路由的类型（如再建一种文档类 App）通常只需：
/// 1. 在本枚举加 case
/// 2. 在 ``CloudDocsCreateService.create`` 补创建映射
/// 3. 视需要把 case 放进 ``enabledKinds``
///
/// 全新品类还要同步：`SpaceAppRoute` / 打开屏、浏览侧 `cloudDocItemTypes`、
/// Repository 写入接口等——Menu 布局本身不用改。
///
/// `rawValue` 对齐平台 `item_type`（`tabdoc` / `tabdata`…），方便和知识树、分享类型对表。
enum CloudDocsCreatableKind: String, CaseIterable, Identifiable, Sendable {
    case document = "tabdoc"
    case table = "tabdata"

    var id: String { rawValue }

    /// 当前对用户开放的新建类型。临时下线某类型只改此数组，不必动 UI。
    static var enabledKinds: [CloudDocsCreatableKind] {
        [.document, .table]
    }

    var title: String {
        switch self {
        case .document: return L10n.CloudDocs.actionNewDoc
        case .table: return L10n.CloudDocs.actionNewTable
        }
    }

    /// 无白底内容字形；与列表行 ``CloudDocsAppIcon`` 同源，不走带底座的 AppIcon。
    var iconReference: AppIconReference {
        AppIconResolver.resolveContentGlyph(
            appId: rawValue,
            manifestIcon: SpaceResource.icon(forType: rawValue)
        )
    }
}

/// 创建成功后交给浏览面打开的产物——只暴露路由，避免 UI 依赖各 App 的响应 DTO。
struct CloudDocsCreatedResource: Sendable, Equatable {
    /// 资源本体 id（document_id / table_id…），用作打开上下文的稳定键。
    let resourceId: String
    let route: SpaceAppRoute
    let title: String
}

/// 云文档新建的唯一写入入口。
///
/// 与 `CloudDriveViewModel` 解耦：云文档 Tab 建在组织根（`collectionId == nil`），
/// 不复用云盘的当前文件夹状态。底层仍走 `CloudDriveRepository`，避免双份 HTTP。
enum CloudDocsCreateService {
    static func create(
        kind: CloudDocsCreatableKind,
        organizationId: String,
        collectionId: String? = nil,
        title: String? = nil
    ) async throws -> CloudDocsCreatedResource {
        let resolvedTitle = Self.resolveTitle(title)
        switch kind {
        case .document:
            let created = try await CloudDriveRepository.createDocument(
                organizationId: organizationId,
                collectionId: collectionId,
                title: resolvedTitle
            )
            let displayTitle = Self.displayTitle(created.title, fallback: resolvedTitle)
            return CloudDocsCreatedResource(
                resourceId: created.id,
                route: .tabdoc(documentId: created.id, documentName: displayTitle),
                title: displayTitle
            )
        case .table:
            let created = try await CloudDriveRepository.createTable(
                organizationId: organizationId,
                collectionId: collectionId,
                name: resolvedTitle
            )
            let displayTitle = Self.displayTitle(created.name, fallback: resolvedTitle)
            return CloudDocsCreatedResource(
                resourceId: created.id,
                route: .tabdata(tableId: created.id, tableName: displayTitle),
                title: displayTitle
            )
        }
    }

    static func resolveTitle(_ title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? L10n.CloudDocs.untitled : trimmed
    }

    private static func displayTitle(_ value: String?, fallback: String) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? fallback : trimmed
    }
}
