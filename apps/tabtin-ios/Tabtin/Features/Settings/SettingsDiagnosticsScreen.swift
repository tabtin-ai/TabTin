import SwiftUI
import UIKit

struct SettingsDiagnosticsScreen: View {
    @State private var isExporting = false
    @State private var shareItem: DiagnosticShareItem?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                Text(L10n.Settings.diagnosticsDescription)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Text(L10n.Settings.diagnosticsPrivacy)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
            }

            Section {
                Button {
                    export()
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        if isExporting {
                            ProgressView()
                        } else {
                            Image(systemName: "square.and.arrow.up")
                        }
                        Text(isExporting ? L10n.Settings.diagnosticsExporting : L10n.Settings.diagnosticsExport)
                            .font(.tt.subtitleSemibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .disabled(isExporting)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(L10n.Settings.diagnosticsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $shareItem) { item in
            DiagnosticActivityView(items: [item.url])
        }
        .alert(L10n.Settings.diagnosticsFailed, isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button(L10n.Common.confirm) { errorMessage = nil }
        }
    }

    private func export() {
        guard !isExporting else { return }
        isExporting = true
        Task {
            do {
                let url = try await DiagnosticRecorder.shared.exportBundle()
                shareItem = DiagnosticShareItem(url: url)
            } catch {
                DiagnosticRecorder.captureApp(
                    name: "diagnostics_export_failed",
                    errorClass: String(describing: type(of: error))
                )
                errorMessage = String(describing: type(of: error))
            }
            isExporting = false
        }
    }
}

private struct DiagnosticShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

private struct DiagnosticActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = UIView()
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
