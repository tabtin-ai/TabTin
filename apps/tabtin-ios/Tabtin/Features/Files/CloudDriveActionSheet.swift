import SwiftUI

/// 云盘写入操作面板：上传 / 新建文件夹 / 文档 / 多维表。
struct CloudDriveActionSheet: View {
    let canWrite: Bool
    let isWriting: Bool
    let pendingMountCount: Int
    let onUpload: () -> Void
    let onNewFolder: () -> Void
    let onNewDoc: () -> Void
    let onNewTable: () -> Void
    let onRetryPendingMount: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if canWrite {
                    Section {
                        Button {
                            onDismiss()
                            onUpload()
                        } label: {
                            Label(L10n.CloudDrive.uploadFile, systemImage: "square.and.arrow.up")
                        }
                        .disabled(isWriting)

                        Button {
                            onDismiss()
                            onNewFolder()
                        } label: {
                            Label(L10n.CloudDrive.newFolder, systemImage: "folder.badge.plus")
                        }
                        .disabled(isWriting)

                        Button {
                            onDismiss()
                            onNewDoc()
                        } label: {
                            Label(L10n.CloudDocs.actionNewDoc, systemImage: "doc.badge.plus")
                        }
                        .disabled(isWriting)

                        Button {
                            onDismiss()
                            onNewTable()
                        } label: {
                            Label(L10n.CloudDocs.actionNewTable, systemImage: "tablecells.badge.ellipsis")
                        }
                        .disabled(isWriting)
                    }

                    if pendingMountCount > 0 {
                        Section {
                            Button {
                                onDismiss()
                                onRetryPendingMount()
                            } label: {
                                Label(
                                    L10n.CloudDrive.retryPendingMount(pendingMountCount),
                                    systemImage: "arrow.clockwise"
                                )
                            }
                        } footer: {
                            Text(L10n.CloudDrive.mountPendingHint)
                                .font(.tt.meta)
                        }
                    }
                } else {
                    Section {
                        Label(L10n.CloudDrive.writeUnavailable, systemImage: "lock")
                            .foregroundStyle(.tt.textTertiary)
                    } footer: {
                        Text(L10n.CloudDrive.writeUnavailableFooter)
                            .font(.tt.meta)
                    }
                }
            }
            .navigationTitle(L10n.CloudDrive.actionsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel, action: onDismiss)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
