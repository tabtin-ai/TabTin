import SwiftUI

/// 云文档一级入口内部的导航目标。
enum CloudDocsRoute: Hashable {
    case notifications
    case resource(CloudResourceOpenContext)
    case account(AccountGlobalPushDestination)
}

/// 云文档一级入口。
///
/// 对应 Electron 云文档域的第二列浏览面：三个浏览分段 + 搜索。
/// 主画布在移动端变成 push 出来的全屏编辑器，返回即回到浏览面。
///
/// 顶部布局与其余一级工作面统一：左三横杠菜单、标题走 `ttRootLeadingNavigationTitle` +
/// `TTRootTitleToolbarItem` 显式左对齐、右「新建」Menu + 通知；搜索走系统 `.searchable`。
/// 新建条目由 ``CloudDocsCreatableKind.enabledKinds`` 驱动，扩展类型不必改本文件布局。
///
/// 页面自上而下两段：
/// - 顶部 `segmentedControl`
/// - 中部 `content`：状态分支 →`segmentList`→ 各分段行；行操作由 `rowActions` 挂在行外
struct CloudDocsTabRoot: View {
    @State private var router = MainRouter.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var accountDrawerCoordinator = AccountDrawerCoordinator.shared
    @State private var vm = CloudDocsViewModel()
    @State private var path: [CloudDocsRoute] = []
    @State private var isSearchPresented = false
    /// 待确认的删除目标。挂在页面级而不是行上：行会随删除后的刷新消失，
    /// 弹窗跟着行走就会在用户还没确认时被一起卸载。
    @State private var pendingDeletion: CloudDocsDeletionTarget?
    /// 当前要设置分享的资源，同样挂页面级。
    @State private var shareTarget: CloudDocsShareTarget?
    /// 新建失败弹窗文案；与分段错误态隔离。
    @State private var createErrorAlert: String?

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                segmentedControl
                content
            }
            // 换分段就清掉搜索词：三个分段各搜各的列表，留着上一段的关键词
            // 会让用户以为新分段真的只有那么几条。
            .onChange(of: vm.browseView) { vm.searchText = "" }
            // 换组织就清空导航栈：组织能从个人页、通知中心等多处切换，不清的话
            // 切到 B 组织后屏幕上还开着 A 的文档，返回才发现底下已经换了组织。
            .onChange(of: workspace.selectedOrganizationId) {
                path.removeAll()
            }
            .searchable(
                text: $vm.searchText,
                isPresented: $isSearchPresented,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: L10n.CloudDocs.searchPlaceholder
            )
            .background(.tt.bgCanvasDefault)
            .ttRootLeadingNavigationTitle(L10n.Common.tabCloudDocs)
            .ttToolbarBackground()
            .ttDismissKeyboardOnContentTap()
            .toolbar {
                AccountDrawerToolbarLeadingItem()
                TTRootTitleToolbarItem(title: L10n.Common.tabCloudDocs)
                ToolbarItemGroup(placement: .topBarTrailing) {
                    createMenu
                    NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                        path.append(.notifications)
                    }
                }
            }
            .alert(
                L10n.Common.create,
                isPresented: Binding(
                    get: { createErrorAlert != nil },
                    set: { if !$0 { createErrorAlert = nil; vm.clearCreateError() } }
                )
            ) {
                Button(L10n.Common.confirm, role: .cancel) {
                    createErrorAlert = nil
                    vm.clearCreateError()
                }
            } message: {
                Text(createErrorAlert ?? "")
            }
            .navigationDestination(for: CloudDocsRoute.self) { route in
                switch route {
                case .notifications:
                    NotificationCenterScreen(onOpenConversation: { target in
                        path = []
                        router.openConversation(target)
                    }, onOpenIMConversation: { target in
                        path = []
                        router.openIMConversation(target)
                    })
                    .ttTabBarHidden(true)
                case .resource(let context):
                    SpaceAppRouteScreen(
                        route: context.route,
                        organizationId: context.organizationId,
                        spaceId: context.spaceId,
                        locationHint: context.spaceName
                    )
                    .ttTabBarHidden(true)
                case .account(let destination):
                    AccountGlobalPushDestinationScreen(
                        destination: destination,
                        onOpenConversation: { target in
                            path = []
                            router.openConversation(target)
                        },
                        onOpenIMConversation: { target in
                            path = []
                            router.openIMConversation(target)
                        }
                    )
                    .ttTabBarHidden(true)
                }
            }
            .refreshable { await reload() }
            .task(id: workspace.selectedOrganizationId) { await reload() }
            .task(id: router.resourceNavigationRevision) { await openPendingResourceIfNeeded() }
            .confirmationDialog(
                pendingDeletion?.title ?? "",
                isPresented: Binding(
                    get: { pendingDeletion != nil },
                    set: { if !$0 { pendingDeletion = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(L10n.CloudDocs.actionDelete, role: .destructive) {
                    guard let target = pendingDeletion else { return }
                    pendingDeletion = nil
                    Task {
                        await vm.delete(contextItemId: target.id)
                    }
                }
                Button(L10n.Common.cancel, role: .cancel) { pendingDeletion = nil }
            }
            .sheet(item: $shareTarget) { target in
                CloudDocsShareSheet(
                    type: target.type,
                    resourceId: target.id,
                    resourceTitle: target.title
                )
            }
        }
        .onChange(of: path.count) { _, count in
            router.setTabPushed(.cloudDocs, pushed: count > 0)
        }
        .onChange(of: accountDrawerCoordinator.pendingGlobalPushDestination) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onChange(of: router.selectedTab) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onAppear {
            consumePendingAccountGlobalPush()
        }
    }

    // MARK: - 顶部

    /// 右上角新建：条目来自 ``CloudDocsCreatableKind.enabledKinds``，新增类型不必改布局。
    /// 菜单图标与列表行同源，用无白底 `AppGlyph*`，不用 SF Symbol / 带底座 AppIcon。
    private var createMenu: some View {
        Menu {
            ForEach(CloudDocsCreatableKind.enabledKinds) { kind in
                Button {
                    Task { await create(kind) }
                } label: {
                    Label {
                        Text(kind.title)
                    } icon: {
                        AppIconImage(reference: kind.iconReference, size: 20)
                    }
                }
                .disabled(!vm.canCreate || vm.isCreating)
            }
        } label: {
            Image(systemName: "plus")
                .font(.tt.iconSubtitle)
        }
        .disabled(vm.isCreating)
        .accessibilityLabel(L10n.Common.create)
    }

    private func consumePendingAccountGlobalPush() {
        guard router.selectedTab == .cloudDocs,
              let destination = accountDrawerCoordinator.pendingGlobalPushDestination else { return }
        path.append(.account(destination))
        accountDrawerCoordinator.completeGlobalPushNavigation(destination)
    }

    private var segmentedControl: some View {
        Picker(L10n.Common.tabCloudDocs, selection: $vm.browseView) {
            ForEach(CloudDocsBrowseView.allCases) { view in
                Text(view.title).tag(view)
            }
        }
        .pickerStyle(.segmented)
        // 分段控件是顶部导航的一部分，而不是列表前的一张独立卡片。
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.xs)
        .background(.tt.bgCanvasDefault)
        .accessibilityLabel(L10n.Common.tabCloudDocs)
    }

    // MARK: - 分享

    /// 给一行算出分享回调；返回 nil 表示这行不出分享按钮。
    ///
    /// `canShare` 三态是有意的：
    /// - `false`：后端明确说没权限（editor / viewer），不出按钮
    /// - `true`：出
    /// - `nil`：拿不到能力位就出。只有 context-items 列表回填这一位，知识树接口
    ///   不吐，若把 `nil` 当 `false`，「全部」分段会整段没有分享入口。真无权限时
    ///   后端会回 403，面板显示 `shareForbidden`——这比凭一个缺失字段就砍掉入口好。
    ///
    /// 只有文档与表格有公开链接。TabFiles 只能邀请协作者，套同一套链接会生成
    /// 打不开的 URL，所以类型解析不出来就不给按钮。
    private func shareAction(
        itemType: String,
        resourceId: String?,
        title: String,
        canShare: Bool?
    ) -> (() -> Void)? {
        guard canShare != false,
              let resourceId, !resourceId.isEmpty,
              let type = CloudShareResourceType.from(
                  normalizedType: SpaceResource.normalizedType(itemType)
              )
        else { return nil }

        return { shareTarget = CloudDocsShareTarget(id: resourceId, type: type, title: title) }
    }

    /// “分享给我”使用的是另一套资源模型，不能用 context-item 的类型别名推断。
    /// 接收者无权继续分享时后端会明确回 `false`，此时不误导性地展示入口。
    private func shareAction(_ item: SharedResourceItem) -> (() -> Void)? {
        guard item.canShare != false, !item.resourceId.isEmpty else { return nil }

        let type: CloudShareResourceType
        switch item.resourceType {
        case .doc:
            type = .document
        case .table:
            type = .table
        case .file:
            return nil
        }

        return {
            shareTarget = CloudDocsShareTarget(
                id: item.resourceId,
                type: type,
                title: item.displayTitle
            )
        }
    }

    // MARK: - 行副标题

    /// 更新时间统一走相对时间，并标上「最近修改：」，避免行尾一个裸时间不知道指什么。
    private static func editedAt(_ raw: String?) -> String? {
        CloudDocsPresentation.lastModified(raw)
    }

    /// 「最近」列表使用真正的 per-user 访问时间，并明确标注语义。
    private static func recentlyAccessedAt(_ raw: String?) -> String? {
        guard let value = raw.flatMap({ RelativeTime.format($0) }) else { return nil }
        return L10n.CloudDocs.recentlyAccessedAt(value)
    }

    // MARK: - 内容

    /// 状态优先级：加载 > 分段错误 > 分段列表（含空态 / 搜索无结果）。
    @ViewBuilder
    private var content: some View {
        if vm.isLoading {
            loadingState
        } else if let message = segmentErrorMessage {
            errorState(message)
        } else {
            segmentList
        }
    }

    /// 错误按分段隔离，不做整页态。
    ///
    /// ViewModel 三路数据互不连坐（树 / 最近 / 分享各拉各的），视图这一层要是把
    /// 任一路的失败渲染成整页错误，那份隔离就白做了：分享接口挂掉会让树也一起空白。
    /// 「分享给我」用它自己的 `sharedErrorMessage`，否则分享失败会静默退化成空态，
    /// 用户以为没人分享给他，其实是没拉到。
    private var segmentErrorMessage: String? {
        switch vm.browseView {
        case .all, .recent: return vm.errorMessage
        case .shared: return vm.sharedErrorMessage
        }
    }

    @ViewBuilder
    private var segmentList: some View {
        switch vm.browseView {
        case .all:
            if vm.isSearching {
                rowList(vm.searchHits, empty: emptyCopy) { searchRow($0) }
            } else {
                rowList(vm.treeRows, empty: emptyCopy) { treeRow($0) }
            }
        case .recent:
            rowList(visibleRecentItems, empty: emptyCopy) { recentRow($0) }
        case .shared:
            rowList(visibleSharedItems, empty: emptyCopy) { sharedRow($0) }
        }
    }

    /// 列表外壳：空就出空态，否则铺行。三个分段共用同一套滚动与留白。
    ///
    /// 用 `List` 而不是 `ScrollView` + `LazyVStack`：左滑操作只在 List 的行上生效。
    ///
    /// 样式走 `.insetGrouped` 而不是 `.plain`：demo 里这些行装在一张浮在浅灰画布上的
    /// 白色圆角卡片里，而 `.insetGrouped` 的行背景、圆角、左右留白正好就是这套，
    /// 且深浅色都由系统跟着走，比自己画卡片再补一套配色可靠。画布色由外层 VStack 给，
    /// 所以要藏掉 List 自带的分组背景。
    ///
    /// 行内边距归零交给 `CloudDocsRow` 自己控制——树的层级缩进是加在行的左边距上的，
    /// 系统那份 inset 会把缩进顶歪。
    @ViewBuilder
    private func rowList<Item: Identifiable, Row: View>(
        _ items: [Item],
        empty: String,
        @ViewBuilder row: @escaping (Item) -> Row
    ) -> some View {
        if items.isEmpty {
            emptyState(empty)
        } else {
            List {
                ForEach(items) { item in
                    row(item)
                        .listRowInsets(EdgeInsets())
                        .alignmentGuide(.listRowSeparatorLeading) { _ in
                            CloudDocsRow.separatorLeadingInset
                        }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(TTSpacing.sm)
            .scrollContentBackground(.hidden)
            // insetGrouped 默认在首个 section 上方留一大片空白（给 header 用的），
            // 这里没有 header，留着会让卡片凭空往下掉一截。间距由分段控件的
            // bottom padding 给足，对齐 demo。
            .contentMargins(.top, 0, for: .scrollContent)
            // 系统默认左右 20pt，demo 是 16px；不改会跟分段控件差出 4pt 的错位。
            .contentMargins(.horizontal, TTSpacing.lg, for: .scrollContent)
        }
    }

    // MARK: - 行操作

    /// 给「我自己的」行挂上左滑与长按菜单。
    ///
    /// 挂在整行外层而不是 `CloudDocsRowShell` 内部：左滑由 List 的行接管，
    /// 与行内的整行 tap、展开箭头按钮各走各的手势通道，互不抢占。
    ///
    /// 分享给我的条目解析不出可操作 id，会原样返回不带操作的行——
    /// 那是别人的资源，删除和置顶都不成立。
    ///
    /// 分享保留在长按菜单，同时放到左滑操作中：不挤占行尾的信息密度，又能让移动端
    /// 与删除、置顶一样在单手操作时直接触达。
    @ViewBuilder
    private func rowActions<Content: View>(
        contextItemId rawId: String?,
        title: String,
        isPinned: Bool,
        onShare: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        if let id = CloudDocsRowActionTarget.manageableId(rawId) {
            content()
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    // 不给整滑直接删：删除是右滑到底最容易误触的位置，必须点一下再确认。
                    Button(role: .destructive) {
                        pendingDeletion = CloudDocsDeletionTarget(id: id, title: title)
                    } label: {
                        Label(L10n.CloudDocs.actionDelete, systemImage: "trash")
                    }
                    .tint(.tt.bgCritical)
                    pinButton(id: id, isPinned: isPinned)
                        .tint(.tt.bgAccent)
                    shareSwipeButton(onShare)
                }
                .contextMenu {
                    shareMenuButton(onShare)
                    pinButton(id: id, isPinned: isPinned)
                    Button(role: .destructive) {
                        pendingDeletion = CloudDocsDeletionTarget(id: id, title: title)
                    } label: {
                        Label(L10n.CloudDocs.actionDelete, systemImage: "trash")
                    }
                }
        } else if onShare != nil {
            content()
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    shareSwipeButton(onShare)
                }
                .contextMenu { shareMenuButton(onShare) }
        } else {
            content()
        }
    }

    /// 长按菜单里的分享项。
    ///
    /// 图标用 `link` 而不是系统分享图标 `square.and.arrow.up`：后者在 iOS 上同时
    /// 承担「导出到其他 App」，容易被读成上传；这里点开的面板管的是公开链接。
    @ViewBuilder
    private func shareMenuButton(_ onShare: (() -> Void)?) -> some View {
        if let onShare {
            Button {
                onShare()
            } label: {
                Label(L10n.CloudDocs.shareAction, systemImage: "link")
            }
        }
    }

    /// 左滑中的分享入口使用 success 色，与置顶（主操作）和删除（破坏性操作）明确区分。
    @ViewBuilder
    private func shareSwipeButton(_ onShare: (() -> Void)?) -> some View {
        if let onShare {
            Button {
                onShare()
            } label: {
                Label(L10n.CloudDocs.shareAction, systemImage: "link")
            }
            .tint(.tt.bgSuccess)
        }
    }

    /// 置顶按钮，左滑与长按菜单共用。
    ///
    /// 请求在途时禁用：`togglePin` 内部虽然也用 `pinningIds` 挡了重复请求，
    /// 但那是静默丢弃；这里同步把按钮灰掉，用户才知道上一次点击还在跑。
    private func pinButton(id: String, isPinned: Bool) -> some View {
        Button {
            Task { await vm.togglePin(contextItemId: id, isPinned: !isPinned) }
        } label: {
            Label(
                isPinned ? L10n.CloudDocs.actionUnpin : L10n.CloudDocs.actionPin,
                systemImage: isPinned ? "pin.slash" : "pin"
            )
        }
        .disabled(vm.pinningIds.contains(id))
    }

    // MARK: - 各分段的行

    private func treeRow(_ row: KnowledgeTreeFlatRow) -> some View {
        rowActions(
            contextItemId: row.node.contextItemId,
            title: row.node.displayTitle,
            isPinned: row.node.isPinned,
            // 知识树接口不回填能力位，这里一律传 nil 走「先给入口」那条。
            onShare: shareAction(
                itemType: row.node.nodeType.rawValue,
                resourceId: row.node.resourceId,
                title: row.node.displayTitle,
                canShare: nil
            )
        ) {
            CloudDocsRowShell(onOpen: { open(node: row.node) }) {
                CloudDocsRow(
                    title: row.node.displayTitle,
                    itemType: row.node.nodeType.rawValue,
                    subtitle: nil,
                    meta: Self.editedAt(row.node.updatedAt),
                    depth: row.depth,
                    isPinned: row.node.isPinned,
                    isExpandable: row.isExpandable,
                    isExpanded: vm.expandedNodeIds.contains(row.node.id),
                    isLoadingChildren: vm.loadingChildNodeIds.contains(row.node.id),
                    // 叶子节点没有展开操作，不该为了与文件夹对齐而额外空出一列；
                    // 否则“全部”页的文档图标会比最近 / 分享页明显向右偏。
                    reservesDisclosureSpace: row.isExpandable,
                    onToggleExpand: { Task { await vm.toggleExpansion(row.node) } }
                )
            }
        }
    }

    private func recentRow(_ resource: SpaceResource) -> some View {
        rowActions(
            contextItemId: resource.id,
            title: resource.displayTitle,
            isPinned: resource.isPinned ?? false,
            onShare: shareAction(
                itemType: resource.itemType,
                resourceId: resource.resourceId,
                title: resource.displayTitle,
                canShare: resource.canShare
            )
        ) {
            CloudDocsRowShell(onOpen: { open(resource: resource) }) {
                CloudDocsRow(
                    title: resource.displayTitle,
                    itemType: resource.itemType,
                    // 不显示所有者：个人空间里每一份都是自己的，一整列自己的名字
                    // 没有信息量。归属信息留给「分享给我」分段。
                    subtitle: Self.recentlyAccessedAt(resource.lastVisitedAt),
                    meta: nil,
                    isPinned: resource.isPinned ?? false,
                    reservesDisclosureSpace: false
                )
            }
        }
    }

    /// 分享给我的资源不提供删除、置顶；若服务端允许再分享，仍提供同样的分享入口。
    private func sharedRow(_ item: SharedResourceItem) -> some View {
        rowActions(
            contextItemId: nil,
            title: item.displayTitle,
            isPinned: false,
            onShare: shareAction(item)
        ) {
            CloudDocsRowShell(onOpen: { open(shared: item) }) {
                CloudDocsRow(
                    title: item.displayTitle,
                    itemType: item.resourceType.rawValue,
                    subtitle: nil,
                    meta: Self.editedAt(item.updatedAt),
                    sharer: CloudDocsPresentation.sharerAvatar(item.sharedBy),
                    reservesDisclosureSpace: false
                )
            }
        }
    }

    /// 搜索命中是展平的，没有展开列；`hit.path` 只有祖先链，标题另取。
    ///
    /// 命中的仍是知识树里那份资源，所以行操作跟着一起给：搜一下就管不了自己的文档，
    /// 用户会以为是权限出了问题。
    private func searchRow(_ hit: KnowledgeTreeSearchHit) -> some View {
        rowActions(
            contextItemId: hit.node.contextItemId,
            title: hit.node.displayTitle,
            isPinned: hit.node.isPinned,
            onShare: shareAction(
                itemType: hit.node.nodeType.rawValue,
                resourceId: hit.node.resourceId,
                title: hit.node.displayTitle,
                canShare: nil
            )
        ) {
            CloudDocsRowShell(onOpen: { open(node: hit.node) }) {
                CloudDocsRow(
                    title: hit.node.displayTitle,
                    itemType: hit.node.nodeType.rawValue,
                    subtitle: hit.path.isEmpty ? nil : hit.path.joined(separator: " / "),
                    meta: Self.editedAt(hit.node.updatedAt),
                    isPinned: hit.node.isPinned,
                    reservesDisclosureSpace: false
                )
            }
        }
    }

    // MARK: - 搜索

    /// 搜索只在当前分段里搜。
    ///
    /// `vm.searchHits` 是知识树的命中，分享项压根不在树里；三个分段共用它的话，
    /// 用户在「分享给我」输入关键词会得到一批与该分段无关的结果。
    private var visibleRecentItems: [SpaceResource] {
        vm.recentItems.filter { matchesSearch($0.displayTitle) }
    }

    private var visibleSharedItems: [SharedResourceItem] {
        vm.sharedItems.filter { matchesSearch($0.displayTitle) }
    }

    private func matchesSearch(_ title: String) -> Bool {
        guard vm.isSearching else { return true }
        let keyword = vm.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.localizedCaseInsensitiveContains(keyword)
    }

    // MARK: - 状态块

    /// 搜索态下三段共用「没有匹配的结果」，非搜索态各说各的空。
    private var emptyCopy: String {
        guard !vm.isSearching else { return L10n.CloudDocs.emptySearch }
        switch vm.browseView {
        case .all: return L10n.CloudDocs.emptyAll
        case .recent: return L10n.CloudDocs.emptyRecent
        case .shared: return L10n.CloudDocs.emptyShared
        }
    }

    /// 状态块也放进可回弹的 ScrollView：否则空态 / 错误态下没有可滚动内容，
    /// 页面级的下拉刷新会失效，用户在空账号里连重试的手势都没有。
    private func stateBlock<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(spacing: TTSpacing.md) {
                content()
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.huge)
        }
        .scrollBounceBehavior(.always)
    }

    private var loadingState: some View {
        stateBlock {
            ProgressView()
            Text(L10n.Common.loading)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
        }
    }

    private func errorState(_ message: String) -> some View {
        // 保留 stateBlock 的 ScrollView 包装：错误态下仍要能下拉刷新。
        stateBlock {
            TTErrorStateView(message: message, prominence: .inline) {
                Task { await reload() }
            }
        }
    }

    private func emptyState(_ text: String) -> some View {
        stateBlock {
            CloudDocsAppIcon(itemType: "tabdoc", size: TTSpacing.huge)
                .opacity(0.4)
            Text(text)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - 动作

    private func create(_ kind: CloudDocsCreatableKind) async {
        guard let created = await vm.create(kind) else {
            if let message = vm.createErrorMessage {
                createErrorAlert = message
            }
            return
        }
        guard let organizationId = workspace.selectedOrganizationId else { return }
        path.append(
            .resource(
                CloudResourceOpenContext(
                    id: created.resourceId,
                    organizationId: organizationId,
                    spaceId: nil,
                    spaceName: nil,
                    route: created.route
                )
            )
        )
    }

    private func reload() async {
        // 根视图正常会先拉组织；这里兜住「组织还没拉过」的时序，
        // 否则首帧拿不到 organizationId 就永远停在空态。
        if !workspace.didAttemptOrganizationLoad {
            await workspace.loadOrganizations()
        }
        guard let organizationId = workspace.selectedOrganizationId,
              !organizationId.isEmpty else { return }
        await vm.load(organizationId: organizationId)
    }

    private func open(node: KnowledgeTreeNode) {
        // 不必再守 resourceId：`appRoute` 拿不到非空 resourceId 时本身就返回 nil。
        guard let organizationId = workspace.selectedOrganizationId,
              let route = node.appRoute else { return }
        vm.recordAccess(contextItemId: node.contextItemId)
        let context = CloudResourceOpenContext(
            id: node.id,
            organizationId: organizationId,
            spaceId: nil,
            spaceName: nil,
            route: route
        )
        path.append(.resource(context))
    }

    private func open(resource: SpaceResource) {
        guard let organizationId = workspace.selectedOrganizationId,
              let route = resource.appRoute else { return }
        vm.recordAccess(contextItemId: resource.id)
        let context = CloudResourceOpenContext(
            id: resource.id,
            organizationId: organizationId,
            spaceId: resource.spaceId,
            spaceName: resource.spaceName,
            route: route
        )
        path.append(.resource(context))
    }

    private func open(shared item: SharedResourceItem) {
        guard let route = item.appRoute else { return }
        let context = CloudResourceOpenContext(
            id: item.id,
            organizationId: item.organizationId,
            spaceId: item.spaceId,
            spaceName: nil,
            route: route
        )
        path.append(.resource(context))
    }

    /// 消费从通知 / 其他页面跳过来的「打开某个资源」意图。
    ///
    /// 深链只能在当前组织内打开。链接属于另一个组织时消费意图并提示用户先明确
    /// 切换组织，不能替用户静默改变租户上下文。每一步之后都重新核对
    /// `pendingResource` 没变：中途用户可能又点了另一条通知，此时旧意图应作废。
    private func openPendingResourceIfNeeded() async {
        guard let target = router.pendingResource else { return }
        await CloudResourceDeepLinkCoordinator.open(
            targetOrganizationId: target.organizationId,
            snapshot: {
                CloudResourceDeepLinkPolicy.Snapshot(
                    currentOrganizationId: workspace.selectedOrganizationId,
                    availableOrganizationIds: Set(workspace.organizations.map(\.id)),
                    hasAuthoritativeOrganizationList: workspace.hasLoadedOrganizations
                )
            },
            refreshOrganizations: { await workspace.loadOrganizations() },
            loadResources: { await vm.load(organizationId: target.organizationId) },
            isCurrent: { router.pendingResource == target },
            consume: { router.consumeResource(target) },
            notify: { router.presentNavigationNotice($0) }
        ) {
            let request = SpaceResourceOpenRequest(
                resourceType: target.resourceType,
                resourceId: target.resourceId,
                title: target.title,
                locationHint: target.locationHint
            )
            // 优先拿已加载的那份资源解析路由：它带着 metadata（例如 TabSite 的
            // 发布地址）。解析不出来说明这个类型 iOS 还打不开，不能静默吞掉。
            guard let route = request.route(in: vm.allRecentItems) else {
                router.consumeResource(target)
                router.presentNavigationNotice(request.unsupportedOpenNotice)
                return
            }
            let context = CloudResourceOpenContext(
                id: target.resourceId,
                organizationId: target.organizationId,
                spaceId: target.spaceId,
                spaceName: target.spaceId.flatMap { hostId in
                    workspace.spaces.first(where: { $0.id == hostId })?.name
                }
                    ?? target.locationHint,
                route: route
            )
            path = [.resource(context)]
            router.consumeResource(target)
        }
    }
}

/// 行操作（置顶 / 删除）的目标解析。
///
/// 只有本组织的 context-item 才能被管理。分享给我的条目 id 是 `shared:` 前缀的合成值
/// （见 `SharedResourceItem.id`），既打不通 context-item 接口，语义上也不该让接收方
/// 删掉别人的东西——解析不出目标，那一行就不长出任何操作。
enum CloudDocsRowActionTarget {
    static func manageableId(_ rawId: String?) -> String? {
        guard let trimmed = rawId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              !trimmed.hasPrefix("shared:") else { return nil }
        return trimmed
    }
}

/// 待确认的删除目标。`id` 是 context-item id，`title` 只用于确认弹窗的抬头，
/// 让用户看清自己删的是哪一份。
private struct CloudDocsDeletionTarget {
    let id: String
    let title: String
}

/// 分享面板的目标资源。`id` 是资源本体 id（document_id / table_id），不是
/// context-item id——分享接口挂在资源上。
///
/// 同样挂页面级：面板打开后列表可能刷新，跟着行走会被连带卸载。
private struct CloudDocsShareTarget: Identifiable, Hashable {
    let id: String
    let type: CloudShareResourceType
    let title: String
}

/// 列表行的交互外壳：整行可点即打开。
///
/// 不能用 `Button` 包整行——`CloudDocsRow` 的展开箭头本身是个 `Button`，
/// 塞进另一个 Button 的 label 里就再也收不到点击，知识树会永远展不开。
/// 改用整行 tap 手势后，箭头按钮仍独立命中。
/// 行操作（置顶 / 删除 / 长按菜单）挂在这层外面，见 `CloudDocsTabRoot.rowActions`。
private struct CloudDocsRowShell<Content: View>: View {
    let onOpen: () -> Void
    let content: Content

    init(onOpen: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.onOpen = onOpen
        self.content = content()
    }

    var body: some View {
        content
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .accessibilityAddTraits(.isButton)
    }
}
