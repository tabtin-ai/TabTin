import Foundation

/// 鉴权状态与登录流。`@MainActor @Observable` 真单例（连接/会话/Organization 之一）。
///
/// 移植自 apps/tabtin-ios，做两处治理：
/// 1. **logout 解耦**：不再硬连一打具体 service（OrganizationService/SpaceService/...），
///    改为 `onLogout` hook 列表——各 service 建好后自行注册清理回调，避免 Core 反向依赖 Features。
/// 2. **错误如实抛出**：登录/刷新失败抛 APIError 给 UI 展示（修 PROFILE_CODE_REVIEW 的静默吞错债）。
@MainActor @Observable
final class AuthService {
    static let shared = AuthService()

    private(set) var isAuthenticated = false
    private(set) var currentUser: UserProfile?
    private(set) var accessToken: String?
    /// 每次登录身份建立或失效都会前进。长生命周期页面用它拒绝旧会话的异步回写。
    private(set) var sessionGeneration: UInt64 = 0
    /// 内存镜像：锁屏时 Keychain 不可读，REST/WS 仍可用会话内 token。
    private(set) var cachedRefreshToken: String?
    private(set) var cachedExpiresAt: Date?
    /// 只以本次登录或 Profile 明确返回的邀请码状态触发准入层，不读本地缓存。
    var needsInviteCode: Bool { currentUser?.needsInviteCode == true }

    /// 冷启动发现 access token 过期，等 scene active 后尝试 refresh。
    private(set) var needsTokenRefreshOnActive = false
    /// refresh 失败后的一次性提示，由 RootView 消费后清空。
    var sessionExpiredMessage: String?

    /// 登出清理 hook。各 service（Organization/Space/缓存…）建好后注册自己的清理逻辑。
    private var logoutHooks: [@MainActor () -> Void] = []

    private let keychain = KeychainService.shared
    /// 只保留本次点击“发送验证码”生成的挑战；不落盘，应用重启后必须重新发码。
    private var loginVerificationChallengeKey: String?
    /// challenge 同时绑定发码时的手机号，避免编辑号码后继续携带旧 key。
    private var loginVerificationChallengePhone: String?
    /// 每次发码/失效都推进代次，防止较早的异步发码响应恢复已失效的 challenge。
    private var loginVerificationChallengeGeneration = 0

    nonisolated static func challengeMatches(sentPhone: String?, loginPhone: String) -> Bool {
        guard let sentPhone else { return false }
        let sent = LoginPhoneNumber.normalized(sentPhone) ?? sentPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        let login = LoginPhoneNumber.normalized(loginPhone) ?? loginPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        return sent == login
    }

    nonisolated static func challengeRequestIsCurrent(
        requestGeneration: Int,
        currentGeneration: Int
    ) -> Bool {
        requestGeneration == currentGeneration
    }

    func invalidateLoginVerificationChallenge() {
        loginVerificationChallengeGeneration &+= 1
        loginVerificationChallengeKey = nil
        loginVerificationChallengePhone = nil
    }

    private init() {
        loadStoredAuth()
        registerLogoutHook {
            NativeTabDocDraftStore().removeAll()
            NativeTabDataDraftStore().removeAll()
        }
    }

    func registerLogoutHook(_ hook: @escaping @MainActor () -> Void) {
        logoutHooks.append(hook)
    }

    // MARK: - 冷启动状态（纯函数，可单测）

    struct ColdStartResult {
        let accessToken: String?
        let isAuthenticated: Bool
        let needsTokenRefreshOnActive: Bool
    }

    static func resolveColdStartState(storedToken: String?, expiresAt: Date?) -> ColdStartResult {
        guard storedToken != nil else {
            return ColdStartResult(accessToken: nil, isAuthenticated: false, needsTokenRefreshOnActive: false)
        }
        if let expiresAt, expiresAt.timeIntervalSinceNow <= 0 {
            return ColdStartResult(accessToken: nil, isAuthenticated: false, needsTokenRefreshOnActive: true)
        }
        return ColdStartResult(accessToken: storedToken, isAuthenticated: true, needsTokenRefreshOnActive: false)
    }

    private func loadStoredAuth() {
        let result = Self.resolveColdStartState(
            storedToken: keychain.getAccessToken(),
            expiresAt: keychain.getExpiresAt()
        )
        accessToken = result.accessToken
        cachedRefreshToken = keychain.getRefreshToken()
        cachedExpiresAt = keychain.getExpiresAt()
        isAuthenticated = result.isAuthenticated
        needsTokenRefreshOnActive = result.needsTokenRefreshOnActive
    }

    /// 优先内存；Keychain 锁屏不可读时仍能用会话内 token。
    func resolvedAccessToken() -> String? {
        accessToken ?? keychain.getAccessToken()
    }

    func resolvedRefreshToken() -> String? {
        cachedRefreshToken ?? keychain.getRefreshToken()
    }

    func resolvedExpiresAt() -> Date? {
        cachedExpiresAt ?? keychain.getExpiresAt()
    }

    /// APIClient 刷新成功后同步内存镜像（Keychain 写入由调用方负责）。
    func updateSessionTokens(accessToken: String, refreshToken: String?, expiresIn: Int?) {
        self.accessToken = accessToken
        if let refreshToken {
            cachedRefreshToken = refreshToken
        }
        if let expiresIn {
            cachedExpiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        }
    }

    /// APIClient 刷新成功后回调，同步内存 access token。
    func updateAccessToken(_ token: String) {
        accessToken = token
    }

    /// 前台恢复时检查 token 有效性，必要时主动刷新。
    /// Keychain 不可访问时直接返回，禁止把读失败当成「无 token」误杀会话。
    func checkTokenValidity() async {
        guard isAuthenticated else { return }
        guard keychain.isAccessible() else { return }
        guard resolvedAccessToken() != nil else {
            logout()
            return
        }
        if let expiresAt = resolvedExpiresAt(), expiresAt.timeIntervalSinceNow <= 0 {
            if resolvedRefreshToken() != nil {
                if case .tokenInvalid = await APIClient.shared.triggerManualRefresh() {
                    expireSession()
                }
            } else {
                expireSession()
            }
        }
    }

    /// 冷启动 access token 过期，尝试用 refresh token 恢复。
    /// `needsTokenRefreshOnActive` 在退出时才置 false，保证刷新中 RootView 持续 loading 不闪登录页。
    /// Keychain 仍不可访问时保留 flag，等下次 active 再试。
    func attemptColdLaunchRefresh() async {
        guard needsTokenRefreshOnActive else { return }
        guard keychain.isAccessible() else { return }
        defer { needsTokenRefreshOnActive = false }

        guard resolvedRefreshToken() != nil else {
            logout()
            return
        }

        switch await APIClient.shared.triggerManualRefresh() {
        case .succeeded:
            accessToken = resolvedAccessToken()
            isAuthenticated = true
        case .tokenInvalid:
            expireSession()
        case .conflict, .temporarilyUnavailable:
            // 网络异常不登出：保留登录态，待下次恢复重试。
            accessToken = resolvedAccessToken()
            isAuthenticated = true
        }
    }

    // MARK: - 登录

    func loginWithPassword(phone: String, password: String) async throws {
        let response: LoginResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.login,
            body: ["username": phone, "password": password],
            authentication: .none
        )
        try handleLoginSuccess(response)
    }

    @discardableResult
    func sendVerificationCode(phone: String) async throws -> Bool {
        let normalizedPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        invalidateLoginVerificationChallenge()
        let requestGeneration = loginVerificationChallengeGeneration
        let challengeKey = UUID().uuidString.lowercased()
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.sendCode,
            body: [
                "username": normalizedPhone,
                "code_type": "login",
                "challenge_key": challengeKey,
            ],
            authentication: .none
        )
        guard Self.challengeRequestIsCurrent(
            requestGeneration: requestGeneration,
            currentGeneration: loginVerificationChallengeGeneration
        ) else { return false }
        loginVerificationChallengeKey = challengeKey
        loginVerificationChallengePhone = normalizedPhone
        return true
    }

    func loginWithCode(phone: String, code: String) async throws {
        let normalizedPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let challengeKey = loginVerificationChallengeKey,
              Self.challengeMatches(
                sentPhone: loginVerificationChallengePhone,
                loginPhone: normalizedPhone
              ) else {
            throw APIError.apiErrorWithCode(
                code: "AUTH_VERIFICATION_CHALLENGE_REQUIRED",
                message: "请先重新获取验证码"
            )
        }
        let response: LoginResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.loginWithCode,
            body: [
                "username": normalizedPhone,
                "verification_code": code,
                "challenge_key": challengeKey,
            ],
            authentication: .none
        )
        try handleLoginSuccess(response)
    }

    func fetchProfile() async throws {
        guard accessToken != nil else { throw APIError.unauthorized }
        let profile: UserProfile = try await APIClient.shared.get(path: Endpoints.Auth.profile)
        updateCurrentUser(profile)
    }

    func redeemInviteCode(_ inviteCode: String) async throws {
        let normalizedCode = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCode.isEmpty else { throw APIError.apiError("请输入邀请码") }
        let response: RedeemInviteCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.redeemInviteCode,
            body: ["invite_code": normalizedCode],
            headers: ["X-TabTin-Error-Status": "standard"]
        )
        updateCurrentUser(response.user)
        guard !needsInviteCode else { throw APIError.apiError("邀请码验证未完成") }
    }

    @discardableResult
    func updateProfile(
        nickname: String? = nil,
        username: String? = nil,
        bio: String? = nil,
        avatarFileId: String? = nil
    ) async throws -> UserProfile {
        guard accessToken != nil else { throw APIError.unauthorized }
        // 资料字段走 PUT /auth/profile（/profile/settings 只收通知/主题类设置，
        // 传 nickname/avatar 会被静默丢弃）。该端点只回 success/message，需回读 profile。
        let _: SendCodeResponse = try await APIClient.shared.put(
            path: Endpoints.Auth.profile,
            body: Self.makeProfileUpdateBody(
                nickname: nickname,
                username: username,
                bio: bio,
                avatarFileId: avatarFileId
            )
        )
        try await fetchProfile()
        guard let user = currentUser else { throw APIError.apiError("资料回读失败") }
        return user
    }

    func sendEmailVerification() async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(path: Endpoints.Auth.sendEmailVerification)
    }

    func sendPhoneVerification() async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(path: Endpoints.Auth.sendPhoneVerification)
    }

    func verifyEmail(code: String) async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.verifyEmail,
            body: ["code": code]
        )
        try await fetchProfile()
    }

    func verifyPhone(code: String) async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.verifyPhone,
            body: ["code": code]
        )
        try await fetchProfile()
    }

    /// 使用当前密码修改密码。服务端成功后会使所有会话失效，调用方应回到登录页。
    func changePassword(oldPassword: String, newPassword: String) async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.changePassword,
            body: ["old_password": oldPassword, "new_password": newPassword]
        )
    }

    /// 给当前账号可信的手机号或邮箱发送重置当前密码验证码。
    func sendCurrentPasswordResetCode() async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.sendCurrentPasswordResetCode
        )
    }

    /// 使用当前账号验证码重置密码。服务端成功后会使所有会话失效。
    func resetCurrentPassword(verificationCode: String, newPassword: String) async throws {
        let _: SendCodeResponse = try await APIClient.shared.post(
            path: Endpoints.Auth.resetCurrentPassword,
            body: ["verification_code": verificationCode, "new_password": newPassword]
        )
    }

    // MARK: - 登出

    func logout() {
        RealtimeGateway.shared.disconnect()
        sessionGeneration &+= 1
        accessToken = nil
        cachedRefreshToken = nil
        cachedExpiresAt = nil
        currentUser = nil
        isAuthenticated = false
        needsTokenRefreshOnActive = false
        invalidateLoginVerificationChallenge()
        for hook in logoutHooks { hook() }
        keychain.clearAll()
    }

    /// Server-confirmed credential invalidation. Manual logout deliberately
    /// does not show the expiry message.
    func expireSession() {
        sessionExpiredMessage = "登录已过期，请重新登录"
        logout()
    }

    // MARK: - Private

    private func handleLoginSuccess(_ response: LoginResponse) throws {
        invalidateLoginVerificationChallenge()
        try keychain.saveTokenPair(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresIn: response.expiresIn
        )
        updateSessionTokens(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresIn: response.expiresIn
        )
        updateCurrentUser(response.user)
        sessionGeneration &+= 1
        isAuthenticated = true
        PrivacyConsentStore.shared.reloadUserScopedState()
    }

    private func updateCurrentUser(_ user: UserProfile) {
        currentUser = user
    }

    private nonisolated static func makeProfileUpdateBody(
        nickname: String?,
        username: String?,
        bio: String?,
        avatarFileId: String?
    ) -> sending [String: Any] {
        var body: [String: Any] = [:]
        if let nickname { body["nickname"] = nickname }
        if let username { body["username"] = username }
        if let bio { body["bio"] = bio }
        // 后端 UAVTR 契约：头像用 avatar_file_id 关联 FileRecord，不接受 avatar URL
        if let avatarFileId { body["avatar_file_id"] = avatarFileId }
        return body
    }
}
