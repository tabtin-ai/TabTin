import Foundation

/// 服务端下发的模型上下文档位。
///
/// 这里只保留 catalog 已公开的展示字段；不携带任何 provider header 或计费私密配置。
struct ChatModelContextTier: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let isDefault: Bool
    let maxInputTokens: Int?
    let tags: [String]
    let hasExtraHeaders: Bool
    let isUserSelectable: Bool

    enum CodingKeys: String, CodingKey {
        case id, label, tags
        case isDefault = "is_default"
        case maxInputTokens = "max_input_tokens"
        case hasExtraHeaders = "has_extra_headers"
        case isUserSelectable = "is_user_selectable"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        maxInputTokens = try c.decodeIfPresent(Int.self, forKey: .maxInputTokens)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        hasExtraHeaders = try c.decodeIfPresent(Bool.self, forKey: .hasExtraHeaders) ?? false
        isUserSelectable = try c.decodeIfPresent(Bool.self, forKey: .isUserSelectable) ?? false
    }
}

/// Catalog `runtime_profile.thinking` 的 canonical 思考强度档。
///
/// 普通 Composer UI 只读写 `thinking_mode`，不写 `reasoning_effort`，也不混用 SubAgent `thinking_level`。
enum ChatModelThinkingMode: String, Codable, Hashable, CaseIterable, Sendable {
    case off
    case standard
    case deep

    var displayLabel: String {
        switch self {
        case .off: return "关闭"
        case .standard: return "标准"
        case .deep: return "深度"
        }
    }

    static func parse(_ raw: String?) -> ChatModelThinkingMode? {
        guard let normalized = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !normalized.isEmpty
        else { return nil }
        return ChatModelThinkingMode(rawValue: normalized)
    }
}

struct ChatModelThinkingCapability: Equatable, Hashable, Sendable {
    let modes: [ChatModelThinkingMode]
    let defaultMode: ChatModelThinkingMode
}

/// Catalog `runtime_profile.thinking`；`supported == false` 或 modes 为空时不展示思考强度。
struct ChatModelRuntimeProfileThinking: Decodable, Hashable, Sendable {
    let supported: Bool
    let modes: [ChatModelThinkingMode]
    let defaultMode: ChatModelThinkingMode?

    enum CodingKeys: String, CodingKey {
        case supported, modes
        case defaultMode = "default_mode"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decodeIfPresent(Bool.self, forKey: .supported) ?? false
        let rawModes = try c.decodeIfPresent([String].self, forKey: .modes) ?? []
        modes = rawModes.compactMap(ChatModelThinkingMode.parse)
        defaultMode = ChatModelThinkingMode.parse(
            try c.decodeIfPresent(String.self, forKey: .defaultMode)
        )
    }
}

struct ChatModelRuntimeProfile: Decodable, Hashable, Sendable {
    let thinking: ChatModelRuntimeProfileThinking?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thinking = try c.decodeIfPresent(ChatModelRuntimeProfileThinking.self, forKey: .thinking)
    }

    private enum CodingKeys: String, CodingKey {
        case thinking
    }
}

/// Catalog 中与文档直传有关的能力子集。
///
/// 保留嵌套结构是为了兼容服务端的 `resolved_capabilities` / `capabilities_config`，
/// 同时避免把开放字典带进 `ChatModel`，破坏 Hashable / Sendable 约束。
struct ChatModelDocumentInputCapabilities: Decodable, Hashable, Sendable {
    let supportsDocumentInput: Bool?

    enum CodingKeys: String, CodingKey {
        case supportsDocumentInput = "supports_document_input"
    }
}

/// Session `model_param_overrides` 的 v2 读写面。
///
/// 普通 Composer UI 只改 `thinking_mode`，但 PUT 会整表替换，因此运输层必须
/// 保留桌面端已写的 `performance_profile` 等非思考意图键。
struct ChatModelParamOverrides: Codable, Hashable, Sendable {
    let version: Int?
    let thinkingMode: ChatModelThinkingMode?
    let performanceProfile: String?

    enum CodingKeys: String, CodingKey {
        case version = "v"
        case thinkingMode = "thinking_mode"
        case performanceProfile = "performance_profile"
    }

    init(
        version: Int? = 2,
        thinkingMode: ChatModelThinkingMode?,
        performanceProfile: String? = nil
    ) {
        self.version = version
        self.thinkingMode = thinkingMode
        self.performanceProfile = performanceProfile?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .nilIfEmpty
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version)
        thinkingMode = ChatModelThinkingMode.parse(
            try c.decodeIfPresent(String.self, forKey: .thinkingMode)
        )
        performanceProfile = try c.decodeIfPresent(String.self, forKey: .performanceProfile)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .nilIfEmpty
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version ?? 2, forKey: .version)
        try c.encodeIfPresent(thinkingMode?.rawValue, forKey: .thinkingMode)
        try c.encodeIfPresent(performanceProfile, forKey: .performanceProfile)
    }

    /// PUT `/model-params` 的 body；整表替换语义下保留既有非思考键。
    var transportDictionary: [String: Any] {
        var payload: [String: Any] = ["v": version ?? 2]
        if let thinkingMode {
            payload["thinking_mode"] = thinkingMode.rawValue
        }
        if let performanceProfile {
            payload["performance_profile"] = performanceProfile
        }
        return payload
    }

    func mergingThinkingMode(_ mode: ChatModelThinkingMode) -> ChatModelParamOverrides {
        ChatModelParamOverrides(
            version: 2,
            thinkingMode: mode,
            performanceProfile: performanceProfile
        )
    }

    static func thinkingModeV2(
        _ mode: ChatModelThinkingMode,
        preserving existing: ChatModelParamOverrides? = nil
    ) -> ChatModelParamOverrides {
        (existing ?? ChatModelParamOverrides(thinkingMode: nil))
            .mergingThinkingMode(mode)
    }
}

/// 可发送的聊天模型（`/services/llm/catalog` 目录项）。
///
/// 字段与 Electron 的 catalog 消费面保持同源；UI 只展示服务端已下发的能力与描述，
/// 不将目录中不存在的模型或不可用原因猜测为用户可见状态。
struct ChatModel: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let modelName: String?
    let displayName: String
    let provider: String
    let providerDisplayName: String?
    let providerScope: String?
    let description: String?
    let supportsFunctionCalling: Bool?
    let supportsVision: Bool?
    private let declaredSupportsDocumentInput: Bool?
    private let resolvedCapabilities: ChatModelDocumentInputCapabilities?
    private let capabilitiesConfig: ChatModelDocumentInputCapabilities?
    let contextWindowTokens: Int?
    let maxInputTokens: Int?
    let contextTiers: [ChatModelContextTier]
    let runtimeProfile: ChatModelRuntimeProfile?
    let usageHint: String?
    var promotionCredit: PromotionCredit?
    var isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, provider, description
        case modelName = "model_name"
        case displayName = "display_name"
        case providerDisplayName = "provider_display_name"
        case providerScope = "provider_scope"
        case supportsFunctionCalling = "supports_function_calling"
        case supportsVision = "supports_vision"
        case declaredSupportsDocumentInput = "supports_document_input"
        case resolvedCapabilities = "resolved_capabilities"
        case capabilitiesConfig = "capabilities_config"
        case contextWindowTokens = "context_window_tokens"
        case maxInputTokens = "max_input_tokens"
        case contextTiers = "context_tiers"
        case runtimeProfile = "runtime_profile"
        case usageHint = "usage_hint"
        case promotionCredit = "promotion_credit"
        case isDefault = "is_default"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        modelName = try c.decodeIfPresent(String.self, forKey: .modelName)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? name
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
        providerDisplayName = try c.decodeIfPresent(String.self, forKey: .providerDisplayName)
        providerScope = try c.decodeIfPresent(String.self, forKey: .providerScope)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        supportsFunctionCalling = try c.decodeIfPresent(Bool.self, forKey: .supportsFunctionCalling)
        supportsVision = try c.decodeIfPresent(Bool.self, forKey: .supportsVision)
        declaredSupportsDocumentInput = try c.decodeIfPresent(
            Bool.self,
            forKey: .declaredSupportsDocumentInput
        )
        resolvedCapabilities = try c.decodeIfPresent(
            ChatModelDocumentInputCapabilities.self,
            forKey: .resolvedCapabilities
        )
        capabilitiesConfig = try c.decodeIfPresent(
            ChatModelDocumentInputCapabilities.self,
            forKey: .capabilitiesConfig
        )
        contextWindowTokens = try c.decodeIfPresent(Int.self, forKey: .contextWindowTokens)
        maxInputTokens = try c.decodeIfPresent(Int.self, forKey: .maxInputTokens)
        contextTiers = try c.decodeIfPresent([ChatModelContextTier].self, forKey: .contextTiers) ?? []
        runtimeProfile = try c.decodeIfPresent(ChatModelRuntimeProfile.self, forKey: .runtimeProfile)
        usageHint = try c.decodeIfPresent(String.self, forKey: .usageHint)
        promotionCredit = try c.decodeIfPresent(PromotionCredit.self, forKey: .promotionCredit)
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }

    /// Provider 的产品展示名完全来自 catalog；旧服务端缺该字段时才退回稳定 key。
    var providerLabel: String {
        let display = providerDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !display.isEmpty { return display }
        let key = provider.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? "其他" : key
    }

    /// 与 Electron 一致：顶层声明优先，缺失时依次回退归一化能力和原始配置；
    /// 只有显式 `true` 才放行文档直传，旧 catalog 缺字段时安全拒绝。
    var supportsDocumentInput: Bool {
        let value = declaredSupportsDocumentInput
            ?? resolvedCapabilities?.supportsDocumentInput
            ?? capabilitiesConfig?.supportsDocumentInput
        return value == true
    }

    var source: ChatModelSource {
        switch providerScope?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "organization": .organizationByok
        case "user": .userByok
        default: .platform
        }
    }

    var selectableContextTiers: [ChatModelContextTier] {
        guard contextTiers.count > 1, contextTiers.contains(where: \.isUserSelectable) else {
            return []
        }
        return contextTiers
    }

    /// 多档且运营标记可切换 → 渲染可点芯片。
    var canSelectContextTier: Bool { !selectableContextTiers.isEmpty }

    /// 有可切换档，或有单值 `context_window_tokens` → 显示「上下文长度」区块。
    var showsContextLengthSection: Bool {
        if canSelectContextTier { return true }
        return (contextWindowTokens ?? 0) > 0
    }

    /// Catalog 是否应渲染「思考强度」；选项严格用 `modes`（强制思考模型可能无 `off`）。
    var thinkingCapability: ChatModelThinkingCapability? {
        guard let thinking = runtimeProfile?.thinking, thinking.supported else { return nil }
        guard !thinking.modes.isEmpty else { return nil }
        let defaultMode: ChatModelThinkingMode
        if let mode = thinking.defaultMode, thinking.modes.contains(mode) {
            defaultMode = mode
        } else if thinking.modes.contains(.standard) {
            defaultMode = .standard
        } else {
            defaultMode = thinking.modes[0]
        }
        return ChatModelThinkingCapability(modes: thinking.modes, defaultMode: defaultMode)
    }

    /// L1「运行设置」入口：无可调上下文且不支持思考时隐藏（不灰掉）。
    var showsRuntimeSettings: Bool {
        showsContextLengthSection || thinkingCapability != nil
    }

    /// 模型选择器内联展示的 Provider 赠享额度；无权益时保持不显示。
    var promotionCreditSummary: String? {
        guard let promotionCredit, promotionCredit.eligible else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        let remaining = formatter.string(from: NSNumber(value: promotionCredit.remainingCredits)) ?? "0"
        let total = formatter.string(from: NSNumber(value: promotionCredit.totalCredits ?? promotionCredit.remainingCredits)) ?? "0"
        return "赠享\(remaining)/\(total)点券"
    }
}

enum ChatModelSource: Int, CaseIterable, Hashable, Sendable {
    case platform
    case organizationByok
    case userByok

    var title: String {
        switch self {
        case .platform: "平台模型"
        case .organizationByok: "组织 BYOK"
        case .userByok: "我的 BYOK"
        }
    }
}

/// 服务端 `promotion_credit`；Feature Flag 关闭时字段缺失，旧服务端可不返回总额。
struct PromotionCredit: Decodable, Hashable, Sendable {
    let eligible: Bool
    let remainingCredits: Double
    let totalCredits: Double?

    enum CodingKeys: String, CodingKey {
        case eligible
        case remainingCredits = "remaining_credits"
        case totalCredits = "total_credits"
    }
}

struct ChatModelListResponse: Decodable, Sendable {
    let models: [ChatModel]
    let defaultModelId: String?
    let defaultModelName: String?
    let providers: [String: ChatModelProviderMetadata]

    enum CodingKeys: String, CodingKey {
        case models
        case defaultModelId = "default_model_id"
        case defaultModelName = "default_model_name"
        case providers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        models = try c.decodeIfPresent([ChatModel].self, forKey: .models) ?? []
        defaultModelId = try c.decodeIfPresent(String.self, forKey: .defaultModelId)
        defaultModelName = try c.decodeIfPresent(String.self, forKey: .defaultModelName)
        providers = try c.decodeIfPresent([String: ChatModelProviderMetadata].self, forKey: .providers) ?? [:]
    }
}

/// catalog 顶层 provider 元数据。品牌标由服务端 URL 统一下发，客户端不再消费
/// emoji 图标，避免各端出现不一致的临时视觉。
struct ChatModelProviderMetadata: Decodable, Hashable, Sendable {
    let displayName: String?
    let iconURL: String?

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case iconURL = "icon_url"
    }
}

/// 模型选择器的纯投影。
///
/// 目录负责裁掉不可发送模型；这里仅做搜索、Provider 分组和展示语义，绝不补造
/// 「未配置」「无权限」等 catalog 没有提供的原因。
struct ModelSelectionProviderGroup: Identifiable, Hashable, Sendable {
    let provider: String
    let title: String
    let models: [ChatModel]

    var id: String { provider }
}

enum ModelSelectionProjection {
    /// 已有会话会持久化到 Session；未首发草稿则冻结为新会话的初始模型。
    static let nextSendHint = "当前会话使用"

    static func groups(
        models: [ChatModel],
        providers: [String: ChatModelProviderMetadata] = [:],
        query: String
    ) -> [ModelSelectionProviderGroup] {
        let matching = models.filter { matches($0, query: query) }
        var orderedProviders: [String] = []
        var modelsByProvider: [String: [ChatModel]] = [:]

        for model in matching {
            let key = normalizedProviderKey(model.provider)
            if modelsByProvider[key] == nil {
                orderedProviders.append(key)
                modelsByProvider[key] = []
            }
            modelsByProvider[key, default: []].append(model)
        }

        return orderedProviders.compactMap { provider in
            guard let groupedModels = modelsByProvider[provider], !groupedModels.isEmpty else {
                return nil
            }
            let catalogName = providers[provider]?.displayName?.trimmedNonEmpty
            let modelName = groupedModels.first?.providerDisplayName?.trimmedNonEmpty
            return ModelSelectionProviderGroup(
                provider: provider,
                title: catalogName ?? modelName ?? groupedModels[0].providerLabel,
                models: groupedModels
            )
        }
    }

    static func matches(_ model: ChatModel, query: String) -> Bool {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalizedQuery.isEmpty else { return true }
        return searchableFields(for: model).contains { $0.lowercased().contains(normalizedQuery) }
    }

    /// 与 Electron 的紧凑选择器对齐：显示名、原始模型名、兼容模型名、Provider key 和展示名。
    static func searchableFields(for model: ChatModel) -> [String] {
        [
            model.displayName,
            model.name,
            model.modelName,
            model.provider,
            model.providerDisplayName,
        ].compactMap { $0?.trimmedNonEmpty }
    }

    static func capabilityLabels(for model: ChatModel) -> [String] {
        var labels = model.supportsVision == true ? ["视觉"] : []
        // chat catalog 中的 sendable 模型都能处理文字；视觉能力由服务端明确声明。
        labels.append("文字")
        return labels
    }

    static func contextSummary(for model: ChatModel) -> String? {
        guard let tokens = model.contextWindowTokens, tokens > 0 else { return nil }
        if tokens >= 1_000_000 {
            let value = Double(tokens) / 1_000_000
            return value.rounded() == value ? "\(Int(value))M 上下文" : "\(String(format: "%.1f", value))M 上下文"
        }
        if tokens >= 1_000 {
            return "\(tokens / 1_000)K 上下文"
        }
        return "\(tokens) Token 上下文"
    }

    private static func normalizedProviderKey(_ raw: String) -> String {
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? "__other__" : key
    }
}

/// Composer 运行设置（上下文长度 / 思考强度）的纯投影，对齐 Electron 能力逻辑与移动端 demo。
enum ComposerRuntimeSettingsProjection {
    /// 将 token 数格式化为产品短标签：128K / 256K / 1M（不含「上下文」后缀）。
    static func formatContextWindowLabel(_ tokens: Int) -> String {
        guard tokens > 0 else { return "" }
        if tokens >= 1_000_000 {
            let value = Double(tokens) / 1_000_000
            let rounded = (value * 10).rounded() / 10
            return rounded.rounded() == rounded
                ? "\(Int(rounded))M"
                : String(format: "%.1fM", rounded)
        }
        if tokens >= 1_000 {
            return "\(Int((Double(tokens) / 1_000).rounded()))K"
        }
        return "\(tokens)"
    }

    static func resolveActiveContextTierId(
        model: ChatModel,
        selectedTierId: String?
    ) -> String? {
        let tiers = model.selectableContextTiers
        guard !tiers.isEmpty else { return nil }
        if let selectedTierId,
           tiers.contains(where: { $0.id == selectedTierId }) {
            return selectedTierId
        }
        return tiers.first(where: \.isDefault)?.id ?? tiers.first?.id
    }

    static func resolveActiveThinkingMode(
        capability: ChatModelThinkingCapability,
        selected: ChatModelThinkingMode?
    ) -> ChatModelThinkingMode {
        if let selected, capability.modes.contains(selected) {
            return selected
        }
        return capability.defaultMode
    }

    static func contextSummary(
        model: ChatModel,
        selectedTierId: String?
    ) -> String? {
        let tiers = model.selectableContextTiers
        if !tiers.isEmpty {
            let activeId = resolveActiveContextTierId(model: model, selectedTierId: selectedTierId)
            return tiers.first(where: { $0.id == activeId })?.label
                ?? tiers.first?.label
        }
        guard let tokens = model.contextWindowTokens, tokens > 0 else { return nil }
        return formatContextWindowLabel(tokens)
    }

    static func thinkingSummary(
        capability: ChatModelThinkingCapability?,
        selected: ChatModelThinkingMode?
    ) -> String? {
        guard let capability else { return nil }
        let mode = resolveActiveThinkingMode(capability: capability, selected: selected)
        return mode.displayLabel
    }

    /// 工具条 / L1 入口摘要，如 `200K · 深度`。
    static func runtimeSummary(
        model: ChatModel?,
        selectedTierId: String?,
        selectedThinkingMode: ChatModelThinkingMode?
    ) -> String? {
        guard let model else { return nil }
        var parts: [String] = []
        if let context = contextSummary(model: model, selectedTierId: selectedTierId) {
            parts.append(context)
        }
        if let thinking = thinkingSummary(
            capability: model.thinkingCapability,
            selected: selectedThinkingMode
        ) {
            parts.append(thinking)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// 切模型后把本地意图夹到新模型能力面；无能力则清空。
    static func clampedSelection(
        model: ChatModel,
        selectedTierId: String?,
        selectedThinkingMode: ChatModelThinkingMode?
    ) -> (contextTierId: String?, thinkingMode: ChatModelThinkingMode?) {
        let tierId = resolveActiveContextTierId(model: model, selectedTierId: selectedTierId)
        let thinking: ChatModelThinkingMode?
        if let capability = model.thinkingCapability {
            thinking = resolveActiveThinkingMode(
                capability: capability,
                selected: selectedThinkingMode
            )
        } else {
            thinking = nil
        }
        return (tierId, thinking)
    }
}

enum ConversationModelSelectionPolicy {
    static func canSelect(hasActiveRun: Bool, isSwitchingModel: Bool) -> Bool {
        !hasActiveRun && !isSwitchingModel
    }

    /// Agent 变化时优先跟随新 Agent 的有效偏好模型；偏好缺失或目录不可用时保持当前模型。
    static func modelIdAfterAgentChange(
        preferredModelId: String?,
        currentModelId: String?,
        availableModelIds: Set<String>
    ) -> String? {
        guard let preferred = normalized(preferredModelId),
              availableModelIds.contains(preferred) else {
            return normalized(currentModelId)
        }
        return preferred
    }

    /// 已有会话只从服务端会话快照恢复；catalog 默认仅在会话从未冻结模型时兜底。
    static func restoredModelId(
        currentModelId: String?,
        defaultModelId: String?,
        catalogDefaultModelId: String?
    ) -> String? {
        normalized(currentModelId)
            ?? normalized(defaultModelId)
            ?? normalized(catalogDefaultModelId)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

enum ProviderIconURLResolver {
    static func resolve(_ rawValue: String?, apiBaseURL: String = AppConfig.apiBaseURL) -> URL? {
        guard let raw = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }

        if let absolute = URL(string: raw),
           let scheme = absolute.scheme?.lowercased(),
           scheme == "https" || scheme == "http" {
            return absolute
        }

        guard var base = URLComponents(string: apiBaseURL),
              let scheme = base.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              base.host != nil else {
            return nil
        }
        base.path = "/"
        base.query = nil
        base.fragment = nil
        guard let origin = base.url else { return nil }
        return URL(string: raw, relativeTo: origin)?.absoluteURL
    }
}

private extension String {
    var trimmedNonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

/// 可发送模型判定：id 为合法 UUID 且非 "declared:" 占位（未激活/仅声明的模型不能直接发送）。
/// 与后端契约一致：发送时必须带一个 sendable 模型的真实 id，否则走 default scene 解析易失败。
func isSendableChatModel(_ model: ChatModel?) -> Bool {
    guard let id = model?.id.trimmingCharacters(in: .whitespacesAndNewlines),
          !id.isEmpty, !id.hasPrefix("declared:") else { return false }
    return UUID(uuidString: id) != nil
}
