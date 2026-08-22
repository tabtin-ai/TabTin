import Foundation
import OSLog

/// 云文档 / 表格公开分享链接的管理服务。
///
/// 端点见 `Endpoints.TabDoc.documentShare` / `documentShareRefresh`、
/// `Endpoints.TabData.tableShare`。协作者邀请不在本服务范围。
actor CloudDocsShareService {
    static let shared = CloudDocsShareService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "CloudDocsShare")

    /// 当前生效的分享。没开过时后端返回 `{ share: null, enabled: false }` → `nil`。
    ///
    /// GET 不带 `share_type`：后端返回当前生效那条（省略时默认 organization 语义
    /// 只影响 POST；GET 空参取 effective）。
    func fetch(type: CloudShareResourceType, resourceId: String) async throws -> CloudDocShare? {
        let path = try sharePath(type: type, resourceId: resourceId)
        do {
            try Task.checkCancellation()
            let response: CloudDocShareFetchResponse = try await APIClient.shared.get(path: path)
            try Task.checkCancellation()
            if response.enabled == false { return nil }
            return response.share
        } catch {
            throw Self.mapAPIError(error)
        }
    }

    func collaborators(type: CloudShareResourceType, resourceId: String) async throws -> [CloudDocsCollaborator] {
        try await collaborationSnapshot(type: type, resourceId: resourceId).collaborators
    }

    /// owner 与协作者的完整快照；工作台继续卡用它展示真实协作关系，
    /// 不把分享权限成员误写成在线 presence。
    func collaborationSnapshot(
        type: CloudShareResourceType,
        resourceId: String
    ) async throws -> CloudDocsCollaboratorList {
        let path = try collaboratorPath(type: type, resourceId: resourceId)
        do {
            try Task.checkCancellation()
            let response: CloudDocsCollaboratorList = try await APIClient.shared.get(path: path)
            try Task.checkCancellation()
            return response
        }
        catch { throw Self.mapAPIError(error) }
    }

    func invite(type: CloudShareResourceType, resourceId: String, userId: String, permission: String) async throws {
        let path = try collaboratorPath(type: type, resourceId: resourceId)
        let _: CloudDocsMutationAck = try await APIClient.shared.post(path: path, body: ["user_ids": [userId], "permission": permission])
    }

    func updateCollaborator(type: CloudShareResourceType, resourceId: String, userId: String, permission: String) async throws {
        let path = try collaboratorPath(type: type, resourceId: resourceId) + "/\(userId)"
        let _: CloudDocsMutationAck = try await APIClient.shared.patch(path: path, body: ["permission": permission])
    }

    func removeCollaborator(type: CloudShareResourceType, resourceId: String, userId: String) async throws {
        let path = try collaboratorPath(type: type, resourceId: resourceId) + "/\(userId)"
        let _: CloudDocsMutationAck = try await APIClient.shared.delete(path: path)
    }

    /// 开启或更新。
    ///
    /// `password` 语义照抄后端：`nil` = 不改动、`""` = 清除密码、非空 = 设置密码。
    /// 扩到公网（anyone）须 `acknowledgePublicExposure == true`，否则后端 409。
    func upsert(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission,
        password: String?,
        acknowledgePublicExposure: Bool
    ) async throws -> CloudDocShare {
        let path = try sharePath(type: type, resourceId: resourceId)
        var body: [String: Any] = [
            "share_type": scope.wireValue(for: type),
            "permission": permission.rawValue,
            "acknowledge_public_exposure": acknowledgePublicExposure,
        ]
        // 省略 password 键 = 后端 None = 不动；显式 "" / 非空则按 PATCH 语义处理。
        if let password {
            body["password"] = password
        }
        do {
            try Task.checkCancellation()
            let response: CloudDocShareMutationResponse = try await APIClient.shared.post(
                path: path,
                body: body
            )
            try Task.checkCancellation()
            return response.share
        } catch {
            throw Self.mapAPIError(error)
        }
    }

    func disable(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope
    ) async throws {
        let path = try sharePath(type: type, resourceId: resourceId)
        // TabData DELETE 省略 share_type 时默认 `data`，组织内分享会被静默漏关——必须显式传。
        let query = ["share_type": scope.wireValue(for: type)]
        do {
            try Task.checkCancellation()
            let _: CloudDocShareDisableResponse = try await APIClient.shared.delete(
                path: path,
                query: query
            )
            try Task.checkCancellation()
        } catch {
            throw Self.mapAPIError(error)
        }
    }

    /// 轮换链接。
    ///
    /// - document：`POST .../share/refresh`
    /// - table：后端没有 `/share/refresh`，用 disable + upsert 兜底（与 Electron
    ///   `useShareSettings.refreshLink` 同源策略）。密码无法在 DELETE→POST 后保留
    ///   （前端拿不到旧 hash）；若 disable 成功而 upsert 失败，会再尝试一次恢复
    ///   upsert，仍失败则抛出原 upsert 错误——此时分享可能已被关掉，UI 应提示并重新拉取状态。
    func refresh(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission
    ) async throws -> CloudDocShare {
        switch type {
        case .document:
            return try await refreshDocument(resourceId: resourceId, scope: scope)
        case .table:
            return try await refreshTableByDisableUpsert(
                resourceId: resourceId,
                scope: scope,
                permission: permission
            )
        }
    }

    /// `{webBaseURL}/shared/docs|tables/{shareId}`。路径段用的是 share_id，不是资源 id。
    static func publicURL(shareId: String, type: CloudShareResourceType) -> URL? {
        let trimmed = shareId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var base = AppConfig.webBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty else { return nil }
        return URL(string: "\(base)/shared/\(type.publicPathSegment)/\(trimmed)")
    }

    /// 把 `APIError` 映射成分享域错误。
    ///
    /// 依据见 `APIClient.responseError`：非 2xx → `serverError(statusCode, message)`，
    /// 信封里的业务 `code` **不会**被保留。因此管理端靠 HTTP 状态：
    /// - 403 → `.forbidden`
    /// - 409 → `.publicExposureNotAcknowledged`（分享 upsert 上唯一 409 为
    ///   `PUBLIC_EXPOSURE_ACK_REQUIRED`）
    /// 另认 `apiErrorWithCode` 的 `PUBLIC_EXPOSURE_ACK_REQUIRED` / `PERMISSION_DENIED`
    ///（2xx + success:false 路径，若出现）。
    nonisolated static func mapAPIError(_ error: Error) -> Error {
        if error is CancellationError || error.isCancellation {
            return error
        }
        if let shareError = error as? CloudDocsShareError {
            return shareError
        }
        guard let apiError = error as? APIError else {
            return CloudDocsShareError.other(error.localizedDescription)
        }
        switch apiError {
        case .serverError(403, _):
            return CloudDocsShareError.forbidden
        case .serverError(409, _):
            return CloudDocsShareError.publicExposureNotAcknowledged
        case .apiErrorWithCode(let code, let message):
            if code == "PUBLIC_EXPOSURE_ACK_REQUIRED" {
                return CloudDocsShareError.publicExposureNotAcknowledged
            }
            if code == "PERMISSION_DENIED" {
                return CloudDocsShareError.forbidden
            }
            return CloudDocsShareError.other(message)
        case .unauthorized:
            // 刻意不并入 `.forbidden`：401 是身份没通过（token 过期、被登出），
            // 报成「只有所有者或管理员能分享」会让用户去查权限，而实际要做的是重新登录。
            return CloudDocsShareError.other(apiError.localizedDescription)
        case .serverError(_, let message):
            return CloudDocsShareError.other(message ?? apiError.localizedDescription)
        case .apiError(let message):
            return CloudDocsShareError.other(message)
        case .invalidURL, .decodingError, .networkError:
            return CloudDocsShareError.other(apiError.localizedDescription)
        }
    }

    // MARK: - Private

    private func sharePath(type: CloudShareResourceType, resourceId: String) throws -> String {
        let id = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            throw CloudDocsShareError.other("missing resource id")
        }
        switch type {
        case .document: return Endpoints.TabDoc.documentShare(id)
        case .table: return Endpoints.TabData.tableShare(id)
        }
    }

    private func collaboratorPath(type: CloudShareResourceType, resourceId: String) throws -> String {
        let id = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { throw CloudDocsShareError.other("missing resource id") }
        switch type {
        case .document: return "/tabdoc/documents/\(id)/collaborators"
        case .table: return "/tabdata/tables/\(id)/collaborators"
        }
    }

    private func refreshDocument(
        resourceId: String,
        scope: CloudShareScope
    ) async throws -> CloudDocShare {
        let id = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            throw CloudDocsShareError.other("missing resource id")
        }
        let path = Endpoints.TabDoc.documentShareRefresh(id)
        let body: [String: Any] = [
            "share_type": scope.wireValue(for: .document),
        ]
        do {
            try Task.checkCancellation()
            let response: CloudDocShareMutationResponse = try await APIClient.shared.post(
                path: path,
                body: body
            )
            try Task.checkCancellation()
            return response.share
        } catch {
            throw Self.mapAPIError(error)
        }
    }

    private func refreshTableByDisableUpsert(
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission
    ) async throws -> CloudDocShare {
        // 先关再开。扩到公网重建仍须 ack（与 Electron recreateBody 一致）。
        let needsAck = (scope == .anyone)
        try await disable(type: .table, resourceId: resourceId, scope: scope)
        do {
            return try await upsert(
                type: .table,
                resourceId: resourceId,
                scope: scope,
                permission: permission,
                password: nil,
                acknowledgePublicExposure: needsAck
            )
        } catch {
            let firstFailure = error
            logger.error(
                """
                table share refresh: upsert after disable failed, attempting restore: \
                \(String(describing: error), privacy: .public)
                """
            )
            do {
                return try await upsert(
                    type: .table,
                    resourceId: resourceId,
                    scope: scope,
                    permission: permission,
                    password: nil,
                    acknowledgePublicExposure: needsAck
                )
            } catch {
                logger.error(
                    """
                    table share refresh: restore upsert also failed; share may be disabled: \
                    \(String(describing: error), privacy: .public)
                    """
                )
                // 恢复失败：抛第一次 upsert 的映射错误；调用方应重新 fetch 确认状态。
                throw firstFailure
            }
        }
    }
}
