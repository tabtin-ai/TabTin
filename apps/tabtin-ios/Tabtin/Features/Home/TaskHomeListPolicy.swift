import Foundation

/// 列表级判定：归属 chip 该不该出现、SceneStorage 残留 id 清不清。
enum TaskHomeListPolicy {
    /// 归属只在「当前视图确实跨 Workspace」时才有信息量。
    /// 单 Workspace 用户或已经筛到某一个时渲染它，就退化成自我重复。
    static func shouldShowWorkspaceChip(
        distinctWorkspaceCount: Int,
        selectedWorkspaceId: String?
    ) -> Bool {
        guard selectedWorkspaceId == nil else { return false }
        return distinctWorkspaceCount > 1
    }

    /// SceneStorage 的 workspaceId 是 scene 全局的：冷启动进另一个组织时，
    /// 旧 id 仍在，却不在当前可执行 Workspace 集合里——丢掉，回到「全部」。
    static func sanitizedWorkspaceId(
        selected: String?,
        availableIds: Set<String>
    ) -> String? {
        guard let selected else { return nil }
        return availableIds.contains(selected) ? selected : nil
    }
}
