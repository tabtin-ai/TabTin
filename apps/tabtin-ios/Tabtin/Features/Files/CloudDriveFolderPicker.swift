import SwiftUI

/// 单目标文件夹选择（不做批量）。`excludeCollectionId` 用于移动文件夹时排除自身树。
struct CloudDriveFolderPicker: View {
    let collections: [OrganizationCollection]
    let excludeCollectionId: String?
    let onPick: (String?) -> Void
    let onCancel: () -> Void

    private struct FolderOption: Identifiable {
        let collectionId: String?
        let title: String
        let depth: Int
        let systemImage: String
        var id: String { collectionId ?? "__root__" }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(options) { option in
                    Button {
                        onPick(option.collectionId)
                    } label: {
                        Label {
                            Text(option.title)
                                .padding(.leading, CGFloat(option.depth) * 12)
                        } icon: {
                            Image(systemName: option.systemImage)
                        }
                    }
                }
            }
            .navigationTitle(L10n.CloudDrive.moveToFolder)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel, action: onCancel)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var options: [FolderOption] {
        var result: [FolderOption] = [
            FolderOption(
                collectionId: nil,
                title: L10n.CloudDrive.rootFolder,
                depth: 0,
                systemImage: "house"
            ),
        ]
        appendFolders(filterTree(collections), depth: 0, into: &result)
        return result
    }

    private func appendFolders(
        _ nodes: [OrganizationCollection],
        depth: Int,
        into result: inout [FolderOption]
    ) {
        for node in nodes {
            result.append(
                FolderOption(
                    collectionId: node.id,
                    title: node.name.isEmpty ? L10n.CloudDrive.untitledFolder : node.name,
                    depth: depth,
                    systemImage: "folder"
                )
            )
            appendFolders(node.children, depth: depth + 1, into: &result)
        }
    }

    private func filterTree(_ nodes: [OrganizationCollection]) -> [OrganizationCollection] {
        guard let exclude = excludeCollectionId else { return nodes }
        return nodes.compactMap { node -> OrganizationCollection? in
            if node.id == exclude { return nil }
            return OrganizationCollection(
                id: node.id,
                name: node.name,
                parentId: node.parentId,
                organizationId: node.organizationId,
                icon: node.icon,
                color: node.color,
                order: node.order,
                isPinned: node.isPinned,
                itemCount: node.itemCount,
                children: filterTree(node.children)
            )
        }
    }
}
