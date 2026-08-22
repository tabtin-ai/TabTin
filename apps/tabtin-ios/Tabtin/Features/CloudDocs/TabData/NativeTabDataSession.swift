import Foundation
import os

enum NativeTabDataSaveState: Equatable, Sendable {
    case idle
    case dirty
    case saving
    case saved
    case conflict
    case permissionDenied
    case failed
}

@MainActor @Observable
final class NativeTabDataSession {
    typealias MetadataResponse = (
        table: NativeTabDataTable,
        fields: NativeTabDataFieldList,
        views: NativeTabDataViewList
    )
    typealias MetadataRequest = @MainActor (String) async throws -> MetadataResponse
    typealias RecordsRequest = @MainActor (String, String?, [String: String]) async throws -> NativeTabDataRecordList
    typealias UpdateRequest = @MainActor (String, NativeTabDataRecordDraft) async throws -> NativeTabDataRecordUpdateResult
    typealias CreateRequest = @MainActor (NativeTabDataRecordDraft) async throws -> NativeTabDataRecord
    typealias DeleteRequest = @MainActor (NativeTabDataDeleteRequest) async throws -> Void
    typealias CreateFieldRequest = @MainActor (NativeTabDataCreateFieldRequest) async throws -> NativeTabDataField
    typealias IdentitySnapshotsRequest = @MainActor (String) async throws -> NativeTabDataIdentitySnapshotList
    typealias BatchProfilesRequest = @MainActor (String, [String]) async throws -> [NativeTabDataBatchProfile]
    typealias MemberSearchRequest = @MainActor (String, [String: String]) async throws -> OrganizationMemberListResponse

    static let pageSize = 30
    static let groupPageSize = 20

    let tableId: String
    let organizationId: String

    private(set) var table: NativeTabDataTable?
    private(set) var fields: [NativeTabDataField] = []
    private(set) var views: [NativeTabDataView] = []
    private(set) var records: [NativeTabDataRecord] = []
    private(set) var groups: [NativeTabDataRecordGroup] = []
    private(set) var selectedViewId: String?
    private(set) var searchText = ""
    private(set) var filterRules: [NativeTabDataFilterRule] = []
    private(set) var filterLogic: NativeTabDataFilterLogic = .and
    private(set) var sortRule: NativeTabDataSortRule?
    private(set) var currentPage = 1
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var loadError: String?
    private(set) var saveState: NativeTabDataSaveState = .idle
    private(set) var saveError: String?
    private(set) var saveNotice: String?
    private(set) var isCreatingField = false
    private(set) var fieldCreationError: String?
    private(set) var memberDirectory = NativeTabDataMemberDirectory.empty
    /// 详情 sheet 由 View 层的 `selectedRecordId` 驱动，Session 自己看不到；
    /// 实时删除要判断「这条正被用户看着吗」，所以让 View 把它同步进来。
    private(set) var openRecordId: String?

    private let draftStore: NativeTabDataDraftStore
    private let userId: String
    private let sessionFence: NativeCloudSessionFence
    private let sessionIsCurrent: @MainActor () -> Bool
    private let metadataRequest: MetadataRequest
    private let recordsRequest: RecordsRequest
    private let updateRequest: UpdateRequest
    private let createRequest: CreateRequest
    private let deleteRequest: DeleteRequest
    private let createFieldRequest: CreateFieldRequest
    private let identitySnapshotsRequest: IdentitySnapshotsRequest
    private let batchProfilesRequest: BatchProfilesRequest
    private let memberSearchRequest: MemberSearchRequest
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "NativeTabData")
    private var drafts: [String: NativeTabDataRecordDraft] = [:]
    private var operationGate = NativeTabDataOperationGate()
    private let realtimeListenerKey: String
    private var subscribedRealtimeTopic: String?
    private var pendingMutationRecordIds: Set<String> = []
    private var realtimeRefreshTask: Task<Void, Never>?
    /// 结构事件到达后等刷新完成再择一提示，避免先闪「表结构已更新」再被点名盖掉。
    /// 只在 `.reloadSchema` 置位；普通刷新（首次打开 / 下拉 / 写失败重拉）不得消费出通用文案。
    private var pendingSchemaNotice = false

    init(
        tableId: String,
        organizationId: String,
        draftStore: NativeTabDataDraftStore = NativeTabDataDraftStore(),
        userId: String? = nil,
        sessionGeneration: UInt64? = nil,
        sessionIsCurrent: (@MainActor () -> Bool)? = nil,
        metadataRequest: MetadataRequest? = nil,
        recordsRequest: RecordsRequest? = nil,
        updateRequest: UpdateRequest? = nil,
        createRequest: CreateRequest? = nil,
        deleteRequest: DeleteRequest? = nil,
        createFieldRequest: CreateFieldRequest? = nil,
        identitySnapshotsRequest: IdentitySnapshotsRequest? = nil,
        batchProfilesRequest: BatchProfilesRequest? = nil,
        memberSearchRequest: MemberSearchRequest? = nil
    ) {
        self.tableId = tableId
        self.organizationId = organizationId
        self.draftStore = draftStore
        self.realtimeListenerKey = "tabdata-\(organizationId)-\(tableId)-\(UUID().uuidString)"
        let resolvedUserId = userId ?? AuthService.shared.currentUser?.id ?? "anonymous"
        let resolvedGeneration = sessionGeneration ?? AuthService.shared.sessionGeneration
        self.userId = resolvedUserId
        self.sessionFence = NativeCloudSessionFence(
            userId: resolvedUserId,
            generation: resolvedGeneration,
            organizationId: organizationId
        )
        self.sessionIsCurrent = sessionIsCurrent ?? {
            let auth = AuthService.shared
            return NativeCloudSessionFence(
                userId: resolvedUserId,
                generation: resolvedGeneration,
                organizationId: organizationId
            ).matches(
                userId: auth.currentUser?.id,
                generation: auth.sessionGeneration,
                organizationId: WorkspaceStore.shared.selectedOrganizationId
            )
        }
        self.metadataRequest = metadataRequest ?? { tableId in
            async let table: NativeTabDataTable = APIClient.shared.get(path: Endpoints.TabData.table(tableId))
            async let fields: NativeTabDataFieldList = APIClient.shared.get(path: Endpoints.TabData.fields(tableId: tableId))
            async let views: NativeTabDataViewList = APIClient.shared.get(path: Endpoints.TabData.views(tableId: tableId))
            return try await (table, fields, views)
        }
        self.recordsRequest = recordsRequest ?? { tableId, viewId, query in
            if let viewId {
                return try await APIClient.shared.get(
                    path: Endpoints.TabData.viewRecords(viewId),
                    query: query
                )
            }
            return try await APIClient.shared.get(
                path: Endpoints.TabData.records(tableId: tableId),
                query: query
            )
        }
        self.updateRequest = updateRequest ?? { recordId, draft in
            let response: NativeTabDataBulkUpdateResponse = try await APIClient.shared.post(
                path: Endpoints.TabData.recordsBulkUpdate,
                body: draft.bulkUpdateBody(),
                query: ["field_key_type": "id"]
            )
            if response.hasErrors {
                throw APIError.serverError(400, "bulk-update errors")
            }
            guard let record = response.records.first(where: { $0.id == recordId }) else {
                throw APIError.serverError(400, "bulk-update missing record")
            }
            return NativeTabDataRecordUpdateResult(
                record: record,
                conflicts: response.conflicts.filter { $0.recordId == recordId || $0.recordId.isEmpty }
            )
        }
        self.createRequest = createRequest ?? { draft in
            try await APIClient.shared.post(
                path: Endpoints.TabData.recordsCreate,
                body: draft.createBody()
            )
        }
        self.deleteRequest = deleteRequest ?? { request in
            let _: MessageResponse = try await APIClient.shared.delete(
                path: Endpoints.TabData.record(request.recordId),
                query: request.query
            )
        }
        self.createFieldRequest = createFieldRequest ?? { request in
            try await APIClient.shared.post(
                path: Endpoints.TabData.fieldsCreate,
                body: request.body
            )
        }
        self.identitySnapshotsRequest = identitySnapshotsRequest ?? { organizationId in
            try await APIClient.shared.get(
                path: Endpoints.Context.organizationMemberIdentitySnapshots(organizationId)
            )
        }
        self.batchProfilesRequest = batchProfilesRequest ?? { organizationId, userIds in
            try await APIClient.shared.post(
                path: Endpoints.Context.organizationMemberBatchProfiles(organizationId),
                body: ["user_ids": userIds]
            )
        }
        self.memberSearchRequest = memberSearchRequest ?? { organizationId, query in
            try await APIClient.shared.get(
                path: Endpoints.Context.organizationMembersSearch(organizationId),
                query: query
            )
        }
        drafts = Dictionary(uniqueKeysWithValues: draftStore
            .loadAll(tableId: tableId, userId: self.userId, organizationId: organizationId)
            .map { ($0.recordId, $0) })
        if !drafts.isEmpty { saveState = .dirty }
    }

    var canEdit: Bool {
        sessionIsCurrent()
            && !operationGate.isMutationInFlight
            && NativeTabDataWritePolicy.canEditRecords(
                tableCanEdit: table?.canEdit == true,
                saveState: saveState
            )
    }

    var hasDirtyDrafts: Bool {
        drafts.values.contains { $0.canSubmit }
            || draftStore.hasDraft(tableId: tableId, userId: userId, organizationId: organizationId)
    }
    var hasResumableCreationDraft: Bool {
        drafts.values.contains { $0.isCreation && $0.canSubmit }
    }
    var creationEntry: NativeTabDataCreationEntry {
        NativeTabDataCreationEntryPolicy.resolve(
            canEdit: canEdit,
            hasResumableCreationDraft: hasResumableCreationDraft
        )
    }
    var localDraftSnapshots: [NativeTabDataLocalDraftSnapshot] {
        drafts.values
            .filter(\.canSubmit)
            .map { $0.readOnlySnapshot(fields: fields, directory: memberDirectory) }
            .sorted { lhs, rhs in
                if lhs.isCreation != rhs.isCreation { return lhs.isCreation }
                return lhs.recordId < rhs.recordId
            }
    }
    var selectedView: NativeTabDataView? {
        views.first { $0.id == selectedViewId } ?? views.first
    }
    var supportsNativeCards: Bool { selectedView?.supportsNativeCards ?? true }
    var isKanban: Bool { selectedView?.isKanban == true }
    var visibleFields: [NativeTabDataField] {
        NativeTabDataViewProjection.visibleFields(fields: fields, view: selectedView)
    }
    var canLoadMore: Bool {
        !isKanban && records.count < total && !isLoadingMore && !operationGate.isMutationInFlight
    }
    var hasActiveQuery: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !filterRules.isEmpty
            || sortRule != nil
    }
    var visibleRecordIds: [String] {
        allVisibleRecords.map(\.id)
    }

    @discardableResult
    func validateSession() -> Bool {
        requireCurrentSession()
    }

    func warmUpMemberDirectory() async {
        guard requireCurrentSession() else { return }
        let store = NativeTabDataMemberDirectoryStore.shared
        let workspaceMembers = WorkspaceStore.shared.selectedOrganizationId == organizationId
            ? WorkspaceStore.shared.members
            : []
        publishDirectory(store: store, workspaceMembers: workspaceMembers)

        if store.cachedSnapshots(for: organizationId) == nil {
            do {
                let response = try await identitySnapshotsRequest(organizationId)
                guard requireCurrentSession() else { return }
                store.replaceSnapshots(
                    organizationId: organizationId,
                    snapshots: response.identities.map(\.snapshot)
                )
            } catch {
                logger.warning(
                    "Identity snapshots failed table=\(self.tableId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
                )
            }
        }

        publishDirectory(store: store, workspaceMembers: workspaceMembers)
        let knownIds = Set(memberDirectory.members.map(\.userId))
            .union(memberDirectory.identitySnapshots.map(\.userId))
        let pending = store.pendingProfileIds(
            organizationId: organizationId,
            userIds: NativeTabDataMemberDirectoryResolver.collectUserIds(
                from: allVisibleRecords,
                fields: fields
            ),
            knownIds: knownIds
        )
        for chunk in NativeTabDataMemberDirectoryBatching.uniquedChunks(pending) {
            do {
                let profiles = try await batchProfilesRequest(organizationId, chunk)
                guard requireCurrentSession() else { return }
                store.mergeProfiles(
                    organizationId: organizationId,
                    profiles: profiles.compactMap(\.directoryMember)
                )
                store.markLookedUp(organizationId: organizationId, userIds: chunk)
            } catch {
                logger.warning(
                    "Batch profiles failed table=\(self.tableId, privacy: .public) count=\(chunk.count, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
                )
            }
        }
        publishDirectory(store: store, workspaceMembers: workspaceMembers)
        logger.info(
            "Member directory ready table=\(self.tableId, privacy: .public) members=\(self.memberDirectory.members.count, privacy: .public) snapshots=\(self.memberDirectory.identitySnapshots.count, privacy: .public)"
        )
    }

    private var allVisibleRecords: [NativeTabDataRecord] {
        isKanban ? groups.flatMap(\.records) : records
    }

    private func publishDirectory(
        store: NativeTabDataMemberDirectoryStore,
        workspaceMembers: [OrganizationMember]
    ) {
        memberDirectory = store.directory(
            organizationId: organizationId,
            workspaceMembers: workspaceMembers
        )
    }

    /// 失败时抛出而不是返回空页：调用方要能区分「请求失败」和「确实没有匹配的成员」，
    /// 否则搜索出错会被渲染成「没有匹配的成员」，用户以为组织里没这个人。
    func searchOrganizationMembers(
        search: String,
        offset: Int = 0
    ) async throws -> (members: [NativeTabDataDirectoryMember], total: Int) {
        guard requireCurrentSession() else { return ([], 0) }
        do {
            let response = try await memberSearchRequest(
                organizationId,
                NativeTabDataMemberPickerPolicy.searchQuery(search: search, offset: offset)
            )
            guard requireCurrentSession() else { return ([], 0) }
            let profiles = response.members.compactMap { NativeTabDataMemberPickerPolicy.directoryMember(from: $0) }
            let store = NativeTabDataMemberDirectoryStore.shared
            store.mergeProfiles(organizationId: organizationId, profiles: profiles)
            let workspaceMembers = WorkspaceStore.shared.selectedOrganizationId == organizationId
                ? WorkspaceStore.shared.members
                : []
            publishDirectory(store: store, workspaceMembers: workspaceMembers)
            return (profiles, response.total ?? profiles.count)
        } catch {
            logger.warning(
                "Member search failed table=\(self.tableId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
            )
            throw error
        }
    }

    func load() async {
        guard requireCurrentSession() else { return }
        guard let token = beginReplacingQuery() else { return }
        await loadMetadataAndRecords(token: token, clearsContentBeforeRequest: true)
    }

    func refresh() async {
        guard requireCurrentSession() else { return }
        guard let token = beginReplacingQuery() else { return }
        await loadMetadataAndRecords(token: token, clearsContentBeforeRequest: false)
    }

    func startRealtime() {
        guard requireCurrentSession() else { return }
        let topic = NativeTabDataRealtimePolicy.topic(tableId: tableId)
        if subscribedRealtimeTopic == topic { return }
        if let previous = subscribedRealtimeTopic {
            RealtimeGateway.shared.unsubscribe([previous])
        }
        subscribedRealtimeTopic = topic
        RealtimeGateway.shared.addEnvelopeListener(key: realtimeListenerKey) { [weak self] envelope in
            self?.handleRealtimeEnvelope(envelope)
        }
        RealtimeGateway.shared.addReconnectListener(key: realtimeListenerKey) { [weak self] in
            self?.scheduleRealtimeRefresh()
        }
        RealtimeGateway.shared.subscribe([topic])
    }

    func stopRealtime() {
        realtimeRefreshTask?.cancel()
        realtimeRefreshTask = nil
        RealtimeGateway.shared.removeEnvelopeListener(key: realtimeListenerKey)
        RealtimeGateway.shared.removeReconnectListener(key: realtimeListenerKey)
        if let topic = subscribedRealtimeTopic {
            RealtimeGateway.shared.unsubscribe([topic])
            subscribedRealtimeTopic = nil
        }
    }

    func handleRealtimeEnvelope(_ envelope: WSEnvelope) {
        guard requireCurrentSession() else { return }
        switch NativeTabDataRealtimePolicy.decide(envelope: envelope, context: realtimeContext()) {
        case .ignore, .skipOwnChange:
            return
        case .refresh:
            scheduleRealtimeRefresh()
        case .reloadSchema:
            // 别人改了字段/视图时用户不一定察觉（少看一列、筛选变了）。
            // 自己刚在本机建字段时 createField 已经 refresh，不必再弹提示。
            // 提示延后到刷新完成：有剔除就点名，没有才说「表结构已更新」，只出一条。
            if !isCreatingField {
                pendingSchemaNotice = true
            }
            scheduleRealtimeRefresh()
        case .apply(let plan):
            applyRealtimePlan(plan)
        }
    }

    func clearFieldCreationError() {
        fieldCreationError = nil
    }

    @discardableResult
    func createField(
        name: String,
        fieldType: NativeTabDataCreateFieldType,
        choices: [String] = []
    ) async -> Bool {
        guard requireCurrentSession(), canEdit else { return false }
        let request = NativeTabDataCreateFieldRequest(
            tableId: tableId,
            name: name,
            fieldType: fieldType,
            choices: choices
        )
        if let validationError = request.validationError(existingFields: fields) {
            fieldCreationError = fieldCreationMessage(for: validationError)
            return false
        }
        guard let token = beginMutation() else { return false }
        isCreatingField = true
        fieldCreationError = nil
        do {
            let created = try await createFieldRequest(request)
            guard operationGate.accepts(token), requireCurrentSession() else {
                isCreatingField = false
                return false
            }
            guard created.name == request.name,
                  created.fieldType.rawValue == request.fieldType.rawValue
            else {
                finishMutation(token)
                isCreatingField = false
                fieldCreationError = L10n.TabData.fieldCreateFailed
                return false
            }
            finishMutation(token)
            await refresh()
            guard requireCurrentSession() else {
                isCreatingField = false
                return false
            }
            let isConfirmed = fields.contains { field in
                field.id == created.id
                    && field.name == request.name
                    && field.fieldType.rawValue == request.fieldType.rawValue
            }
            isCreatingField = false
            guard isConfirmed else {
                fieldCreationError = loadError ?? L10n.TabData.fieldCreateRefreshFailed
                return false
            }
            fieldCreationError = nil
            return true
        } catch {
            guard operationGate.accepts(token), requireCurrentSession() else {
                isCreatingField = false
                return false
            }
            if NativeTabDataSaveFailurePolicy.requiresMetadataRevalidationAfterWriteFailure(error) {
                await revalidateAfterWriteDenial(mutationToken: token)
            } else {
                finishMutation(token)
            }
            isCreatingField = false
            fieldCreationError = error.localizedDescription
            logger.error(
                "Create field failed table=\(self.tableId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
            )
            return false
        }
    }

    private func loadMetadataAndRecords(
        token: NativeTabDataOperationGate.Token,
        clearsContentBeforeRequest: Bool,
        followsWriteDenial: Bool = false
    ) async {
        isLoading = true
        defer {
            if operationGate.accepts(token) { isLoading = false }
        }
        loadError = nil
        if clearsContentBeforeRequest {
            records = []
            groups = []
        }
        do {
            let metadata = try await metadataRequest(tableId)
            let loadedTable = metadata.table
            let fieldList = metadata.fields
            let viewList = metadata.views
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            guard NativeCloudOrganizationBoundary.matches(
                resourceOrganizationId: loadedTable.organizationId,
                expectedOrganizationId: organizationId
            ) else {
                clearProtectedData()
                loadError = L10n.TabData.permissionMessage
                return
            }
            guard loadedTable.id == tableId else {
                rejectMismatchedReadResponse()
                return
            }
            let loadedFields = fieldList.fields.sorted { $0.order < $1.order }
            let loadedViews = viewList.views.sorted { $0.order < $1.order }
            let preferredViewId = NativeTabDataViewSelection.preferredViewId(
                current: selectedViewId,
                defaultViewId: loadedTable.defaultViewId,
                views: loadedViews
            )
            // 覆盖 fields 之前留旧快照：被删字段在新结构里已经没了，点名告知要靠这份。
            let previousFields = fields
            table = loadedTable
            fields = loadedFields
            views = loadedViews
            selectedViewId = preferredViewId
            discardInvalidLocalQueryRules()
            reconcileDraftsAfterMetadataRefresh(previousFields: previousFields)
            if followsWriteDenial { retainDraftsAfterWriteDenial() }
            let response = try await fetchRecords(
                page: 1,
                groupOffsets: [:]
            )
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            currentPage = 1
            applyRecords(response, appending: false)
            if followsWriteDenial {
                retainDraftsAfterWriteDenial()
            }
        } catch {
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            if error is NativeTabDataReadIdentityError {
                rejectMismatchedReadResponse()
                return
            }
            if NativeTabDataSaveFailurePolicy.mustPurgeProtectedDataAfterReadFailure(error) {
                clearProtectedData()
            } else if followsWriteDenial {
                retainDraftsAfterWriteDenial()
            }
            loadError = error.localizedDescription
            logger.error("Load failed table=\(self.tableId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        }
    }

    func selectView(_ viewId: String) async {
        guard requireCurrentSession() else { return }
        guard !operationGate.isMutationInFlight else { return }
        guard selectedViewId != viewId else { return }
        selectedViewId = viewId
        searchText = ""
        filterRules = []
        filterLogic = viewConfiguredFilterLogic
        sortRule = nil
        currentPage = 1
        await reloadQuery()
    }

    func search(_ value: String) async {
        guard requireCurrentSession() else { return }
        guard !operationGate.isMutationInFlight else { return }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized != searchText else { return }
        searchText = normalized
        currentPage = 1
        await reloadQuery()
    }

    func applyFilter(_ rules: [NativeTabDataFilterRule], logic: NativeTabDataFilterLogic) async {
        guard requireCurrentSession() else { return }
        guard !operationGate.isMutationInFlight else { return }
        filterRules = NativeTabDataFilterQueryPolicy.sanitized(rules)
        filterLogic = filterRules.isEmpty ? viewConfiguredFilterLogic : logic
        currentPage = 1
        await reloadQuery()
    }

    func addFilter(_ rule: NativeTabDataFilterRule) async {
        await applyFilter(
            NativeTabDataFilterQueryPolicy.replacing(filterRules, with: rule),
            logic: filterLogic
        )
    }

    func removeFilter(fieldId: String) async {
        await applyFilter(filterRules.filter { $0.fieldId != fieldId }, logic: filterLogic)
    }

    func clearFilters() async {
        await applyFilter([], logic: viewConfiguredFilterLogic)
    }

    func setFilterLogic(_ logic: NativeTabDataFilterLogic) async {
        guard logic != filterLogic else { return }
        await applyFilter(filterRules, logic: logic)
    }

    func applySort(_ rule: NativeTabDataSortRule?) async {
        guard requireCurrentSession() else { return }
        guard !operationGate.isMutationInFlight else { return }
        sortRule = rule
        currentPage = 1
        await reloadQuery()
    }

    func loadMore() async {
        guard requireCurrentSession() else { return }
        guard canLoadMore else { return }
        guard let token = operationGate.beginIndependentQuery() else { return }
        let nextPage = currentPage + 1
        isLoadingMore = true
        await loadRecords(token: token, page: nextPage, appending: true)
        if operationGate.accepts(token) { isLoadingMore = false }
    }

    func loadMore(in group: NativeTabDataRecordGroup) async {
        guard requireCurrentSession() else { return }
        guard isKanban, group.hasMore, let index = groups.firstIndex(where: { $0.id == group.id }) else { return }
        guard let token = operationGate.beginIndependentQuery() else { return }
        let current = groups[index]
        let newOffset = NativeTabDataGroupPagination.nextOffset(for: current)
        do {
            let response = try await fetchRecords(page: 1, groupOffsets: [current.offsetKey: newOffset])
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            guard let incoming = response.metadata?.groups.first(where: { $0.id == current.id }) else { return }
            guard let currentIndex = groups.firstIndex(where: { $0.id == current.id }) else { return }
            let known = Set(groups[currentIndex].records.map(\.id))
            groups[currentIndex].records.append(contentsOf: incoming.records.filter { !known.contains($0.id) })
            groups[currentIndex].offset = incoming.offset
            groups[currentIndex].hasMore = incoming.hasMore
        } catch {
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            if error is NativeTabDataReadIdentityError {
                rejectMismatchedReadResponse()
                return
            }
            clearProtectedDataIfNeeded(error)
            loadError = error.localizedDescription
        }
    }

    func setOpenRecordId(_ recordId: String?) {
        openRecordId = recordId
    }

    func record(id: String) -> NativeTabDataRecord? {
        records.first { $0.id == id }
            ?? groups.lazy.flatMap(\.records).first { $0.id == id }
    }

    func draft(for record: NativeTabDataRecord) -> NativeTabDataRecordDraft {
        if let inMemory = drafts[record.id] { return inMemory }
        if let persisted = draftStore.load(
            recordId: record.id,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        ) {
            return persisted
        }
        return NativeTabDataRecordDraft(
            record: record,
            tableId: tableId,
            organizationId: organizationId,
            fields: fields
        )
    }

    func value(record: NativeTabDataRecord, field: NativeTabDataField) -> NativeTabDataValue {
        let latest = self.record(id: record.id) ?? record
        let remote = NativeTabDataValue.parse(latest.fields[field.id] ?? latest.fields[field.name], field: field)
        guard field.fieldType.isEditable else { return remote }
        let draft = storedDraft(for: latest.id)
        return NativeTabDataRealtimePolicy.shouldPreserveLocalField(draft: draft, field: field)
            ? (draft?.value(for: field) ?? remote)
            : remote
    }

    func updateDraft(record: NativeTabDataRecord, field: NativeTabDataField, value: NativeTabDataValue) {
        guard requireCurrentSession() else { return }
        guard canEdit, field.fieldType.isEditable else { return }
        var draft = draft(for: record)
        draft.set(value, for: field)
        saveError = nil
        if draft.canSubmit {
            drafts[record.id] = draft
            try? draftStore.save(draft, userId: userId)
            saveState = .dirty
        } else {
            drafts.removeValue(forKey: record.id)
            draftStore.remove(
                recordId: record.id,
                tableId: tableId,
                userId: userId,
                organizationId: organizationId
            )
            if !hasDirtyDrafts, saveState == .dirty {
                saveState = .saved
            }
        }
    }

    func discardDraft(for record: NativeTabDataRecord) {
        guard requireCurrentSession() else { return }
        drafts.removeValue(forKey: record.id)
        draftStore.remove(
            recordId: record.id,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        )
        if !hasDirtyDrafts, saveState == .dirty { saveState = .idle }
    }

    /// Web 完整模式是另一处可写表面。只有用户明确确认后，才一次性清掉当前表的全部移动端草稿。
    @discardableResult
    func discardAllDrafts() -> Bool {
        guard requireCurrentSession() else { return false }
        drafts.removeAll()
        draftStore.removeAll(tableId: tableId, userId: userId, organizationId: organizationId)
        saveError = nil
        saveNotice = nil
        saveState = table == nil ? .idle : .saved
        return true
    }

    func finishCreation(for record: NativeTabDataRecord) {
        guard requireCurrentSession() else { return }
        // 新建记录的本地 id 稳定，关闭详情后仍保留草稿，下一次“新增”可恢复。
        guard let draft = drafts[record.id] else { return }
        try? draftStore.save(draft, userId: userId)
    }

    /// FAB 新建：按当前视图筛选预填。已有未提交新建草稿则恢复，不覆盖。
    @discardableResult
    func beginCreation(groupValues: [String: Any]? = nil) -> NativeTabDataRecord {
        if let existing = resumableCreationRecord() { return existing }
        let recordId = "draft-\(UUID().uuidString)"
        let empty = NativeTabDataRecord(id: recordId, tableId: tableId, fields: [:], version: 0)
        var draft = NativeTabDataRecordDraft(
            record: empty,
            tableId: tableId,
            organizationId: organizationId,
            fields: fields
        )
        if let prefill = NativeTabDataPrefillPolicy.resolve(
            currentView: selectedView,
            fields: fields,
            groupValues: groupValues
        ) {
            draft.seedPrefill(prefill, fields: fields)
        }
        drafts[recordId] = draft
        try? draftStore.save(draft, userId: userId)
        if draft.canSubmit { saveState = .dirty }
        return NativeTabDataRecord(
            id: recordId,
            tableId: tableId,
            fields: draft.creationRecordFields(fields: fields),
            version: 0
        )
    }

    /// 看板分组下新建：筛选预填之外再带上这一列的分组值。
    @discardableResult
    func beginCreation(from group: NativeTabDataRecordGroup) -> NativeTabDataRecord {
        beginCreation(
            groupValues: NativeTabDataPrefillPolicy.groupValues(
                from: selectedView,
                fields: fields,
                group: group
            )
        )
    }

    func resumableCreationRecord() -> NativeTabDataRecord? {
        guard let draft = drafts.values.first(where: { $0.isCreation && $0.canSubmit }) else { return nil }
        return NativeTabDataRecord(
            id: draft.recordId,
            tableId: tableId,
            fields: draft.creationRecordFields(fields: fields),
            version: 0
        )
    }

    func localDraftSnapshot(for record: NativeTabDataRecord) -> NativeTabDataLocalDraftSnapshot? {
        drafts[record.id]?.readOnlySnapshot(fields: fields, directory: memberDirectory)
    }

    func retryFailedSave() async {
        guard saveState == .failed else { return }
        if let existing = openRecordId.flatMap(record(id:))
            ?? drafts.values.first(where: \.canSubmit).flatMap({ record(id: $0.recordId) })
        {
            if draft(for: existing).isCreation {
                _ = await create(record: existing)
            } else {
                _ = await save(record: existing)
            }
            return
        }
        guard let creation = resumableCreationRecord() else { return }
        _ = await create(record: creation)
    }

    @discardableResult
    func save(record: NativeTabDataRecord) async -> Bool {
        guard requireCurrentSession() else { return false }
        guard canEdit else { return false }
        let draft = draft(for: record)
        guard !draft.dirtyFieldIds.isEmpty else { return true }
        guard !draft.hasInvalidValues else {
            saveState = .failed
            saveError = L10n.TabData.invalidNumber
            return false
        }
        drafts[record.id] = draft
        try? draftStore.save(draft, userId: userId)
        guard let token = beginMutation(recordIds: [record.id]) else { return false }
        saveState = .saving
        saveError = nil
        saveNotice = nil
        do {
            let result = try await updateRequest(record.id, draft)
            let updated = result.record
            guard operationGate.accepts(token) else { return false }
            guard requireCurrentSession() else { return false }
            guard updated.id == record.id, updated.tableId == tableId else {
                rejectUntrustedMutationResponse(token)
                return false
            }
            replaceRecord(updated)
            publishAdvisoryNotice(result.conflicts)
            let latest = drafts[record.id] ?? draft
            if let rebased = latest.rebased(after: draft, onto: updated, fields: fields) {
                drafts[record.id] = rebased
                try? draftStore.save(rebased, userId: userId)
                finishMutation(token)
                saveState = .dirty
                return false
            }
            removeDraft(recordId: record.id)
            finishMutation(token)
            saveState = hasDirtyDrafts ? .dirty : .saved
            return true
        } catch {
            guard operationGate.accepts(token) else { return false }
            guard requireCurrentSession() else { return false }
            let failure = NativeTabDataSaveFailurePolicy.resolve(error)
            switch failure {
            case .conflict:
                // bulk-update 不带 expected_version，服务端不应再因版本推进拒绝写入。
                // 万一走到这里，保留草稿并让用户直接重试，别把记录锁成只读——
                // 锁住只会让他无法自救，正是  要消灭的行为。
                finishMutation(token)
                saveState = hasDirtyDrafts ? .dirty : .saved
                saveError = L10n.TabData.saveConflictRetry
            case .permissionDenied, .resourceGone:
                saveState = .permissionDenied
                saveError = L10n.TabData.permissionMessage
                await revalidateAfterWriteDenial(mutationToken: token)
            case .retryable, .terminal:
                finishMutation(token)
                saveState = .failed
                saveError = error.localizedDescription
            }
            logger.error("Save failed record=\(record.id, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    @discardableResult
    func create(record: NativeTabDataRecord) async -> NativeTabDataRecord? {
        guard requireCurrentSession() else { return nil }
        guard canEdit else { return nil }
        let draft = draft(for: record)
        guard draft.canSubmit else { return nil }
        guard !draft.hasInvalidValues else {
            saveState = .failed
            saveError = L10n.TabData.invalidNumber
            return nil
        }
        drafts[record.id] = draft
        try? draftStore.save(draft, userId: userId)
        guard let token = beginMutation(recordIds: [record.id]) else { return nil }
        saveState = .saving
        saveError = nil
        do {
            let created = try await createRequest(draft)
            guard operationGate.accepts(token) else { return nil }
            guard requireCurrentSession() else { return nil }
            guard created.tableId == tableId else {
                rejectUntrustedMutationResponse(token)
                return nil
            }
            let latest = drafts[record.id] ?? draft
            if latest != draft {
                // 服务器已创建记录，但用户在请求期间又编辑；把差异迁移到真实记录继续保存。
                removeDraft(recordId: record.id)
                if let rebased = latest.rebased(
                    after: draft,
                    onto: created,
                    fields: fields,
                    recordId: created.id
                ) {
                    drafts[created.id] = rebased
                    try? draftStore.save(rebased, userId: userId)
                }
            } else {
                removeDraft(recordId: record.id)
            }
            let shouldRefreshKanban = isKanban
            finishMutation(token)
            saveState = hasDirtyDrafts ? .dirty : .saved
            if shouldRefreshKanban {
                await refresh()
            } else {
                records.insert(created, at: 0)
                total += 1
            }
            guard requireCurrentSession() else { return nil }
            return created
        } catch {
            guard operationGate.accepts(token) else { return nil }
            guard requireCurrentSession() else { return nil }
            switch NativeTabDataSaveFailurePolicy.resolve(error) {
            case .permissionDenied, .resourceGone:
                saveState = .permissionDenied
                saveError = L10n.TabData.permissionMessage
                await revalidateAfterWriteDenial(mutationToken: token)
            case .conflict:
                // 新建不带版本，409 只可能来自服务端别的判定；保留草稿让用户重试，
                // 不要因为一次创建失败就把整张表锁成只读。
                finishMutation(token)
                saveState = hasDirtyDrafts ? .dirty : .saved
                saveError = L10n.TabData.saveConflictRetry
            case .retryable, .terminal:
                finishMutation(token)
                saveState = .failed
                saveError = error.localizedDescription
            }
            return nil
        }
    }

    @discardableResult
    func delete(record: NativeTabDataRecord) async -> Bool {
        guard requireCurrentSession() else { return false }
        guard canEdit else { return false }
        let request = NativeTabDataDeleteRequest(
            recordId: record.id,
            expectedVersion: draft(for: record).baseVersion
        )
        guard let token = beginMutation(recordIds: [record.id]) else { return false }
        saveState = .saving
        saveError = nil
        do {
            try await deleteRequest(request)
            guard operationGate.accepts(token) else { return false }
            guard requireCurrentSession() else { return false }
            records.removeAll { $0.id == record.id }
            for index in groups.indices { groups[index].records.removeAll { $0.id == record.id } }
            total = max(0, total - 1)
            removeDraft(recordId: record.id)
            finishMutation(token)
            saveState = hasDirtyDrafts ? .dirty : .saved
            return true
        } catch {
            guard operationGate.accepts(token) else { return false }
            guard requireCurrentSession() else { return false }
            switch NativeTabDataSaveFailurePolicy.resolve(error) {
            case .permissionDenied, .resourceGone:
                saveState = .permissionDenied
                saveError = L10n.TabData.permissionMessage
                await revalidateAfterWriteDenial(mutationToken: token)
            case .conflict:
                finishMutation(token)
                saveState = hasDirtyDrafts ? .dirty : .saved
                saveError = L10n.TabData.deleteModifiedMessage
            case .retryable, .terminal:
                finishMutation(token)
                saveState = .failed
                saveError = error.localizedDescription
            }
            return false
        }
    }

    private func reloadQuery() async {
        guard requireCurrentSession() else { return }
        guard let token = beginReplacingQuery() else { return }
        isLoading = true
        loadError = nil
        await loadRecords(token: token, page: 1, appending: false)
        if operationGate.accepts(token) { isLoading = false }
    }

    private func loadRecords(
        token: NativeTabDataOperationGate.Token,
        page: Int = 1,
        appending: Bool
    ) async {
        guard requireCurrentSession() else { return }
        do {
            let response = try await fetchRecords(page: page, groupOffsets: [:])
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            currentPage = page
            applyRecords(response, appending: appending)
        } catch {
            guard operationGate.accepts(token) else { return }
            guard requireCurrentSession() else { return }
            if error is NativeTabDataReadIdentityError {
                rejectMismatchedReadResponse()
                return
            }
            clearProtectedDataIfNeeded(error)
            loadError = error.localizedDescription
        }
    }

    private func fetchRecords(page: Int, groupOffsets: [String: Int]) async throws -> NativeTabDataRecordList {
        guard requireCurrentSession() else { throw CancellationError() }
        let effectiveView = selectedView
        var query: [String: String] = [
            "page": String(page),
            "page_size": String(Self.pageSize),
            "fieldKeyType": "id",
        ]
        if !searchText.isEmpty {
            query["search"] = searchText
            query["search_hide_not_match_rows"] = "true"
        }
        let mobileFilters = NativeTabDataFilterQueryPolicy.queryItems(
            rules: filterRules,
            logic: filterLogic
        )
        if !mobileFilters.isEmpty {
            for (key, value) in mobileFilters {
                query[key] = value
            }
        } else if effectiveView?.filterSet == nil {
            let legacyFilters = effectiveView?.filters.map { $0.mapValues(\.value) } ?? []
            if !legacyFilters.isEmpty {
                query["filters"] = NativeTabDataQueryCodec.json(legacyFilters)
                query["filter_logic"] = effectiveView?.configuredFilterLogic ?? "and"
            }
        }
        let effectiveSorts: [Any]
        if let sortRule { effectiveSorts = [sortRule.jsonObject] }
        else { effectiveSorts = effectiveView?.sorts.map { $0.mapValues(\.value) } ?? [] }
        if !effectiveSorts.isEmpty { query["sorts"] = NativeTabDataQueryCodec.json(effectiveSorts) }
        let effectiveGroups = effectiveView?.groups.map { $0.mapValues(\.value) } ?? []
        if !effectiveGroups.isEmpty { query["groups"] = NativeTabDataQueryCodec.json(effectiveGroups) }
        if effectiveView?.isKanban == true {
            query["per_group_limit"] = String(Self.groupPageSize)
            if !groupOffsets.isEmpty { query["group_offsets"] = NativeTabDataQueryCodec.json(groupOffsets) }
        }
        let response: NativeTabDataRecordList
        do {
            response = try await recordsRequest(tableId, effectiveView?.id, query)
        } catch {
            // 只记录解码错误的类型和视图标识，不记录响应 body 或业务字段值。
            DiagnosticRecorder.captureApp(
                name: "tabdata_records_decode_failure",
                errorClass: "view=\(effectiveView?.id ?? "none");error=\(Self.decodeFailureToken(error))"
            )
            throw error
        }
        guard requireCurrentSession() else { throw CancellationError() }
        guard responseBelongsToCurrentTable(response) else {
            throw NativeTabDataReadIdentityError.mismatchedRecordTable
        }
        return response
    }

    private static func decodeFailureToken(_ error: Error) -> String {
        let underlying: Error
        if case let APIError.decodingError(inner) = error {
            underlying = inner
        } else {
            underlying = error
        }
        guard case let DecodingError.keyNotFound(key, context) = underlying else {
            return String(describing: underlying)
        }
        let path = (context.codingPath + [key]).map(\.stringValue).joined(separator: ".")
        return "keyNotFound.path=\(path)"
    }

    private func applyRecords(_ response: NativeTabDataRecordList, appending: Bool) {
        total = response.matchedTotal ?? response.total ?? 0
        if selectedView?.isKanban == true {
            groups = response.metadata?.groups ?? []
            records = []
        } else if appending {
            let known = Set(records.map(\.id))
            records.append(contentsOf: response.records.filter { !known.contains($0.id) })
        } else {
            records = response.records
            groups = []
        }
    }

    private func reconcileDraftsAfterMetadataRefresh(previousFields: [NativeTabDataField]) {
        var droppedNames: [String] = []
        for (recordId, draft) in drafts {
            let rebased = NativeTabDataDroppedFieldPolicy.rebase(
                draft: draft,
                previousFields: previousFields,
                nextFields: fields
            )
            guard !rebased.droppedFieldIds.isEmpty else { continue }
            drafts[recordId] = rebased.draft
            try? draftStore.save(rebased.draft, userId: userId)
            droppedNames.append(contentsOf: rebased.droppedFieldNames)
        }
        let announceSchemaUpdate = pendingSchemaNotice
        pendingSchemaNotice = false
        if let notice = NativeTabDataDroppedFieldPolicy.schemaRefreshNotice(
            droppedFieldNames: droppedNames,
            announceSchemaUpdate: announceSchemaUpdate
        ) {
            saveNotice = notice
        }
        guard saveState != .saving else { return }
        if hasDirtyDrafts {
            saveState = .dirty
        } else {
            switch saveState {
            case .saved, .conflict, .permissionDenied, .saving:
                break
            case .idle, .dirty, .failed:
                saveState = .idle
            }
        }
        if saveState != .conflict { saveError = nil }
    }

    private var viewConfiguredFilterLogic: NativeTabDataFilterLogic {
        selectedView?.configuredFilterLogic == NativeTabDataFilterLogic.or.rawValue ? .or : .and
    }

    private func discardInvalidLocalQueryRules() {
        let fieldIds = Set(fields.map(\.id))
        filterRules.removeAll { !fieldIds.contains($0.fieldId) }
        if filterRules.isEmpty {
            filterLogic = viewConfiguredFilterLogic
        }
        if let sortRule, !fieldIds.contains(sortRule.fieldId) { self.sortRule = nil }
    }

    private func finishMutation(_ token: NativeTabDataOperationGate.Token) {
        pendingMutationRecordIds.removeAll()
        operationGate.finishMutation(token)
    }

    private func rejectUntrustedMutationResponse(_ token: NativeTabDataOperationGate.Token) {
        finishMutation(token)
        saveState = .conflict
        saveError = L10n.TabData.conflictMessage
    }

    private func rejectMismatchedReadResponse() {
        saveState = .conflict
        saveError = L10n.TabData.conflictMessage
        loadError = L10n.TabData.conflictMessage
    }

    private func responseBelongsToCurrentTable(_ response: NativeTabDataRecordList) -> Bool {
        let allRecords = response.records + (response.metadata?.groups.flatMap(\.records) ?? [])
        return allRecords.allSatisfy { $0.tableId == tableId }
    }

    private func beginReplacingQuery() -> NativeTabDataOperationGate.Token? {
        guard let token = operationGate.beginReplacingQuery() else { return nil }
        isLoadingMore = false
        return token
    }

    private func beginMutation(recordIds: Set<String> = []) -> NativeTabDataOperationGate.Token? {
        guard let token = operationGate.beginMutation() else { return nil }
        pendingMutationRecordIds = recordIds
        isLoading = false
        isLoadingMore = false
        return token
    }

    private func storedDraft(for recordId: String) -> NativeTabDataRecordDraft? {
        if let inMemory = drafts[recordId] { return inMemory }
        return draftStore.load(
            recordId: recordId,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        )
    }

    private func realtimeContext() -> NativeTabDataRealtimePolicy.Context {
        let visible = allVisibleRecords
        return NativeTabDataRealtimePolicy.Context(
            tableId: tableId,
            currentUserId: userId,
            isSaving: saveState == .saving,
            pendingRecordIds: pendingMutationRecordIds,
            draftsByRecordId: drafts,
            localRecords: Dictionary(visible.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }),
            fields: fields,
            isKanban: isKanban,
            openRecordId: openRecordId
        )
    }

    private func scheduleRealtimeRefresh() {
        realtimeRefreshTask?.cancel()
        realtimeRefreshTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.refresh()
        }
    }

    private func applyRealtimePlan(_ plan: NativeTabDataRealtimePolicy.ApplyPlan) {
        for updated in plan.upserts {
            upsertRealtimeRecord(updated)
        }
        if !plan.deletions.isEmpty {
            let deleted = Set(plan.deletions)
            let removed = records.filter { deleted.contains($0.id) }.count
                + groups.reduce(0) { $0 + $1.records.filter { deleted.contains($0.id) }.count }
            records.removeAll { deleted.contains($0.id) }
            for index in groups.indices {
                groups[index].records.removeAll { deleted.contains($0.id) }
            }
            total = max(0, total - removed)
        }
        if !plan.notifiedDeletions.isEmpty {
            saveNotice = L10n.TabData.remoteRecordDeleted
        }
    }

    private func upsertRealtimeRecord(_ updated: NativeTabDataRecord) {
        if records.contains(where: { $0.id == updated.id }) || groups.contains(where: { group in
            group.records.contains(where: { $0.id == updated.id })
        }) {
            replaceRecord(updated)
            return
        }
        if isKanban {
            scheduleRealtimeRefresh()
            return
        }
        records.insert(updated, at: 0)
        total += 1
    }

    private func replaceRecord(_ updated: NativeTabDataRecord) {
        if let index = records.firstIndex(where: { $0.id == updated.id }) { records[index] = updated }
        for groupIndex in groups.indices {
            if let recordIndex = groups[groupIndex].records.firstIndex(where: { $0.id == updated.id }) {
                groups[groupIndex].records[recordIndex] = updated
            }
        }
    }

    private func publishAdvisoryNotice(_ conflicts: [NativeTabDataBulkUpdateConflict]) {
        guard !conflicts.isEmpty else { return }
        saveNotice = NativeTabDataAdvisoryConflictPolicy.message(conflicts: conflicts, fields: fields)
    }

    private func removeDraft(recordId: String) {
        drafts.removeValue(forKey: recordId)
        draftStore.remove(
            recordId: recordId,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        )
    }

    private func revalidateAfterWriteDenial(mutationToken: NativeTabDataOperationGate.Token) async {
        finishMutation(mutationToken)
        guard requireCurrentSession() else { return }
        guard let token = beginReplacingQuery() else { return }
        await loadMetadataAndRecords(
            token: token,
            clearsContentBeforeRequest: false,
            followsWriteDenial: true
        )
    }

    private func retainDraftsAfterWriteDenial() {
        saveState = hasDirtyDrafts ? .conflict : .permissionDenied
        saveError = hasDirtyDrafts ? L10n.TabData.conflictMessage : L10n.TabData.permissionMessage
    }

    /// 403/404 代表用户已不再拥有这张表或资源不存在；不能继续展示上次成功请求的陈旧数据。
    private func clearProtectedDataIfNeeded(_ error: Error) {
        guard NativeTabDataSaveFailurePolicy.mustPurgeProtectedDataAfterReadFailure(error) else { return }
        clearProtectedData()
    }

    private func clearProtectedData() {
        stopRealtime()
        pendingMutationRecordIds.removeAll()
        operationGate.invalidate()
        drafts.removeAll()
        draftStore.removeAll(tableId: tableId, userId: userId, organizationId: organizationId)
        table = nil
        fields = []
        views = []
        records = []
        groups = []
        selectedViewId = nil
        searchText = ""
        filterRules = []
        filterLogic = .and
        sortRule = nil
        currentPage = 1
        total = 0
        isLoading = false
        isLoadingMore = false
        loadError = nil
        saveError = nil
        isCreatingField = false
        fieldCreationError = nil
        memberDirectory = .empty
        saveNotice = nil
        pendingSchemaNotice = false
        saveState = .permissionDenied
    }

    private func fieldCreationMessage(
        for error: NativeTabDataCreateFieldValidationError
    ) -> String {
        switch error {
        case .emptyName: L10n.TabData.fieldNameRequired
        case .nameTooLong: L10n.TabData.fieldNameTooLong
        case .duplicateName: L10n.TabData.fieldNameDuplicate
        case .missingChoices: L10n.TabData.fieldChoicesRequired
        }
    }

    @discardableResult
    private func requireCurrentSession() -> Bool {
        guard sessionIsCurrent() else {
            clearProtectedData()
            loadError = L10n.TabData.permissionMessage
            return false
        }
        return true
    }
}
