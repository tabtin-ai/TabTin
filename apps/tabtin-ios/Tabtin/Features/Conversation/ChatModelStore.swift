import Foundation
import os

/// 聊天模型目录（session 级共享）：拉 organization 维度的可发送模型，供发送时解析 model_id。
///
/// 为什么需要：发送消息若不带 model_id，后端按 default scene 解析；dev 环境 default 常未激活
/// → "default 不存在/未激活" 报错。客户端必须像旧端一样带一个真实 sendable 模型的 id。
@MainActor @Observable
final class ChatModelStore {
    static let shared = ChatModelStore()

    private(set) var availableModels: [ChatModel] = []
    private(set) var defaultModelName: String?
    /// Catalog 顶层的 Provider 展示元数据。名称与品牌图标均以服务端为准。
    private(set) var providerMetadata: [String: ChatModelProviderMetadata] = [:]
    /// 当前目录所属组织。结算后的静默刷新必须与它一致，避免旧组织响应覆盖前台列表。
    private(set) var loadedOrganizationId: String?
    private(set) var isLoading = false
    private(set) var loadError: String?

    private var loadTask: Task<Void, Never>?
    private var catalogRequestGeneration = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ChatModelStore")

    private init() {
        AuthService.shared.registerLogoutHook { [weak self] in self?.clearAll() }
    }

    /// 当前应使用的可发送模型：优先 session 指定模型名，其次目录默认名，最后第一个 isDefault / 第一个。
    func currentModel(forSessionModelName sessionModelName: String? = nil) -> ChatModel? {
        if let name = sessionModelName, !name.isEmpty,
           let m = availableModels.first(where: { $0.name == name || $0.displayName == name }) {
            return m
        }
        if let defaultName = defaultModelName,
           let m = availableModels.first(where: { $0.name == defaultName }) {
            return m
        }
        return availableModels.first(where: { $0.isDefault }) ?? availableModels.first
    }

    /// 解析一个可直接发送的 model_id（已过 sendable 校验）；无可用模型返回 nil。
    func sendableModelId(forSessionModelName sessionModelName: String? = nil) -> String? {
        sendableModel(forSessionModelName: sessionModelName)?.id
    }

    /// 解析一个可直接发送的完整模型信息，供发送前的隐私披露与实际 `model_id` 共用。
    func sendableModel(forSessionModelName sessionModelName: String? = nil) -> ChatModel? {
        let model = currentModel(forSessionModelName: sessionModelName)
        return isSendableChatModel(model) ? model : availableModels.first(where: isSendableChatModel)
    }

    /// 确保目录已加载（幂等）：空且未在载时拉一次，并等待完成。
    func ensureLoaded() async {
        if !availableModels.isEmpty { return }
        if let task = loadTask { await task.value; return }
        let task = Task { await load() }
        loadTask = task
        await task.value
        loadTask = nil
    }

    func load() async {
        guard AuthService.shared.isAuthenticated,
              let organizationId = WorkspaceStore.shared.selectedOrganizationId else {
            availableModels = []
            defaultModelName = nil
            providerMetadata = [:]
            loadedOrganizationId = nil
            return
        }
        catalogRequestGeneration += 1
        let requestGeneration = catalogRequestGeneration
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let resp: ChatModelListResponse = try await APIClient.shared.get(
                path: Endpoints.LLM.catalog,
                query: ["use_case": "chat", "organization_id": organizationId]
            )
            guard requestGeneration == catalogRequestGeneration,
                  WorkspaceStore.shared.selectedOrganizationId == organizationId else { return }
            var models = resp.models.filter(isSendableChatModel)
            if let defaultId = resp.defaultModelId,
               let idx = models.firstIndex(where: { $0.id == defaultId }) {
                models[idx].isDefault = true
            }
            availableModels = models
            defaultModelName = resp.defaultModelName
            providerMetadata = resp.providers
            loadedOrganizationId = organizationId
        } catch {
            guard requestGeneration == catalogRequestGeneration else { return }
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.warning("load models failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 对话成功结算后，仅更新实际使用的专项点券模型；不清空目录或改写当前选择。
    func refreshPromotionCredits(afterSettlingModelId modelId: String) async {
        guard let organizationId = loadedOrganizationId,
              WorkspaceStore.shared.selectedOrganizationId == organizationId,
              Self.shouldRefreshPromotionCredit(modelId: modelId, availableModels: availableModels) else { return }

        catalogRequestGeneration += 1
        let requestGeneration = catalogRequestGeneration
        do {
            let resp: ChatModelListResponse = try await APIClient.shared.get(
                path: Endpoints.LLM.catalog,
                query: ["use_case": "chat", "organization_id": organizationId]
            )
            guard requestGeneration == catalogRequestGeneration,
                  loadedOrganizationId == organizationId,
                  WorkspaceStore.shared.selectedOrganizationId == organizationId,
                  let refreshed = resp.models.first(where: { $0.id == modelId }),
                  let index = availableModels.firstIndex(where: { $0.id == modelId }) else { return }
            availableModels[index].promotionCredit = refreshed.promotionCredit
        } catch {
            // 静默降级：保留上次成功投影，不打断刚完成的对话。
            logger.warning("refresh promotion credits failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    nonisolated static func shouldRefreshPromotionCredit(modelId: String?, availableModels: [ChatModel]) -> Bool {
        guard let modelId, !modelId.isEmpty else { return false }
        return availableModels.first(where: { $0.id == modelId })?.promotionCredit?.eligible == true
    }

    func clearForOrganizationSwitch() {
        catalogRequestGeneration += 1
        availableModels = []
        defaultModelName = nil
        providerMetadata = [:]
        loadedOrganizationId = nil
        loadError = nil
        loadTask?.cancel()
        loadTask = nil
    }

    func clearAll() { clearForOrganizationSwitch() }
}
