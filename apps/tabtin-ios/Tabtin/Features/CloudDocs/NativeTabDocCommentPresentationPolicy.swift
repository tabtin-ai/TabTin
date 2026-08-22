import Foundation

enum NativeTabDocCommentPresentationPolicy {
    static func present(
        threads: [NativeTabDocCommentThread],
        blocks: [NativeTabDocBlock],
        labels: NativeTabDocCommentPresentationLabels
    ) -> [NativeTabDocCommentPresentation] {
        var blocksByPersistentId: [String: NativeTabDocBlock] = [:]
        for block in blocks {
            guard let persistentId = block.persistentBlockId, !persistentId.isEmpty else { continue }
            if blocksByPersistentId[persistentId] == nil {
                blocksByPersistentId[persistentId] = block
            }
        }
        return threads.map { presentThread($0, blocksByPersistentId: blocksByPersistentId, labels: labels) }
    }

    private static func presentThread(
        _ thread: NativeTabDocCommentThread,
        blocksByPersistentId: [String: NativeTabDocBlock],
        labels: NativeTabDocCommentPresentationLabels
    ) -> NativeTabDocCommentPresentation {
        let root = thread.messages.first { $0.kind == "root" && !$0.isDeleted }
            ?? thread.messages.first { !$0.isDeleted }
        let body = root?.body ?? ""
        let authorName = root?.authorName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? (root?.authorName ?? labels.anonymousAuthor)
            : labels.anonymousAuthor
        let authorAvatarUrl = root?.authorAvatar?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? root?.authorAvatar
            : nil
        let authorUserId = root?.authorUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let authorIdentitySeed = authorUserId.isEmpty ? authorName : authorUserId

        if thread.scope == "document" {
            return NativeTabDocCommentPresentation(
                threadId: thread.id,
                kind: .document,
                title: labels.documentTitle,
                body: body,
                authorName: authorName,
                authorAvatarUrl: authorAvatarUrl,
                authorIdentitySeed: authorIdentitySeed
            )
        }

        let matched = thread.anchor.blockIds
            .compactMap { id -> NativeTabDocBlock? in
                let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return nil }
                return blocksByPersistentId[trimmed]
            }
            .first
        guard let matched else {
            return NativeTabDocCommentPresentation(
                threadId: thread.id,
                kind: .orphaned,
                title: labels.orphanedTitle,
                body: body,
                authorName: authorName,
                authorAvatarUrl: authorAvatarUrl,
                authorIdentitySeed: authorIdentitySeed
            )
        }

        let previewCandidates = [
            matched.text.trimmingCharacters(in: .whitespacesAndNewlines),
            thread.selectedText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            thread.anchor.selectedText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
        ]
        let preview = previewCandidates.first { !$0.isEmpty } ?? ""
        let title = preview.isEmpty ? labels.blockTitle : String(preview.prefix(40))
        return NativeTabDocCommentPresentation(
            threadId: thread.id,
            kind: .block,
            title: title,
            body: body,
            authorName: authorName,
            authorAvatarUrl: authorAvatarUrl,
            authorIdentitySeed: authorIdentitySeed,
            matchedBlockId: matched.persistentBlockId,
            blockPreview: preview.isEmpty ? nil : preview
        )
    }
}
