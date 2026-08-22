import SwiftUI
import UniformTypeIdentifiers

struct MemoQuickComposer: View {
    @Bindable var viewModel: MemoAppHomeViewModel

    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showFileImporter = false

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.MemoAppHome.quickComposerTitle)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textPrimary)

            TextField(
                L10n.MemoAppHome.quickComposerPlaceholder,
                text: $viewModel.draftContent,
                axis: .vertical
            )
            .font(.tt.body)
            .lineLimit(3...8)
            .focused($focused)
            .padding(TTSpacing.sm)
            .background(.tt.bgCanvasDefault, in: RoundedRectangle(cornerRadius: TTRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            )
            .accessibilityLabel(L10n.MemoAppHome.quickComposerPlaceholder)

            if let name = viewModel.draftAttachmentName {
                HStack(spacing: TTSpacing.sm) {
                    Image(systemName: "paperclip")
                        .foregroundStyle(.tt.textSecondary)
                    Text(name)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if viewModel.attachmentPhase == .failed {
                        Button(L10n.MemoAppHome.attachmentRetry) {
                            Task { await viewModel.retryPendingAttachment() }
                        }
                        .font(.tt.metaSemibold)
                    } else if viewModel.attachmentPhase != .uploading,
                              viewModel.attachmentPhase != .binding,
                              viewModel.lastCreatedMemoIdForAttachment == nil {
                        Button(L10n.MemoAppHome.clearAttachment) {
                            viewModel.clearDraftAttachment()
                        }
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                    }
                }
                .accessibilityElement(children: .combine)
            }

            if viewModel.attachmentPhase == .failed, let attachmentError = viewModel.attachmentError {
                Text(attachmentError)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                Text(L10n.MemoAppHome.attachmentFailedKeepBody)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }

            HStack(spacing: TTSpacing.sm) {
                TextField(L10n.MemoAppHome.tagsPlaceholder, text: $viewModel.draftTagsText)
                    .font(.tt.meta)
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, TTSpacing.sm)
                    .padding(.vertical, TTSpacing.xs)
                    .background(.tt.bgCanvasDefault, in: Capsule())
                    .accessibilityLabel(L10n.MemoAppHome.tagsPlaceholder)

                colorMenu

                Button {
                    showFileImporter = true
                } label: {
                    Image(systemName: "paperclip")
                        .font(.tt.iconBody)
                        .padding(.horizontal, TTSpacing.sm)
                        .padding(.vertical, TTSpacing.xs)
                        .background(.tt.bgCanvasDefault, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isCreating)
                .accessibilityLabel(L10n.MemoAppHome.attachFile)

                Spacer(minLength: 0)

                Button {
                    Task { await viewModel.createFromDraft() }
                } label: {
                    if viewModel.isCreating || viewModel.attachmentPhase == .uploading || viewModel.attachmentPhase == .binding {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(L10n.MemoAppHome.save)
                            .font(.tt.metaSemibold)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.90, green: 0.33, blue: 0.44))
                .disabled(
                    viewModel.draftContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || viewModel.isCreating
                )
                .accessibilityLabel(L10n.MemoAppHome.save)
            }

            if let createError = viewModel.createError {
                Text(createError)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                    .accessibilityLabel(createError)
            }
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: viewModel.createError)
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else { return }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            viewModel.attachDraftFile(
                data: data,
                fileName: url.lastPathComponent,
                contentType: mime
            )
        }
    }

    private var colorMenu: some View {
        Menu {
            Button(L10n.MemoAppHome.colorNone) { viewModel.draftColor = .none }
            ForEach(MemoColor.selectableCases) { color in
                Button(color.displayName) { viewModel.draftColor = color }
            }
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(viewModel.draftColor == .none ? .tt.bgSubtle : viewModel.draftColor.swatch)
                    .frame(width: 14, height: 14)
                    .overlay(Circle().strokeBorder(.tt.borderLight, lineWidth: 0.5))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xs)
            .background(.tt.bgCanvasDefault, in: Capsule())
        }
        .accessibilityLabel(L10n.MemoAppHome.colorPicker)
    }
}
