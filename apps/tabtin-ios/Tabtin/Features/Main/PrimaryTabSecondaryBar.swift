import SwiftUI

/// 主 Tab 顶栏下侧的钉钉式次级动作：左起横排 Lucide icon + 文字，条底 1px 分隔。
struct PrimaryTabSecondaryBarItem: Identifiable {
    let id: String
    let title: String
    let assetName: String
    var isEnabled: Bool = true
    var accessibilityLabel: String? = nil
    let action: () -> Void
}

struct PrimaryTabSecondaryBar: View {
    let items: [PrimaryTabSecondaryBarItem]
    var background: Color = .tt.bgCanvasDefault

    var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TTSpacing.xs) {
                    ForEach(items) { item in
                        Button(action: item.action) {
                            HStack(spacing: TTSpacing.sm - TTSpacing.xxs) {
                                Image(item.assetName)
                                    .renderingMode(.template)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: 18, height: 18)
                                    .foregroundStyle(.tt.iconAccent)

                                Text(item.title)
                                    .font(.tt.bodySemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                            }
                            .padding(.leading, TTSpacing.sm + TTSpacing.xxs)
                            .padding(.trailing, TTSpacing.md)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!item.isEnabled)
                        .opacity(item.isEnabled ? 1 : 0.4)
                        .accessibilityLabel(item.accessibilityLabel ?? item.title)
                    }
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.top, TTSpacing.xs)
                .padding(.bottom, TTSpacing.sm + TTSpacing.xxs)
            }
            .background(background)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color.tt.borderLight)
                    .frame(height: 1)
            }
        }
    }
}

/// 主 Tab 列表搜索：放在次级动作条下方（不用系统 `.searchable` 抽屉，避免压到次级条上面）。
struct PrimaryTabSearchField: View {
    @Binding var text: String
    let prompt: String

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(minHeight: 44)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .padding(.horizontal, TTSpacing.md)
        .padding(.top, TTSpacing.xs)
        .padding(.bottom, TTSpacing.sm)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(prompt)
    }
}
