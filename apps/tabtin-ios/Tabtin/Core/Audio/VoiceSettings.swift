import Foundation
import os

private let logger = Logger(subsystem: "com.tabtin.mobile", category: "VoiceSettings")

/// 语音模块用户设置，持久化到 UserDefaults。
///
/// 管理四层语音增强能力：
/// 1. 平台热词（自动启用，不可关闭）
/// 2. 应用上下文（自动提取 workspace / space / 对话历史）
/// 3. 自定义词库（用户手动添加的热词，提升识别概率）
/// 4. 替换词（用户定义的纠正映射，确定性文本替换）
@MainActor @Observable
final class VoiceSettings {
    static let shared = VoiceSettings()

    // MARK: - 平台热词（始终启用）

    /// 平台级热词，所有用户共享。
    /// 后续可改为从服务端动态拉取。
    static let platformHotwords: [String] = [
        "TabTin", "TabData", "TabDoc", "TabSlide",
        "Agentspace", "Agent", "Space",
        "RAG", "Prompt", "Skill", "Memo", "Composer", "Crawler",
    ]

    // MARK: - 应用上下文

    /// 启用应用上下文增强（自动提取 workspace 名称、space 名称等作为热词）
    var enableAppContext: Bool {
        didSet { Self.save(enableAppContext, forKey: Keys.enableAppContext) }
    }

    /// 启用对话上下文传递（将最近的对话历史作为 ASR context）
    var enableDialogContext: Bool {
        didSet { Self.save(enableDialogContext, forKey: Keys.enableDialogContext) }
    }

    // MARK: - 自定义词库

    /// 用户自定义热词列表（提升识别概率）
    var customHotwords: [String] {
        didSet { Self.save(customHotwords, forKey: Keys.customHotwords) }
    }

    // MARK: - 替换词

    /// 用户替换词映射：["错误形式": "正确形式"]
    /// 在 ASR 返回文本后做确定性替换。
    var replacementRules: [ReplacementRule] {
        didSet { Self.saveRules(replacementRules) }
    }

    // MARK: - Init

    private init() {
        let defaults = UserDefaults.standard
        self.enableAppContext = defaults.object(forKey: Keys.enableAppContext) as? Bool ?? true
        self.enableDialogContext = defaults.object(forKey: Keys.enableDialogContext) as? Bool ?? true
        self.customHotwords = defaults.stringArray(forKey: Keys.customHotwords) ?? []
        self.replacementRules = Self.loadRules()
    }

    // MARK: - 合并热词

    /// 合并所有热词来源，返回去重后的完整热词列表。
    func mergedHotwords(
        appHotwords: [String]? = nil,
        sessionHotwords: [String]? = nil
    ) -> [String]? {
        var all: [String] = Self.platformHotwords

        if enableAppContext, let app = appHotwords {
            all.append(contentsOf: app)
        }

        all.append(contentsOf: customHotwords)

        if let session = sessionHotwords {
            all.append(contentsOf: session)
        }

        let unique = Array(NSOrderedSet(array: all.filter { !$0.isEmpty })) as? [String] ?? []
        return unique.isEmpty ? nil : unique
    }

    // MARK: - 文本后处理

    /// 对 ASR 识别文本应用用户替换词规则。
    func applyReplacements(_ text: String) -> String {
        guard !replacementRules.isEmpty else { return text }

        var result = text
        for rule in replacementRules where rule.isEnabled && !rule.from.isEmpty {
            result = result.replacingOccurrences(of: rule.from, with: rule.to)
        }
        return result
    }

    // MARK: - Limits

    static let maxCustomHotwords = 100
    static let maxReplacementRules = 50

    // MARK: - CRUD

    func addHotword(_ word: String) {
        let trimmed = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !customHotwords.contains(trimmed) else { return }
        guard customHotwords.count < Self.maxCustomHotwords else { return }
        customHotwords.append(trimmed)
    }

    func removeHotword(at index: Int) {
        guard customHotwords.indices.contains(index) else { return }
        customHotwords.remove(at: index)
    }

    func addReplacementRule(from: String, to: String) {
        let trimmedFrom = from.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTo = to.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedFrom.isEmpty else { return }
        guard !replacementRules.contains(where: { $0.from == trimmedFrom }) else { return }
        guard replacementRules.count < Self.maxReplacementRules else { return }
        replacementRules.append(ReplacementRule(from: trimmedFrom, to: trimmedTo))
    }

    func removeReplacementRule(at index: Int) {
        guard replacementRules.indices.contains(index) else { return }
        replacementRules.remove(at: index)
    }

    func toggleReplacementRule(at index: Int) {
        guard replacementRules.indices.contains(index) else { return }
        replacementRules[index].isEnabled.toggle()
    }
}

// MARK: - ReplacementRule

extension VoiceSettings {
    struct ReplacementRule: Codable, Identifiable, Sendable {
        let id: UUID
        var from: String
        var to: String
        var isEnabled: Bool

        init(from: String, to: String, isEnabled: Bool = true) {
            self.id = UUID()
            self.from = from
            self.to = to
            self.isEnabled = isEnabled
        }
    }
}

// MARK: - Persistence

private extension VoiceSettings {
    enum Keys {
        static let enableAppContext = "tt_voice_enable_app_context"
        static let enableDialogContext = "tt_voice_enable_dialog_context"
        static let customHotwords = "tt_voice_custom_hotwords"
        static let replacementRules = "tt_voice_replacement_rules"
    }

    static func save(_ value: Bool, forKey key: String) {
        UserDefaults.standard.set(value, forKey: key)
    }

    static func save(_ value: [String], forKey key: String) {
        UserDefaults.standard.set(value, forKey: key)
    }

    static func saveRules(_ rules: [ReplacementRule]) {
        guard let data = try? JSONEncoder().encode(rules) else { return }
        UserDefaults.standard.set(data, forKey: Keys.replacementRules)
    }

    static func loadRules() -> [ReplacementRule] {
        guard let data = UserDefaults.standard.data(forKey: Keys.replacementRules),
              let rules = try? JSONDecoder().decode([ReplacementRule].self, from: data) else {
            return []
        }
        return rules
    }
}
