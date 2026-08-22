import Foundation

struct InviteDeepLink: Codable, Identifiable, Equatable, Sendable {
    let token: String

    var id: String { token }
}

enum InviteDeepLinkParser {
    static func parse(_ url: URL) -> InviteDeepLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let segments: [Substring]
        switch url.scheme?.lowercased() {
        case "tabtin", "tabtin-preprod":
            guard url.host?.lowercased() == "invite" else { return nil }
            segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
        case "https", "http":
            guard let host = url.host?.lowercased(),
                  host == "example.com" || host.hasSuffix(".example.com") else { return nil }
            let path = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
            guard path.first?.lowercased() == "invite" else { return nil }
            segments = Array(path.dropFirst())
        default:
            return nil
        }

        guard segments.count == 1,
              let token = String(segments[0]).removingPercentEncoding?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else { return nil }
        return InviteDeepLink(token: token)
    }
}

@MainActor @Observable
final class InviteDeepLinkCoordinator {
    static let shared = InviteDeepLinkCoordinator()

    static let defaultKey = "com.tabtin.invite.pending.v1"
    private(set) var pendingInvite: InviteDeepLink?

    private let defaults: UserDefaults
    private let defaultsKey: String

    init(
        defaults: UserDefaults = .standard,
        defaultsKey: String = InviteDeepLinkCoordinator.defaultKey
    ) {
        self.defaults = defaults
        self.defaultsKey = defaultsKey
        pendingInvite = defaults.data(forKey: defaultsKey)
            .flatMap { try? JSONDecoder().decode(InviteDeepLink.self, from: $0) }
    }

    @discardableResult
    func receive(_ url: URL) -> Bool {
        guard let invite = InviteDeepLinkParser.parse(url) else { return false }
        pendingInvite = invite
        persist()
        return true
    }

    func inviteForPresentation(
        isAuthenticated: Bool,
        hasProfile: Bool,
        needsInviteCode: Bool
    ) -> InviteDeepLink? {
        guard isAuthenticated, hasProfile, !needsInviteCode else { return nil }
        return pendingInvite
    }

    func finish(_ invite: InviteDeepLink) {
        guard pendingInvite == invite else { return }
        pendingInvite = nil
        persist()
    }

    private func persist() {
        if let pendingInvite,
           let data = try? JSONEncoder().encode(pendingInvite) {
            defaults.set(data, forKey: defaultsKey)
        } else {
            defaults.removeObject(forKey: defaultsKey)
        }
    }
}
