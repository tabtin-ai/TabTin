import Foundation

/// 鉴权相关 DTO。移植自 apps/tabtin-ios（Models/User.swift），字段与后端对齐。
struct UserProfile: Codable, Identifiable, Sendable {
    let id: String
    let username: String?
    let phone: String?
    let email: String?
    let nickname: String?
    let avatar: String?
    let bio: String?
    let isVerifiedEmail: Bool?
    let isVerifiedPhone: Bool?
    let loginCount: Int?
    let dateJoined: String?
    let lastLogin: String?
    let inviteCodeRequired: Bool?
    let inviteCodeRedeemed: Bool?
    let hasUsablePassword: Bool?

    enum CodingKeys: String, CodingKey {
        case id, username, phone, email, nickname, avatar, bio
        case isVerifiedEmail = "is_verified_email"
        case isVerifiedPhone = "is_verified_phone"
        case loginCount = "login_count"
        case dateJoined = "date_joined"
        case lastLogin = "last_login"
        case inviteCodeRequired = "invite_code_required"
        case inviteCodeRedeemed = "invite_code_redeemed"
        case hasUsablePassword = "has_usable_password"
    }

    var displayName: String {
        nickname ?? username ?? phone ?? email ?? "User"
    }

    /// 已登录但邀请码尚未兑换时，必须停留在原生准入层。
    var needsInviteCode: Bool {
        inviteCodeRequired == true && inviteCodeRedeemed != true
    }

    /// 旧服务端缺少能力字段时保持原行为，仅在明确无密码时走验证码。
    var prefersVerificationPasswordSetup: Bool {
        hasUsablePassword == false
    }
}

struct LoginResponse: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let tokenType: String?
    let expiresIn: Int?
    let user: UserProfile

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case user
    }
}

struct SendCodeResponse: Codable, Sendable {
    let success: Bool
    let message: String
}

struct RedeemInviteCodeResponse: Codable, Sendable {
    let user: UserProfile
}

struct RefreshTokenResponse: Codable, Sendable {
    let accessToken: String
    let refreshToken: String?
    let tokenType: String?
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
    }
}
