import SwiftUI
import UIKit

/// 侧栏打开时为 true。任务页可据此暂停易重排的提示条。
private enum AccountDrawerSlidingKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var accountDrawerSliding: Bool {
        get { self[AccountDrawerSlidingKey.self] }
        set { self[AccountDrawerSlidingKey.self] = newValue }
    }
}

/// compact：左侧推挤式账户侧栏；regular：头像打开 sheet，不与系统 Tab 侧栏叠手势。
struct AccountDrawerHost<Content: View>: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @Bindable private var coordinator = AccountDrawerCoordinator.shared
    @State private var router = MainRouter.shared

    @ViewBuilder let content: () -> Content

    private var usesCompactDrawer: Bool {
        horizontalSizeClass.map { $0 == .compact } ?? true
    }

    private var drawerWidth: CGFloat {
        min(316, UIScreen.main.bounds.width * 0.81)
    }

    private var allowsEdgeOpenGesture: Bool {
        !coordinator.isOpen
            && !router.selectedTabHasPushedChild
    }

    var body: some View {
        Group {
            if usesCompactDrawer {
                compactLayout
            } else {
                content()
                    .sheet(
                        isPresented: drawerBinding,
                        onDismiss: { coordinator.completeDrawerDismissal() }
                    ) {
                        AccountDrawerPanel(layout: .regular)
                            .presentationDetents([.large])
                            .presentationDragIndicator(.visible)
                            .onAppear { coordinator.regularDrawerDidPresent() }
                    }
            }
        }
        .background {
            AccountGlobalPresentationHost()
        }
        .onAppear {
            coordinator.setPresentationMode(usesCompactDrawer ? .compact : .regular)
        }
        .onChange(of: usesCompactDrawer) { _, usesCompactDrawer in
            coordinator.setPresentationMode(usesCompactDrawer ? .compact : .regular)
        }
    }

    private var compactLayout: some View {
        ZStack(alignment: .leading) {
            AccountDrawerPanel(layout: .compact)
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity, alignment: .leading)
                // 关闭态被主壳完全盖住；打开态由主壳位移露出。
                .accessibilityHidden(coordinator.isOpen == false)

            AccountDrawerSlideContainer(
                isOpen: coordinator.isOpen,
                drawerWidth: drawerWidth,
                allowsEdgeOpen: allowsEdgeOpenGesture,
                onRequestOpen: { coordinator.openDrawer(animated: false) },
                onRequestClose: { coordinator.closeDrawer(animated: false) }
            ) {
                content()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .environment(\.accountDrawerSliding, coordinator.isOpen)
                    .background(Color.tt.bgCanvasDefault.ignoresSafeArea())
            }
            // 主壳必须铺满含安全区，否则侧栏「账户」/版本会从上下露出来。
            .ignoresSafeArea()
            .accessibilityHidden(coordinator.isOpen)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            Color.tt.bgCanvasDefault.ignoresSafeArea()
        }
    }

    private var drawerBinding: Binding<Bool> {
        Binding(
            get: { coordinator.isOpen },
            set: { isOpen in
                if isOpen {
                    coordinator.openDrawer()
                } else {
                    coordinator.closeDrawer()
                }
            }
        )
    }
}
