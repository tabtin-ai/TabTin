import SwiftUI

/// 任务列表顶部的只读设备状态条。
///
/// 它只回答「执行设备现在是否可用」，不筛选会话、不提供「全部设备」选项，
/// 也不重复展示离线说明；用户真正发送任务时由会话内 Composer 解释阻断原因。
struct TaskHomeDeviceRail: View {
    let items: [TaskHomeDevicePolicy.DeviceItem]

    @ScaledMetric(relativeTo: .body) private var railHeight: CGFloat = 34

    var body: some View {
        HStack(spacing: 0) {
            Image(systemName: "desktopcomputer")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
                .accessibilityHidden(true)

            Spacer().frame(width: TTSpacing.sm)

            Rectangle()
                .fill(.tt.borderLight)
                .frame(width: 1, height: 14)

            Spacer().frame(width: TTSpacing.xs)

            ScrollView(.horizontal, showsIndicators: false) {
                itemRow
                    .frame(maxHeight: .infinity)
            }
        }
        .frame(height: railHeight)
        .padding(.horizontal, TTSpacing.lg)
    }

    private var itemRow: some View {
        HStack(spacing: TTSpacing.md) {
            ForEach(items) { device in
                HStack(spacing: TTSpacing.xs) {
                    Text(device.shortName)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)

                    Circle()
                        .fill(device.isOffline ? Color.tt.textTertiary : Color.tt.bgSuccess)
                        .frame(width: 6, height: 6)
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .overlay(
                    Capsule().strokeBorder(
                        Color.tt.borderLight.opacity(0.6),
                        lineWidth: 1
                    )
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    device.isOffline
                        ? "\(device.fullName)，\(L10n.Home.deviceOffline)"
                        : device.fullName
                )
            }
        }
    }
}
