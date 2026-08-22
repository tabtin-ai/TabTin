import SwiftUI

struct NativeTabDocCommentsSection: View {
    let presentations: [NativeTabDocCommentPresentation]
    let draft: String
    let canCreate: Bool
    let isPosting: Bool
    let message: String?
    let onDraftChange: (String) -> Void
    let onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Divider()
            Text(L10n.TabDoc.commentsTitle)
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textPrimary)
            if let message, !message.isEmpty {
                Text(message)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textCritical)
            }
            if presentations.isEmpty {
                Text(L10n.TabDoc.commentEmpty)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
            } else {
                ForEach(presentations) { item in
                    commentCard(item)
                }
            }
            if canCreate {
                HStack(alignment: .center, spacing: TTSpacing.sm) {
                    TextField(
                        L10n.TabDoc.commentPlaceholder,
                        text: Binding(
                            get: { draft },
                            set: onDraftChange
                        )
                    )
                    .textFieldStyle(.roundedBorder)
                    .disabled(isPosting)
                    Button(action: onSubmit) {
                        Image(systemName: "paperplane.fill")
                            .foregroundStyle(.tt.iconAccent)
                    }
                    .disabled(isPosting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel(L10n.TabDoc.commentSend)
                }
            }
        }
        .padding(.top, TTSpacing.lg)
    }

    private func commentCard(_ item: NativeTabDocCommentPresentation) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            IdentityColorAvatar(
                name: item.authorName,
                seed: item.authorIdentitySeed,
                imageUrl: item.authorAvatarUrl,
                size: 32
            )
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                if !item.title.isEmpty {
                    Text(item.title)
                        .font(.tt.metaMedium)
                        .foregroundStyle(item.kind == .orphaned ? .tt.textCritical : .tt.textSecondary)
                }
                Text(item.authorName)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                Text(item.body)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

}

struct NativeTabDocBlockCommentSheet: View {
    let draft: String
    let isPosting: Bool
    let message: String?
    let onDraftChange: (String) -> Void
    let onSubmit: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                if let message, !message.isEmpty {
                    Text(message)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textCritical)
                }
                TextField(
                    L10n.TabDoc.commentPlaceholder,
                    text: Binding(
                        get: { draft },
                        set: onDraftChange
                    ),
                    axis: .vertical
                )
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
                .disabled(isPosting)
                Spacer()
            }
            .padding(TTSpacing.lg)
            .navigationTitle(L10n.TabDoc.commentAdd)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel, action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.TabDoc.commentSend, action: onSubmit)
                        .disabled(isPosting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
