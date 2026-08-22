import Foundation

/// 语音模块统一配置。
///
/// 跨场景复用（Chat / Memo / 未来更多场景），所有语音功能的参数由此统一管控。
/// 后端和其他平台（Electron / Android / 鸿蒙）遵循相同的参数协议。
struct VoiceConfig: Sendable {

    // MARK: - 场景预设

    /// 使用场景，影响默认行为和 ASR 参数选择。
    enum Scenario: String, Sendable {
        case chat       // 聊天语音输入：追求低延迟、准确率
        case memo       // Memo 语音录制：追求高准确率、长时录制
        case dictation  // 通用听写：平衡模式
    }

    let scenario: Scenario

    // MARK: - 录制参数

    /// 最大录音时长（秒）
    let maxDuration: TimeInterval

    // MARK: - ASR 参数

    /// WebSocket 端点：bigmodel / bigmodel_async / bigmodel_nostream
    let wsEndpoint: String

    /// 启用二遍识别（仅 bigmodel_async）
    let enableNonstream: Bool

    /// 启用首字加速
    let enableAccelerateText: Bool

    /// 首字加速率 0-20，值越大出字越快
    let accelerateScore: Int

    /// 启用情绪检测
    let enableEmotionDetection: Bool

    /// 对话上下文（JSON 字符串），传入对话历史提升识别准确率。
    /// 格式：`{"context_type":"dialog_ctx","context_data":[{"text":"..."},...]}`
    var context: String?

    /// 热词列表，提升专业场景识别准确率。
    var hotwords: [String]?

    /// 识别语言（仅 nostream 支持），空为自动识别中英文。
    let language: String

    // MARK: - Factory

    /// 聊天场景预设：低延迟、首字加速、情绪检测
    static func chat(
        context: String? = nil,
        hotwords: [String]? = nil
    ) -> VoiceConfig {
        VoiceConfig(
            scenario: .chat,
            maxDuration: 120,
            wsEndpoint: "bigmodel_async",
            enableNonstream: true,
            enableAccelerateText: true,
            accelerateScore: 10,
            enableEmotionDetection: true,
            context: context,
            hotwords: hotwords,
            language: ""
        )
    }

    /// Memo 场景预设：高准确率、长时录制
    static func memo(
        hotwords: [String]? = nil
    ) -> VoiceConfig {
        VoiceConfig(
            scenario: .memo,
            maxDuration: 300,
            wsEndpoint: "bigmodel_async",
            enableNonstream: true,
            enableAccelerateText: false,
            accelerateScore: 0,
            enableEmotionDetection: false,
            context: nil,
            hotwords: hotwords,
            language: ""
        )
    }

    /// 构建发给后端的 ASR 参数 payload。
    func buildASRPayload(audioFormat: String = "pcm", sampleRate: Int = 16000) -> [String: Any] {
        var payload: [String: Any] = [
            "audio_format": audioFormat,
            "sample_rate": sampleRate,
            "provider": "bytedance",
            "ws_endpoint": wsEndpoint,
            "enable_itn": true,
            "enable_punc": true,
            "enable_ddc": true,
            "show_utterances": true,
        ]

        if wsEndpoint == "bigmodel_async" && enableNonstream {
            payload["enable_nonstream"] = true
        }

        if enableAccelerateText {
            payload["enable_accelerate_text"] = true
            payload["accelerate_score"] = min(20, max(0, accelerateScore))
        }

        if enableEmotionDetection {
            payload["enable_emotion_detection"] = true
        }

        if !language.isEmpty {
            payload["language"] = language
        }

        // context 和 hotwords 都通过 corpus.context 字段传递，需合并为一个 JSON 字符串。
        // 字节 ASR 支持 hotwords 和 dialog_ctx 在同一个 context JSON 中共存。
        var contextDict: [String: Any] = [:]

        if let context, !context.isEmpty,
           let data = context.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            contextDict = parsed
        }

        if let hotwords, !hotwords.isEmpty {
            contextDict["hotwords"] = hotwords.map { ["word": $0] }
        }

        if !contextDict.isEmpty,
           let jsonData = try? JSONSerialization.data(withJSONObject: contextDict),
           let jsonStr = String(data: jsonData, encoding: .utf8) {
            payload["context"] = jsonStr
        }

        return payload
    }

    /// 从 workspace / space 元数据中提取热词。
    /// 收集 workspace 名称、space 名称、space keywords、space tags，去重后返回。
    static func extractHotwords(
        workspaceName: String? = nil,
        spaceName: String? = nil,
        spaceKeywords: [String]? = nil,
        spaceTags: [String]? = nil
    ) -> [String]? {
        var words: [String] = []
        if let name = workspaceName, !name.isEmpty { words.append(name) }
        if let name = spaceName, !name.isEmpty { words.append(name) }
        if let kw = spaceKeywords { words.append(contentsOf: kw) }
        if let tags = spaceTags { words.append(contentsOf: tags) }

        let unique = Array(NSOrderedSet(array: words.filter { !$0.isEmpty })) as? [String] ?? []
        return unique.isEmpty ? nil : unique
    }

    /// 从对话消息列表构建 context JSON 字符串。
    /// 取最近 maxRounds 轮 user/assistant 对话，格式符合字节跳动 ASR context 规范。
    /// 过滤 system 消息，截断过长内容以控制 payload 大小。
    static func buildDialogContext(
        from messages: [(role: String, content: String)],
        maxRounds: Int = 10,
        maxContentLength: Int = 200
    ) -> String? {
        let dialogMessages = messages.filter { $0.role == "user" || $0.role == "assistant" }
        let recent = dialogMessages.suffix(maxRounds)
        guard !recent.isEmpty else { return nil }

        let contextData = recent.map { msg -> [String: String] in
            let prefix = msg.role == "user" ? "用户" : "助手"
            let content: String
            if msg.content.count > maxContentLength {
                content = String(msg.content.prefix(maxContentLength)) + "..."
            } else {
                content = msg.content
            }
            return ["text": "\(prefix): \(content)"]
        }

        let context: [String: Any] = [
            "context_type": "dialog_ctx",
            "context_data": contextData,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: context),
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }
}

// MARK: - ASR Emotion

/// ASR 情绪检测结果
enum ASREmotionTag: String, Sendable {
    case angry
    case happy
    case neutral
    case sad
    case surprise

    var emoji: String {
        switch self {
        case .angry:    return "😠"
        case .happy:    return "😊"
        case .neutral:  return "😐"
        case .sad:      return "😢"
        case .surprise: return "😮"
        }
    }

    var label: String {
        switch self {
        case .angry:    return "生气"
        case .happy:    return "开心"
        case .neutral:  return "平静"
        case .sad:      return "难过"
        case .surprise: return "惊讶"
        }
    }
}
