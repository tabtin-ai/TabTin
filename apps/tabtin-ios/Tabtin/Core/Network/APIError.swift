import Foundation

/// 网络层统一错误类型。Phase 0 先内联中文文案；Phase 1 接入 L10n 后替换为本地化键。
enum APIError: LocalizedError {
    case invalidURL
    case unauthorized
    case serverError(Int, String?)
    case decodingError(Error)
    case networkError(Error)
    case apiError(String)
    case apiErrorWithCode(code: String, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "无效的请求地址"
        case .unauthorized: return "登录已过期，请重新登录"
        case .serverError(let code, let msg): return msg ?? "服务器错误（\(code)）"
        case .decodingError(let err): return "数据解析失败：\(err.localizedDescription)"
        case .networkError(let err):
            if let urlError = err as? URLError {
                switch urlError.code {
                case .notConnectedToInternet: return "网络未连接"
                case .timedOut: return "网络请求超时"
                case .networkConnectionLost: return "网络连接中断"
                case .cannotConnectToHost, .cannotFindHost: return "无法连接服务器"
                case .secureConnectionFailed: return "安全连接失败"
                default: return "网络异常，请稍后重试"
                }
            }
            return "网络异常，请稍后重试"
        case .apiError(let msg): return msg
        case .apiErrorWithCode(let code, let msg): return "[\(code)] \(msg)"
        }
    }

    /// 业务错误码：`apiErrorWithCode`，或 `responseError` 嵌入的 `[CODE]` 前缀。
    var businessCode: String? {
        switch self {
        case .apiErrorWithCode(let code, _):
            return code
        case .serverError(_, let message):
            return Self.bracketBusinessCode(from: message)
        default:
            return nil
        }
    }

    private static func bracketBusinessCode(from message: String?) -> String? {
        guard let message, message.hasPrefix("["),
              let end = message.firstIndex(of: "]") else { return nil }
        let code = String(message[message.index(after: message.startIndex)..<end])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return code.isEmpty ? nil : code
    }
}

extension Error {
    /// 仅识别真实 HTTP 404；业务错误与其它服务端故障不能被兼容层误吞。
    var isHTTPNotFound: Bool {
        guard let apiError = self as? APIError,
              case .serverError(let status, _) = apiError else { return false }
        return status == 404
    }

    /// 已读回执的永久失败：400 参数无效、404 会话不存在、409 水位游标过期。
    /// 同一 sequence/revision 重放不会成功；outbox 应本地结算该水位，避免换 mutationId 再入队。
    var isTerminalSessionReadAckFailure: Bool {
        guard let apiError = self as? APIError,
              case .serverError(let status, _) = apiError else { return false }
        return status == 400 || status == 404 || status == 409
    }

    /// 统一识别 Swift 并发与 URLSession 的取消语义。
    ///
    /// APIClient 早期会把 URLSession 错误包装成 `APIError.networkError`，因此这里也递归检查
    /// 底层错误，避免调用方把用户离开页面、视图重建等正常取消展示成“网络异常”。
    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let urlError = self as? URLError, urlError.code == .cancelled { return true }
        if let apiError = self as? APIError,
           case let .networkError(underlyingError) = apiError {
            return underlyingError.isCancellation
        }

        let nsError = self as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }
}
