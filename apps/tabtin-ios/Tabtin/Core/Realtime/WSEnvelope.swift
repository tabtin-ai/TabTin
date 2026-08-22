import Foundation

// MARK: - AnyCodable

/// `@unchecked Sendable` 安全承诺范围：
/// - **decode 路径**（`init(from:)`，line 14-33）：解析自 JSON 的 value 必为 Bool / Int / Double /
///   String / `[Any]`（其中元素被规范化为 Bool/Int/Double/String/`[Any]`/`[String:Any]` 之一）/
///   `[String: Any]`（同样递归规范化）/ NSNull。这些都是 value type / 不可变，跨线程只读安全。
/// - **`init(_ value: Any)` 直接构造路径**（line 12）：调用方可传入任意运行时类型。**如果传入
///   NSMutableDictionary / NSMutableArray 等 Foundation 可变容器**，跨线程 mutate 这些容器内部
///   会引起 race —— 此情形不在 `@unchecked Sendable` 安全承诺内。
/// - 本类型当前仅作为 WSEnvelope.payload / payload 转换的不可变快照传递，未在跨 actor 边界后
///   被人 mutate（grep 确认无 `payload[k]?.value as? NSMutableDictionary` 这类 down-cast 修改）。
struct AnyCodable: Codable, Hashable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        // decode 路径只会产出 Int，但 `init(_ value: Any)` 直接构造时调用方可能传
        // Int64（记录 version 就是 Int64）。少了这些分支会落进 default 被静默写成
        // null，数据丢了还不报错。
        case let int as Int64:
            try container.encode(int)
        case let int as Int32:
            try container.encode(int)
        case let uint as UInt:
            try container.encode(uint)
        case let uint as UInt64:
            try container.encode(uint)
        case let double as Double:
            try container.encode(double)
        case let float as Float:
            try container.encode(float)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        String(describing: lhs.value) == String(describing: rhs.value)
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(String(describing: value))
    }

    var stringValue: String? { value as? String }
    var intValue: Int? {
        if let i = value as? Int { return i }
        if let d = value as? Double, let i = Int(exactly: d) { return i }
        if let s = value as? String { return Int(s) }
        return nil
    }
    var doubleValue: Double? {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let s = value as? String { return Double(s) }
        return nil
    }
    var boolValue: Bool? { value as? Bool }
    var dictValue: [String: Any]? { value as? [String: Any] }
    var arrayValue: [Any]? { value as? [Any] }
}

// MARK: - WSEnvelope

/// 字段类型全部 Sendable（含已加 `@unchecked Sendable` 的 `AnyCodable`），struct value type 即便
/// 含 `var` 字段也 Sendable（每次跨边界传递都是值复制，写者修改不影响其他持有者）。
struct WSEnvelope: Codable, Sendable {
    let v: Int
    let type: String
    let requestId: String
    let ts: Int
    let deviceId: String
    let role: String
    let payload: [String: AnyCodable]

    var eventId: String?
    var topic: String?
    var replyTo: String?
    var threadId: String?
    var traceId: String?
    var organizationId: String?
    var sessionId: String?
    var tableId: String?
    var instanceId: String?
    var resourceType: String?
    var resourceId: String?
    var spaceId: String?
    var seq: Int?

    enum CodingKeys: String, CodingKey {
        case v, type, ts, role, payload
        case requestId = "request_id"
        case deviceId = "device_id"
        case eventId = "event_id"
        case topic = "_topic"
        case replyTo = "reply_to"
        case threadId = "thread_id"
        case traceId = "trace_id"
        case organizationId = "organization_id"
        case sessionId = "session_id"
        case tableId = "table_id"
        case instanceId = "instance_id"
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case spaceId = "space_id"
        case seq = "_seq"
    }

    var payloadDict: [String: Any] {
        payload.mapValues(\.value)
    }

    func payloadString(_ key: String) -> String? {
        if let value = payload[key]?.stringValue { return value }
        switch key {
        case "resource_type": return resourceType
        case "resource_id": return resourceId
        case "space_id": return spaceId
        case "organization_id": return organizationId
        default: return nil
        }
    }

    func payloadDisplayString(_ key: String) -> String? {
        guard let value = payload[key]?.value else { return nil }
        switch value {
        case let string as String:
            return string
        case let int as Int:
            return String(int)
        case let double as Double:
            if double.rounded() == double {
                return String(Int(double))
            }
            return String(double)
        case let bool as Bool:
            return bool ? "true" : "false"
        default:
            return nil
        }
    }

    func payloadBool(_ key: String) -> Bool? {
        if let b = payload[key]?.boolValue { return b }
        if let i = payload[key]?.intValue { return i != 0 }
        return nil
    }

    func payloadInt(_ key: String) -> Int? {
        payload[key]?.intValue
    }

    func payloadDouble(_ key: String) -> Double? {
        payload[key]?.doubleValue
    }

    func payloadDict(_ key: String) -> [String: Any]? {
        payload[key]?.dictValue
    }
}

// MARK: - WSEnvelope Builder

extension WSEnvelope {
    /// 默认随机 8 字符前缀仅用于无需相关 ACK 的发包；如需通过 request_id 关联回包，
    /// 必须显式传入完整 UUID（避免在并发请求下碰撞）。
    static func build(
        type: String,
        deviceId: String,
        payload: [String: Any],
        organizationId: String? = nil,
        role: String = "mobile",
        replyTo: String? = nil,
        threadId: String? = nil,
        traceId: String? = nil,
        requestId: String? = nil
    ) -> WSEnvelope {
        WSEnvelope(
            v: 1,
            type: type,
            requestId: requestId ?? "req_\(UUID().uuidString.prefix(8))",
            ts: Int(Date().timeIntervalSince1970),
            deviceId: deviceId,
            role: role,
            payload: payload.mapValues { AnyCodable($0) },
            replyTo: replyTo,
            threadId: threadId,
            traceId: traceId,
            organizationId: organizationId
        )
    }

    func toData() throws -> Data {
        try JSONEncoder().encode(self)
    }
}

// MARK: - Typed Wire Payload Decoding

extension WSEnvelope {
    /// 把 payload 里某个字段解码成强类型 wire DTO（生成自 `@tabtin/wire-codegen`）。
    ///
    /// 用途：消费侧（StreamManager 等）把 `payload[...] as? String` 字典手解升级为
    /// 类型安全解码——字段名 / 类型 / discriminated union 穷尽由 zod SSoT 保证，
    /// schema 变更直接编译期暴露，不再运行时静默丢字段。
    ///
    /// 失败返回 `nil`（不抛）：流式部分态（如 content_block_start 的 thinking 块
    /// 尚未带 signature）或上游历史字段名不满足终态 schema 时，主流程不应中断，
    /// 调用方据此回退字典兜底。
    ///
    /// 实现：`AnyCodable` 本身 Codable —— 先把目标字段 encode 回 `Data` 再 decode
    /// 成 `T`，全程走 Codable，不经 `JSONSerialization`。`encoder` / `decoder` 由
    /// 调用方传入复用实例（高频事件如 content_block_delta 避免反复构造）。
    func decodePayloadField<T: Decodable>(
        _ key: String,
        as type: T.Type,
        encoder: JSONEncoder,
        decoder: JSONDecoder
    ) -> T? {
        guard let value = payload[key],
              let data = try? encoder.encode(value),
              let decoded = try? decoder.decode(T.self, from: data)
        else { return nil }
        return decoded
    }

    /// 把**整个 payload** 解码成强类型 wire DTO。
    ///
    /// 用于 HITL 类事件（`ask_user_required` / `approval_requested` / `plan_proposal` 等），
    /// 其 DTO 字段直接平铺在 payload 根下（非某个子字段）。`payload` 本身是 `[String: AnyCodable]`，
    /// AnyCodable 可 encode 回 JSON 再 decode 成 T；失败返回 nil（schema 不匹配时调用方兜底）。
    func decodePayload<T: Decodable>(
        as type: T.Type,
        encoder: JSONEncoder = JSONEncoder(),
        decoder: JSONDecoder = JSONDecoder()
    ) -> T? {
        guard let data = try? encoder.encode(payload),
              let decoded = try? decoder.decode(T.self, from: data)
        else { return nil }
        return decoded
    }
}
