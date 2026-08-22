import SwiftUI
import UIKit

/// 一级工作面的标题项，放在侧栏菜单之后、显式左对齐。
///
/// 必须与 `ttRootLeadingNavigationTitle` 成对使用：那个 modifier 负责保留标题
/// 语义并让系统别自己画，这里负责画。
///
/// 摆在 `topBarLeading` 而不是 `principal`：`principal` 区域按内容宽度居中，
/// 塞 `Spacer` 撑 `maxWidth: .infinity` 也不会靠左。
struct TTRootTitleToolbarItem: ToolbarContent {
    let title: String

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarLeading) { label }
                // 不隐藏共享背景的话，Liquid Glass 会把标题当按钮套一层胶囊，
                // 顺带压缩成「云…」。
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { label }
        }
    }

    private var label: some View {
        Text(title)
            // 对齐系统 inline 标题的字号字重，与尚未迁移的工作面保持同一观感。
            .font(.tt.subtitleSemibold)
            .foregroundStyle(.tt.textPrimary)
            // 工具栏按剩余空间分配 leading 项宽度，不锁理想宽度会被截成「云…」。
            .fixedSize(horizontal: true, vertical: false)
    }
}

public extension View {
    /// 列表页搜索框聚焦时，轻点内容区或滚动即可交还键盘。
    /// 系统 `searchable` 搜索栏保留，由系统维持输入框与取消按钮的状态。
    func ttDismissKeyboardOnContentTap() -> some View {
        simultaneousGesture(
            TapGesture().onEnded {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
                )
            }
        )
        .simultaneousGesture(
            DragGesture(minimumDistance: 1).onChanged { _ in
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
                )
            }
        )
    }

    /// 统一导航栏背景：显式指定色值，避免系统默认材质与内容区色差
    @ViewBuilder
    func ttToolbarBackground(_ isVisible: Bool = true) -> some View {
        ttToolbarBackground(color: Color.tt.bgCanvasDefault, isVisible: isVisible)
    }

    @ViewBuilder
    func ttToolbarBackground(color: Color, isVisible: Bool = true) -> some View {
        if isVisible {
            self
                .toolbarBackground(color, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        } else {
            self
        }
    }

    /// 标准列表样式：隐藏系统分隔线，纯靠间距+色块区分
    func ttListStyle() -> some View {
        self
            .listStyle(.plain)
            .listSectionSeparator(.hidden)
            .listRowSeparator(.hidden)
            .scrollContentBackground(.hidden)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
            .ttToolbarBackground()
    }

    /// 标准表单样式：隐藏系统分隔线和默认背景，保持呼吸感
    func ttFormStyle() -> some View {
        self
            .listSectionSeparator(.hidden)
            .listRowSeparator(.hidden)
            .scrollContentBackground(.hidden)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
            .ttToolbarBackground()
    }

    /// 已废弃：优先使用 spacing 或色块区分，避免线条
    @available(*, deprecated, message: "使用 VStack spacing 或 Spacer 替代线条分隔")
    func ttSeparator(leading: CGFloat = 0) -> some View {
        self
    }

    /// 加载遮罩
    func ttLoading(_ isLoading: Bool) -> some View {
        self.overlay {
            if isLoading {
                ZStack {
                    Color.tt.overlayBackgroundLight
                    ProgressView()
                        .tint(.tt.textOnOverlay)
                        .scaleEffect(1.2)
                        .padding(TTSpacing.xl)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md))
                }
                .ignoresSafeArea()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isLoading)
    }

    func ttTabBarHidden(_ hidden: Bool) -> some View {
        modifier(TTAdaptiveTabBarVisibilityModifier(hidden: hidden))
    }

    @ViewBuilder
    func ttNavigationBarHidden(_ hidden: Bool) -> some View {
        if hidden {
            toolbar(.hidden, for: .navigationBar)
        } else {
            self
        }
    }

    @ViewBuilder
    func ttNavigationTitle(
        _ title: String,
        displayMode: NavigationBarItem.TitleDisplayMode = .automatic,
        isVisible: Bool = true
    ) -> some View {
        if isVisible {
            navigationTitle(title)
                .navigationBarTitleDisplayMode(displayMode)
        } else {
            self
        }
    }

    /// 主 Tab 根页面统一使用常规顶部标题，消除系统版本之间的大标题高度与折叠差异。
    func ttRootNavigationTitle(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
    }

    /// 一级工作面标题：保留 `navigationTitle` 的语义（返回按钮、VoiceOver），
    /// 但让系统不再自己绘制标题——标题改由 `TTRootTitleToolbarItem` 显式画在
    /// 侧栏菜单右侧。两者必须成对使用，否则页面会没有标题或画出两个。
    ///
    /// 为什么不直接用 `ttRootNavigationTitle`：iOS 26 的导航栏只在 trailing 侧
    /// 内容足够宽时才把 inline 标题推到左侧，少一个按钮标题就弹回居中。五个一级
    /// 工作面的右上按钮数量本来就不一样，靠这个副作用对齐等于把标题位置交给按钮
    /// 数量决定——加减一个按钮就会让标题跳位。
    func ttRootLeadingNavigationTitle(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .title)
    }

    /// 悬浮操作层的统一材质。iOS 26 使用 Regular Liquid Glass 保证内容上方的
    /// 自适应对比度；旧系统使用较厚的 regular material，避免浮层过度透明。
    @ViewBuilder
    func ttFloatingGlass<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
        }
    }
}

private struct TTAdaptiveTabBarVisibilityModifier: ViewModifier {
    let hidden: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        content.toolbar(
            shouldHide ? .hidden : .visible,
            for: .tabBar
        )
    }

    private var shouldHide: Bool {
        TTTabBarVisibilityPolicy.shouldHide(
            requested: hidden,
            isPhone: UIDevice.current.userInterfaceIdiom == .phone,
            // 转场瞬间 size class 可能为 nil；传 Optional，由 policy 在 phone 上按 compact 处理。
            isCompactWidth: horizontalSizeClass.map { $0 == .compact }
        )
    }
}

enum TTTabBarVisibilityPolicy {
    /// - Parameters:
    ///   - isCompactWidth: `nil` 表示 size class 尚未就绪；在 phone 上视为 compact，避免转场瞬间误显示底栏。
    static func shouldHide(
        requested: Bool,
        isPhone: Bool,
        isCompactWidth: Bool?
    ) -> Bool {
        let treatsAsCompact = isCompactWidth ?? isPhone
        return requested && isPhone && treatsAsCompact
    }
}
