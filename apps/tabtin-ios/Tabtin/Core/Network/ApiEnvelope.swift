import Foundation

/// 后端统一响应信封 `{ success, data, message, code|error_code }`。
/// 所有字段 immutable，仅作 JSON 解码快照跨 actor 传递，故 `@unchecked Sendable`。
/// 移植自 apps/tabtin-ios。
struct ApiEnvelope<T: Decodable>: Decodable, @unchecked Sendable {
    let success: Bool
    let data: T?
    let message: String?
    let code: String?

    enum CodingKeys: String, CodingKey {
        case success, data, message, code
        case errorCode = "error_code"
    }

    private enum ErrorDataCodingKeys: String, CodingKey {
        case code
        case snakeErrorCode = "error_code"
        case camelErrorCode = "errorCode"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = try container.decodeIfPresent(Bool.self, forKey: .success) ?? true
        message = try container.decodeIfPresent(String.self, forKey: .message)
        // code 兼容两种后端约定：字符串（users/auth 用 "SUCCESS"）与整数
        // （tabchat ApiResponse.code=200）。统一归一为字符串。
        func stringOrInt(_ key: CodingKeys) -> String? {
            if let text = try? container.decode(String.self, forKey: key) { return text }
            if let number = try? container.decode(Int.self, forKey: key) { return String(number) }
            return nil
        }
        let topLevelCode = stringOrInt(.code) ?? stringOrInt(.errorCode)

        if success {
            data = try container.decodeIfPresent(T.self, forKey: .data)
            code = topLevelCode
        } else {
            // 失败信封的 `data` 是错误元数据，不是调用方期待的成功模型。
            // Go IM 控制面会返回 `{ data: { error_code: ... }, code: 403 }`；
            // 若继续按 T 解码，会把套餐限制覆盖成误导性的“数据解析失败”。
            data = nil
            let errorData = try? container.nestedContainer(
                keyedBy: ErrorDataCodingKeys.self,
                forKey: .data
            )
            func nestedStringOrInt(_ key: ErrorDataCodingKeys) -> String? {
                if let text = try? errorData?.decode(String.self, forKey: key) { return text }
                if let number = try? errorData?.decode(Int.self, forKey: key) { return String(number) }
                return nil
            }
            code = nestedStringOrInt(.snakeErrorCode)
                ?? nestedStringOrInt(.camelErrorCode)
                ?? nestedStringOrInt(.code)
                ?? topLevelCode
        }
    }
}
