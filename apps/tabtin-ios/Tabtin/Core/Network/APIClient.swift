import Foundation
import os

enum TokenRefreshResult: Sendable, Equatable {
    case succeeded
    case tokenInvalid
    case conflict
    case temporarilyUnavailable
}

/// Token 刷新的内部执行结果。公开的 `TokenRefreshResult` 保持业务四态不变；取消态只在
/// APIClient 内传播，避免被降级成“网络暂不可用”后继续走请求或误报错误。
private enum TokenRefreshAttemptResult: Sendable {
    case completed(TokenRefreshResult)
    case cancelled
}

enum APIAuthenticationMode: Sendable, Equatable {
    /// 受保护请求：注入 access token，401 时允许刷新并在凭据确认失效后退登。
    case session
    /// 登录入口请求：不携带旧会话，401 直接作为本次操作失败展示。
    case none
}

struct EmbeddedWebCredential: Sendable, Equatable {
    let accessToken: String
    let expiresAt: Int?
}

enum EmbeddedWebCredentialResult: Sendable, Equatable {
    case ready(EmbeddedWebCredential)
    case unauthenticated
    case temporarilyUnavailable
}

/// 网络层核心 actor。Phase 1 起接入鉴权：
/// - 统一 Token 注入（从 Keychain 取 access token）；
/// - 401 自动刷新（单飞：多个请求同时 401 只触发一次 refresh，三态结果区分失效/网络异常）；
/// - 请求前主动检查 token 即将过期则提前刷新；
/// - `{success,data}` 信封自动解包 + 统一 APIError；
/// - healthCheck() 验证网络栈端到端连通。
///
/// 移植自 apps/tabtin-ios 的成熟实现，去掉 DebugTools/L10n 耦合。
/// multipart 上传 / 带进度下载随 Phase 2（附件）补入。
actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder = JSONDecoder()
    private var baseURL: String
    private let sessionDelegate: RedirectPreservingDelegate
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "APIClient")

    private let keychain = KeychainService.shared
    /// Token 刷新属于登录会话级基础能力，由 APIClient 持有 single-flight Task。
    /// 页面任务只等待结果，页面消失不会把其他仍活跃请求依赖的刷新一起取消。
    private var tokenRefreshTask: Task<TokenRefreshAttemptResult, Never>?
    private static let refreshThreshold: TimeInterval = 5 * 60

    static func makeSessionConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        // TabTin API responses are mutable user state (会话摘要、未读、权限、任务状态等)。
        // 默认 URLSession 会按 HTTP 缓存规则复用旧 GET；冷启动时即使请求“成功”，也可能
        // 根本没有访问后端，让消息列表长期停在旧摘要。统一禁用 URLCache，实时断线后的
        // REST 追平才能拿到权威快照。
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return config
    }

    private init() {
        let config = Self.makeSessionConfiguration()
        DebugTools.instrument(config)
        sessionDelegate = RedirectPreservingDelegate()
        session = URLSession(configuration: config, delegate: sessionDelegate, delegateQueue: nil)
        baseURL = AppConfig.apiBaseURL
    }

    func updateBaseURL(_ url: String) {
        baseURL = url
    }

    /// 调试页改 API 地址后同步（每次请求前也会自动对齐 AppConfig）。
    func syncFromAppConfig() {
        baseURL = AppConfig.apiBaseURL
    }

    // MARK: - Generic request（统一 token 注入 + 401 自动刷新）

    func request<T: Decodable>(
        _ method: String,
        path: String,
        body: sending [String: Any]? = nil,
        query: [String: String]? = nil,
        headers: [String: String]? = nil,
        token: String? = nil,
        authentication: APIAuthenticationMode = .session,
        baseURLOverride: String? = nil,
        isRetry: Bool = false
    ) async throws -> T {
        syncFromAppConfig()
        try Task.checkCancellation()
        if authentication == .session && !isRetry {
            try await ensureValidToken()
        }
        try Task.checkCancellation()
        let effectiveToken: String?
        if authentication == .session {
            if let token {
                effectiveToken = token
            } else {
                effectiveToken = await resolvedAccessToken()
            }
        } else {
            effectiveToken = nil
        }

        guard var components = URLComponents(string: (baseURLOverride ?? baseURL) + path) else {
            throw APIError.invalidURL
        }
        if let query, !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        headers?.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        Self.applyClientBuildHeaders(to: &request)
        if let effectiveToken {
            request.setValue("Bearer \(effectiveToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        let diagnosticSpan = DiagnosticRecorder.beginHTTP(request, retry: isRetry)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: nil,
                responseBytes: nil,
                errorClass: String(describing: type(of: error))
            )
            throw Self.normalizedTransportError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: nil,
                responseBytes: data.count,
                errorClass: "InvalidHTTPResponse"
            )
            throw APIError.networkError(URLError(.badServerResponse))
        }
        await DiagnosticRecorder.shared.finishHTTP(
            diagnosticSpan,
            statusCode: httpResponse.statusCode,
            responseBytes: data.count
        )

        switch httpResponse.statusCode {
        case 200...299:
            return try autoUnwrap(data)
        case 401:
            let hasCredential = effectiveToken != nil
            guard authentication == .session, hasCredential else {
                throw Self.responseError(
                    statusCode: httpResponse.statusCode,
                    data: data,
                    fallbackMessage: "登录失败，请检查输入后重试"
                )
            }
            if Self.shouldAttemptTokenRefresh(
                authentication: authentication,
                hasCredential: hasCredential,
                isRetry: isRetry
            ) {
                switch await performTokenRefresh() {
                case .completed(.succeeded):
                    return try await self.request(
                        method,
                        path: path,
                        body: body,
                        query: query,
                        headers: headers,
                        token: nil,
                        authentication: authentication,
                        baseURLOverride: baseURLOverride,
                        isRetry: true
                    )
                case .completed(.tokenInvalid):
                    await triggerLogout()
                    throw APIError.unauthorized
                case .completed(.conflict), .completed(.temporarilyUnavailable):
                    throw APIError.networkError(URLError(.userAuthenticationRequired))
                case .cancelled:
                    throw CancellationError()
                }
            }
            await triggerLogout()
            throw APIError.unauthorized
        default:
            throw Self.responseError(statusCode: httpResponse.statusCode, data: data)
        }
    }

    nonisolated static func responseError(
        statusCode: Int,
        data: Data,
        fallbackMessage: String? = nil
    ) -> APIError {
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let message = payload?["message"] as? String ?? payload?["detail"] as? String
        // 保持全局语义：非 2xx → serverError(status, message)，不因任意 code
        // 改成 apiErrorWithCode（会丢掉 HTTP status）。有业务码时嵌入 [CODE]，
        // 供 SAVE_BUSY 等按码分流；裸 409 不含码时不得被当成忙。
        if let code = payloadBusinessCode(payload) {
            let base = message ?? fallbackMessage
            let composed: String
            if let base, base.contains(code) {
                composed = base
            } else if let base {
                composed = "[\(code)] \(base)"
            } else {
                composed = "[\(code)]"
            }
            return .serverError(statusCode, composed)
        }
        return .serverError(statusCode, message ?? fallbackMessage)
    }

    /// 从错误信封提取业务码（顶层或 `data` 内的 `code` / `error_code`）。
    nonisolated static func payloadBusinessCode(_ payload: [String: Any]?) -> String? {
        guard let payload else { return nil }
        func normalizedCode(_ raw: Any?) -> String? {
            if let code = raw as? String {
                let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            if let code = raw as? Int { return String(code) }
            return nil
        }

        if let code = normalizedCode(payload["error_code"]) { return code }
        if let data = payload["data"] as? [String: Any] {
            if let code = normalizedCode(data["error_code"]) { return code }
            if let code = normalizedCode(data["errorCode"]) { return code }
            if let code = normalizedCode(data["code"]) { return code }
        }
        return normalizedCode(payload["code"])
    }

    nonisolated static func shouldAttemptTokenRefresh(
        authentication: APIAuthenticationMode,
        hasCredential: Bool,
        isRetry: Bool
    ) -> Bool {
        authentication == .session && hasCredential && !isRetry
    }

    /// refresh token 读不到时：Keychain 被锁 → 暂不可用；确认无凭据 → token 失效。
    nonisolated static func missingRefreshTokenResult(keychainAccessible: Bool) -> TokenRefreshResult {
        keychainAccessible ? .tokenInvalid : .temporarilyUnavailable
    }

    /// URLSession 用 `URLError.cancelled`（-999）表达任务取消；Swift 并发也可能直接抛
    /// `CancellationError`。两者统一为后者，其余传输错误才包装成用户可见的网络错误。
    nonisolated static func normalizedTransportError(_ error: Error) -> Error {
        error.isCancellation ? CancellationError() : APIError.networkError(error)
    }

    // MARK: - Token refresh

    private func ensureValidToken() async throws {
        guard keychain.isAccessible() else { return }
        guard let _ = await resolvedAccessToken() else { return }
        guard let expiresAt = await resolvedExpiresAt() else { return }
        let remaining = expiresAt.timeIntervalSinceNow
        if remaining < Self.refreshThreshold {
            logger.info("Token expiring in \(Int(remaining))s, proactively refreshing")
            switch await performTokenRefresh() {
            case .completed(.succeeded):
                return
            case .completed(.tokenInvalid):
                await triggerLogout()
                throw APIError.unauthorized
            case .completed(.conflict), .completed(.temporarilyUnavailable):
                if remaining <= 0 {
                    throw APIError.networkError(URLError(.userAuthenticationRequired))
                }
            case .cancelled:
                throw CancellationError()
            }
        }
    }

    /// Provides a current access token to an embedded WebView while keeping
    /// the refresh token exclusively in the native Keychain.
    func embeddedWebCredential(forceRefresh: Bool = false) async -> EmbeddedWebCredentialResult {
        guard let _ = await resolvedAccessToken() else {
            if keychain.isAccessible() {
                await triggerLogout()
                return .unauthenticated
            }
            return .temporarilyUnavailable
        }

        let expiresAt = await resolvedExpiresAt()
        let remaining = expiresAt?.timeIntervalSinceNow
        if forceRefresh || remaining.map({ $0 < Self.refreshThreshold }) == true {
            switch await performTokenRefresh() {
            case .completed(.succeeded):
                break
            case .completed(.tokenInvalid):
                await triggerLogout()
                return .unauthenticated
            case .completed(.conflict), .completed(.temporarilyUnavailable):
                // A token rejected by the Web app must never be handed back as
                // if it were fresh. Preflight may still use a currently valid
                // token when proactive refresh failed transiently.
                if forceRefresh || remaining.map({ $0 <= 0 }) == true {
                    return .temporarilyUnavailable
                }
            case .cancelled:
                return .temporarilyUnavailable
            }
        }

        guard let accessToken = await resolvedAccessToken() else {
            if keychain.isAccessible() {
                await triggerLogout()
                return .unauthenticated
            }
            return .temporarilyUnavailable
        }
        let resolvedExpiry = await resolvedExpiresAt()
        return .ready(EmbeddedWebCredential(
            accessToken: accessToken,
            expiresAt: resolvedExpiry.map { Int($0.timeIntervalSince1970) }
        ))
    }

    /// 单飞刷新：并发 401 只触发一次。三态结果区分「token 失效需登出」与「网络异常不登出」。
    private func performTokenRefresh() async -> TokenRefreshAttemptResult {
        if let tokenRefreshTask {
            return await tokenRefreshTask.value
        }

        let task = Task { await self.executeTokenRefresh() }
        tokenRefreshTask = task
        let result = await task.value
        tokenRefreshTask = nil
        return result
    }

    /// Performs exactly one refresh request. Single-flight ownership and
    /// waiter fan-out stay in performTokenRefresh so every caller receives
    /// this exact result, including early invalid-session exits.
    private func executeTokenRefresh() async -> TokenRefreshAttemptResult {
        do {
            try Task.checkCancellation()
        } catch {
            return .cancelled
        }
        guard let refreshToken = await resolvedRefreshToken() else {
            let accessible = keychain.isAccessible()
            if !accessible {
                logger.warning("Refresh deferred: Keychain not accessible (device locked or background)")
            } else {
                logger.warning("No refresh token available")
            }
            return .completed(Self.missingRefreshTokenResult(keychainAccessible: accessible))
        }

        do {
            let body: [String: Any] = ["refresh_token": refreshToken]
            let bodyData = try JSONSerialization.data(withJSONObject: body)
            guard let url = URL(string: baseURL + Endpoints.Auth.refreshToken) else {
                return .completed(.temporarilyUnavailable)
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            Self.applyClientBuildHeaders(to: &request)
            request.httpBody = bodyData

            let diagnosticSpan = DiagnosticRecorder.beginHTTP(request)
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch {
                await DiagnosticRecorder.shared.finishHTTP(
                    diagnosticSpan,
                    statusCode: nil,
                    responseBytes: nil,
                    errorClass: String(describing: type(of: error))
                )
                throw error
            }
            guard let httpResponse = response as? HTTPURLResponse else {
                await DiagnosticRecorder.shared.finishHTTP(
                    diagnosticSpan,
                    statusCode: nil,
                    responseBytes: data.count,
                    errorClass: "InvalidHTTPResponse"
                )
                return .completed(.temporarilyUnavailable)
            }
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: httpResponse.statusCode,
                responseBytes: data.count
            )
            guard (200...299).contains(httpResponse.statusCode) else {
                let status = httpResponse.statusCode
                let errorCode = (try? decoder.decode(ApiEnvelope<RefreshTokenResponse>.self, from: data))?.code
                logger.warning("Refresh failed with status: \(status)")
                return .completed(Self.classifyRefreshFailure(statusCode: status, errorCode: errorCode))
            }

            let refreshResp: RefreshTokenResponse = try autoUnwrap(data)
            guard let rotatedRefreshToken = refreshResp.refreshToken,
                  !rotatedRefreshToken.isEmpty else {
                logger.error("Refresh response omitted rotated refresh token")
                return .completed(.temporarilyUnavailable)
            }
            // 用户可能在请求途中主动登出；旧 refresh token 已被清除/替换时禁止把旧响应
            // 写回，避免退出后被迟到响应重新恢复会话。优先比对内存镜像。
            let currentRefresh = await resolvedRefreshToken()
            guard currentRefresh == refreshToken else { return .cancelled }
            do {
                try keychain.saveTokenPair(
                    accessToken: refreshResp.accessToken,
                    refreshToken: rotatedRefreshToken,
                    expiresIn: refreshResp.expiresIn
                )
            } catch {
                // Keychain 写入失败（锁屏等）仍更新内存镜像，避免会话被误杀。
                logger.warning("Keychain save failed after refresh: \(error.localizedDescription)")
            }
            await updateAuthSession(
                accessToken: refreshResp.accessToken,
                refreshToken: rotatedRefreshToken,
                expiresIn: refreshResp.expiresIn
            )
            logger.info("Token refreshed successfully")
            return .completed(.succeeded)
        } catch {
            if error.isCancellation { return .cancelled }
            logger.error("Refresh exception: \(error.localizedDescription)")
            return .completed(.temporarilyUnavailable)
        }
    }

    nonisolated static func classifyRefreshFailure(
        statusCode: Int,
        errorCode: String? = nil
    ) -> TokenRefreshResult {
        if errorCode == "RATE_LIMITED" { return .temporarilyUnavailable }
        switch statusCode {
        case 401, 403, 404:
            return .tokenInvalid
        case 409:
            return .conflict
        default:
            return .temporarilyUnavailable
        }
    }

    func triggerManualRefresh() async -> TokenRefreshResult {
        switch await performTokenRefresh() {
        case .completed(let result):
            return result
        case .cancelled:
            // 公开接口历史上不抛错；保留签名，调用任务的 cancelled 标志仍然存在。
            return .temporarilyUnavailable
        }
    }

    @MainActor
    private func updateAuthSession(accessToken: String, refreshToken: String?, expiresIn: Int?) {
        AuthService.shared.updateSessionTokens(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresIn: expiresIn
        )
    }

    @MainActor
    private func resolvedAccessToken() -> String? {
        AuthService.shared.resolvedAccessToken()
    }

    @MainActor
    private func resolvedRefreshToken() -> String? {
        AuthService.shared.resolvedRefreshToken()
    }

    @MainActor
    private func resolvedExpiresAt() -> Date? {
        AuthService.shared.resolvedExpiresAt()
    }

    @MainActor
    private func triggerLogout() {
        AuthService.shared.expireSession()
    }

    /// 自动识别 `{success,data}` 信封并解包；否则直接解码 T。
    private func autoUnwrap<T: Decodable>(_ data: Data) throws -> T {
        if let envelope = try? decoder.decode(ApiEnvelope<T>.self, from: data) {
            guard envelope.success else {
                if let code = envelope.code {
                    throw APIError.apiErrorWithCode(code: code, message: envelope.message ?? "请求失败")
                }
                throw APIError.apiError(envelope.message ?? "请求失败")
            }
            if let inner = envelope.data { return inner }
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    // MARK: - Convenience

    func get<T: Decodable>(
        path: String,
        query: [String: String]? = nil,
        headers: [String: String]? = nil,
        token: String? = nil
    ) async throws -> T {
        try await request("GET", path: path, query: query, headers: headers, token: token)
    }

    func post<T: Decodable>(
        path: String,
        body: sending [String: Any]? = nil,
        query: [String: String]? = nil,
        headers: [String: String]? = nil,
        token: String? = nil,
        authentication: APIAuthenticationMode = .session
    ) async throws -> T {
        try await request(
            "POST",
            path: path,
            body: body,
            query: query,
            headers: headers,
            token: token,
            authentication: authentication
        )
    }

    func put<T: Decodable>(path: String, body: sending [String: Any]? = nil, token: String? = nil) async throws -> T {
        try await request("PUT", path: path, body: body, token: token)
    }

    func patch<T: Decodable>(
        path: String,
        body: sending [String: Any]? = nil,
        query: [String: String]? = nil,
        token: String? = nil
    ) async throws -> T {
        try await request("PATCH", path: path, body: body, query: query, token: token)
    }

    func delete<T: Decodable>(
        path: String,
        query: [String: String]? = nil,
        headers: [String: String]? = nil,
        token: String? = nil
    ) async throws -> T {
        try await request("DELETE", path: path, query: query, headers: headers, token: token)
    }

    // MARK: - Health check（验证网络栈端到端连通）

    struct HealthStatus: Sendable {
        let ok: Bool
        let statusCode: Int
        let body: String
    }

    func healthCheck() async -> HealthStatus {
        guard let url = URL(string: AppConfig.healthURL) else {
            return HealthStatus(ok: false, statusCode: -1, body: "invalid health URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        Self.applyClientBuildHeaders(to: &request)
        let diagnosticSpan = DiagnosticRecorder.beginHTTP(request)
        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: code >= 0 ? code : nil,
                responseBytes: data.count,
                errorClass: code >= 0 ? nil : "InvalidHTTPResponse"
            )
            let text = String(data: data, encoding: .utf8) ?? ""
            return HealthStatus(ok: (200...299).contains(code), statusCode: code, body: text)
        } catch {
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: nil,
                responseBytes: nil,
                errorClass: String(describing: type(of: error))
            )
            logger.warning("health check failed: \(error.localizedDescription)")
            return HealthStatus(ok: false, statusCode: -1, body: error.localizedDescription)
        }
    }

    private static func applyClientBuildHeaders(to request: inout URLRequest) {
        request.setValue("ios", forHTTPHeaderField: "X-Client-Type")
        request.setValue(AppConfig.appVersion, forHTTPHeaderField: "X-Client-Version")
        if let gitSha = Bundle.main.object(forInfoDictionaryKey: "TABTINGitSHA") as? String,
           !gitSha.isEmpty {
            request.setValue(gitSha, forHTTPHeaderField: "X-Client-Source-Sha")
        }
    }
}

// MARK: - Redirect Auth Preservation

/// URLSession 默认在 301/302 重定向时剥离 Authorization 头（RFC 7235）。
/// Django APPEND_SLASH 对缺尾斜杠路径返回 301，会丢认证信息触发误登出。
/// 同域重定向自动保留 Authorization 头。移植自 apps/tabtin-ios。
private func preserveAuthOnSameHostRedirect(
    task: URLSessionTask,
    newRequest: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
) {
    guard let originalRequest = task.originalRequest,
          let originalHost = originalRequest.url?.host,
          let redirectHost = newRequest.url?.host,
          originalHost == redirectHost else {
        completionHandler(newRequest)
        return
    }
    var redirectRequest = newRequest
    if let authHeader = originalRequest.value(forHTTPHeaderField: "Authorization"),
       newRequest.value(forHTTPHeaderField: "Authorization") == nil {
        redirectRequest.setValue(authHeader, forHTTPHeaderField: "Authorization")
    }
    completionHandler(redirectRequest)
}

private final class RedirectPreservingDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        preserveAuthOnSameHostRedirect(task: task, newRequest: request, completionHandler: completionHandler)
    }
}
