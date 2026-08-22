import Foundation

/// 对话置顶状态：按执行 Workspace 维度本地持久化。
@MainActor @Observable
final class PinnedChatSessionsStore {
    static let shared = PinnedChatSessionsStore()

    private static let defaultsKey = "tabtin_pinned_chat_sessions_by_space"

    private(set) var pinnedByWorkspace: [String: [String]] = [:]

    private init() {
        load()
        AuthService.shared.registerLogoutHook { [weak self] in
            self?.clear()
        }
    }

    func isPinned(sessionId: String, workspaceId: String?) -> Bool {
        guard let workspaceId else { return false }
        return pinnedByWorkspace[workspaceId]?.contains(sessionId) ?? false
    }

    func toggle(sessionId: String, workspaceId: String) {
        var ids = pinnedByWorkspace[workspaceId] ?? []
        if let index = ids.firstIndex(of: sessionId) {
            ids.remove(at: index)
        } else {
            ids.append(sessionId)
        }
        if ids.isEmpty {
            pinnedByWorkspace.removeValue(forKey: workspaceId)
        } else {
            pinnedByWorkspace[workspaceId] = ids
        }
        save()
    }

    /// 删除会话后同步清掉本地 pin，维持「按执行 Workspace 本地持久化」语义。
    func remove(sessionId: String, workspaceId: String?) {
        guard let workspaceId, var ids = pinnedByWorkspace[workspaceId],
              let index = ids.firstIndex(of: sessionId) else { return }
        ids.remove(at: index)
        if ids.isEmpty {
            pinnedByWorkspace.removeValue(forKey: workspaceId)
        } else {
            pinnedByWorkspace[workspaceId] = ids
        }
        save()
    }

    private func clear() {
        pinnedByWorkspace = [:]
        save()
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
              let decoded = try? JSONDecoder().decode([String: [String]].self, from: data) else {
            pinnedByWorkspace = [:]
            return
        }
        pinnedByWorkspace = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(pinnedByWorkspace) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }
}
