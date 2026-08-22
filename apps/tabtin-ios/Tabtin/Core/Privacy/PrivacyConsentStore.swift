import Foundation

/// 应用内隐私与第三方 AI 数据共享同意状态（App Store 5.1.1 合规）。
@MainActor @Observable
final class PrivacyConsentStore {
    static let shared = PrivacyConsentStore()

    static let privacyPolicyURL = URL(string: "https://xcnq4wynfm4c.feishu.cn/docx/Ly1eddsKooUaGpxHouEctIKcnvd")!
    static let accountDeletionGraceDays = 30

    private enum Keys {
        static let privacyPolicyAccepted = "tt_privacy_policy_accepted"
        // v5：明确覆盖语音音频上传 + 转写文本。旧 v4「仅转写文本」不得无声继承。
        static let aiSharingConsentPrefix = "tt_ai_sharing_consent_v5"
        static let accountDeletionPrefix = "tt_account_deletion_requested_at"
    }

    private(set) var hasAcceptedPrivacyPolicy: Bool
    /// 当前用户是否已在首条真实 AI 请求前完成一次数据共享同意。
    private(set) var hasAcceptedAISharing: Bool
    private(set) var accountDeletionRequestedAt: Date?

    private init() {
        hasAcceptedPrivacyPolicy = UserDefaults.standard.bool(forKey: Keys.privacyPolicyAccepted)
        hasAcceptedAISharing = false
        accountDeletionRequestedAt = nil
        reloadUserScopedState()
        AuthService.shared.registerLogoutHook { [weak self] in
            self?.reloadUserScopedState()
        }
    }

    func reloadUserScopedState() {
        guard let userId = AuthService.shared.currentUser?.id, !userId.isEmpty else {
            hasAcceptedAISharing = false
            accountDeletionRequestedAt = nil
            return
        }
        hasAcceptedAISharing = UserDefaults.standard.bool(forKey: aiSharingKey)
        if let timestamp = UserDefaults.standard.object(forKey: accountDeletionKey) as? TimeInterval {
            accountDeletionRequestedAt = Date(timeIntervalSince1970: timestamp)
        } else {
            accountDeletionRequestedAt = nil
        }
    }

    var accountDeletionScheduledDate: Date? {
        guard let requestedAt = accountDeletionRequestedAt else { return nil }
        return Calendar.current.date(byAdding: .day, value: Self.accountDeletionGraceDays, to: requestedAt)
    }

    var isAccountDeletionPending: Bool {
        accountDeletionRequestedAt != nil
    }

    func acceptPrivacyPolicy() {
        hasAcceptedPrivacyPolicy = true
        UserDefaults.standard.set(true, forKey: Keys.privacyPolicyAccepted)
    }

    func revokePrivacyPolicy() {
        hasAcceptedPrivacyPolicy = false
        UserDefaults.standard.removeObject(forKey: Keys.privacyPolicyAccepted)
    }

    @discardableResult
    /// 只允许从已经解析出实际可发送模型的首条请求写入一次性同意。
    /// 设置页传 nil 时会失败，因此泛化说明不能绕过首发链路。
    func acceptAISharing(for model: ChatModel?) -> Bool {
        guard let userId = AuthService.shared.currentUser?.id, !userId.isEmpty,
              isSendableChatModel(model) else { return false }
        hasAcceptedAISharing = true
        UserDefaults.standard.set(true, forKey: aiSharingKey)
        return true
    }

    func revokeAISharing() {
        guard AuthService.shared.currentUser?.id != nil else { return }
        hasAcceptedAISharing = false
        UserDefaults.standard.removeObject(forKey: aiSharingKey)
    }

    @discardableResult
    func requestAccountDeletion() -> Date {
        let now = Date()
        accountDeletionRequestedAt = now
        UserDefaults.standard.set(now.timeIntervalSince1970, forKey: accountDeletionKey)
        return Calendar.current.date(byAdding: .day, value: Self.accountDeletionGraceDays, to: now) ?? now
    }

    func clearAccountDeletionRequest() {
        accountDeletionRequestedAt = nil
        UserDefaults.standard.removeObject(forKey: accountDeletionKey)
    }

    private var aiSharingKey: String {
        userScopedKey(Keys.aiSharingConsentPrefix)
    }

    private var accountDeletionKey: String {
        userScopedKey(Keys.accountDeletionPrefix)
    }

    private func userScopedKey(_ prefix: String) -> String {
        if let userId = AuthService.shared.currentUser?.id, !userId.isEmpty {
            return "\(prefix).\(userId)"
        }
        return prefix
    }
}
