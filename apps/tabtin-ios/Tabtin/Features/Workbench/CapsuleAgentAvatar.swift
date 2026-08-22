import SwiftUI

/// 工作台胶囊头像：与「我的 Agent」同一契约——`avatar_key` 预置优先，其次 URL，最后品牌图标。
/// 不用名字首字母当主头像，避免和 Agent 身份视觉脱节。
struct CapsuleAgentAvatar: View {
    let avatarKey: String?
    let avatarURL: String?
    var size: CGFloat = AgentStatusCapsule.avatarSize

    var body: some View {
        Group {
            if let preset = avatarKey.flatMap(AgentAvatarPreset.init(rawValue:)) {
                Image(preset.imageName)
                    .resizable()
                    .scaledToFill()
            } else if let url = resolvedURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        brandIcon
                    }
                }
            } else {
                brandIcon
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var resolvedURL: URL? {
        guard let raw = avatarURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    private var brandIcon: some View {
        Image("LoginBrandIcon")
            .resizable()
            .scaledToFill()
    }
}
