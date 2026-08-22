import Foundation
import os

/// TabTracker 自动化数据源：以 Organization 为边界加载列表，可选按 Workspace
/// 收窄；详情与运行历史始终使用各自权威接口。
@MainActor @Observable
final class TabTrackerStore {
    let organizationId: String

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "TabTrackerStore")

    private(set) var trackers: [Tracker] = []
    private(set) var trackerDetailsById: [String: Tracker] = [:]
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var loadError: String?
    private(set) var detailErrorByTrackerId: [String: String] = [:]
    private(set) var hasMoreTrackers = false
    private(set) var totalTrackers = 0
    private(set) var selectedWorkspaceId: String?

    private(set) var runsByTrackerId: [String: [TrackerRun]] = [:]
    private(set) var loadingRunsTrackerIds: Set<String> = []

    /// 正在执行生命周期操作的 tracker id（禁用重复点击）。
    private(set) var actionInProgressTrackerId: String?

    private var loadSeq = 0
    private var detailSeqByTrackerId: [String: Int] = [:]
    private var runsSeqByTrackerId: [String: Int] = [:]
    private var currentPage = 0
    private let pageSize = 100

    /// 实时订阅（tracker.events.{spaceId}）：随自动化工作面生命周期 start/stop。
    private let listenerKey: String
    private var isListening = false
    private var subscribedTopics: Set<String> = []

    init(organizationId: String) {
        self.organizationId = organizationId
        self.listenerKey = "tabtracker-\(organizationId)-\(UUID().uuidString)"
    }

    func trackerById(_ id: String) -> Tracker? {
        trackerDetailsById[id] ?? trackers.first { $0.id == id }
    }

    func runs(for trackerId: String) -> [TrackerRun] {
        runsByTrackerId[trackerId] ?? []
    }

    func isLoadingRuns(for trackerId: String) -> Bool {
        loadingRunsTrackerIds.contains(trackerId)
    }

    // MARK: - Load

    func loadTrackers(workspaceId: String? = nil) async {
        loadSeq += 1
        let seq = loadSeq
        isLoading = true
        loadError = nil
        selectedWorkspaceId = workspaceId
        currentPage = 0

        do {
            let response = try await fetchTrackerPage(page: 1, workspaceId: workspaceId)
            guard seq == loadSeq else { return }
            trackers = response.events
            currentPage = response.page
            totalTrackers = response.total
            hasMoreTrackers = response.hasMore
        } catch {
            guard seq == loadSeq else { return }
            guard !error.isCancellation else {
                isLoading = false
                return
            }
            loadError = error.localizedDescription
            logger.error("loadTrackers failed: \(error.localizedDescription)")
        }
        isLoading = false
    }

    func loadMoreTrackers() async {
        guard hasMoreTrackers, !isLoading, !isLoadingMore else { return }
        let seq = loadSeq
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let response = try await fetchTrackerPage(
                page: currentPage + 1,
                workspaceId: selectedWorkspaceId
            )
            guard seq == loadSeq else { return }
            let existingIds = Set(trackers.map(\.id))
            trackers.append(contentsOf: response.events.filter { !existingIds.contains($0.id) })
            currentPage = response.page
            totalTrackers = response.total
            hasMoreTrackers = response.hasMore
        } catch {
            guard seq == loadSeq, !error.isCancellation else { return }
            logger.error("loadMoreTrackers failed: \(error.localizedDescription)")
        }
    }

    /// 后端暂未提供 keyword / status 参数；用户开始筛选时补齐剩余分页，
    /// 避免只搜索首屏造成“没有结果”的假事实。
    func loadAllRemainingTrackers() async {
        while hasMoreTrackers {
            let pageBeforeLoad = currentPage
            await loadMoreTrackers()
            guard currentPage > pageBeforeLoad else { return }
        }
    }

    func loadTrackerDetail(_ trackerId: String) async {
        let seq = (detailSeqByTrackerId[trackerId] ?? 0) + 1
        detailSeqByTrackerId[trackerId] = seq
        detailErrorByTrackerId[trackerId] = nil

        do {
            let tracker: Tracker = try await APIClient.shared.get(
                path: Endpoints.TabTracker.event(trackerId)
            )
            guard detailSeqByTrackerId[trackerId] == seq else { return }
            trackerDetailsById[trackerId] = tracker
            upsertTracker(tracker)
        } catch {
            guard detailSeqByTrackerId[trackerId] == seq, !error.isCancellation else { return }
            detailErrorByTrackerId[trackerId] = error.localizedDescription
            logger.error("loadTrackerDetail(\(trackerId)) failed: \(error.localizedDescription)")
        }
    }

    private func fetchTrackerPage(page: Int, workspaceId: String?) async throws -> TrackerListResponse {
        var query = [
            "organization_id": organizationId,
            "page": String(page),
            "page_size": String(pageSize),
        ]
        if let workspaceId, !workspaceId.isEmpty {
            query["space_id"] = workspaceId
        }
        return try await APIClient.shared.get(
            path: Endpoints.TabTracker.events,
            query: query
        )
    }

    /// 预置场景模板。只读且与组织无关，故不进 store 状态，由调用方自行持有。
    func loadTemplates() async throws -> [TrackerTemplate] {
        let response: TrackerTemplateListResponse = try await APIClient.shared.get(
            path: Endpoints.TabTracker.templates
        )
        return response.templates
    }

    // MARK: - Create

    /// 创建 Tracker。创建后仍是 `draft`，需由调用方接着 ``activateTracker(_:)`` 才会真正排程。
    ///
    /// 两个后端口径容易踩：
    /// - `organization_id` / `space_id` 走 query，不在 body 里；`space_id` 就是执行 Workspace。
    /// - `instructions` 后端没有独立字段，落在 `skill_params.instructions`（与 Electron 一致）。
    func createTracker(
        name: String,
        description: String,
        triggerType: TrackerTriggerType,
        triggerConfig: sending [String: Any],
        agentId: String,
        workspaceId: String,
        instructions: String,
        intentSnapshot: sending [String: Any]? = nil
    ) async throws -> Tracker {
        let trimmedInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "description": description,
            "trigger_type": triggerType.rawValue,
            "trigger_config": triggerConfig,
            "agent_id": agentId,
            "workspace_id": workspaceId,
        ]
        if !trimmedInstructions.isEmpty {
            body["skill_params"] = ["instructions": trimmedInstructions]
        }
        if let intentSnapshot, !intentSnapshot.isEmpty {
            body["intent_snapshot"] = intentSnapshot
        }

        let created: Tracker = try await APIClient.shared.post(
            path: Endpoints.TabTracker.events,
            body: body,
            query: [
                "organization_id": organizationId,
                "space_id": workspaceId,
            ]
        )
        upsertTracker(created)
        trackerDetailsById[created.id] = created
        return created
    }

    func conversationTarget(for run: TrackerRun) async throws -> ConversationTarget {
        guard let sessionId = run.chatSessionId, !sessionId.isEmpty else {
            throw APIError.apiError("这次运行没有关联会话")
        }
        let session: ChatSession = try await APIClient.shared.get(
            path: Endpoints.Chat.session(sessionId)
        )
        guard let target = TrackerRunConversationTargetResolver.resolve(
            session: session,
            fallbackOrganizationId: organizationId
        ) else {
            throw APIError.apiError("关联会话缺少执行 Workspace，暂时无法打开")
        }
        return target
    }

    // MARK: - 排期预览

    private(set) var schedulePreview: [TrackerScheduleOccurrence] = []
    private(set) var schedulePreviewTruncated = false
    private(set) var isLoadingSchedulePreview = false
    private var schedulePreviewSeq = 0

    /// 拉未来一个短窗口的执行点。失败只清空标记、不打断列表——
    /// 排期是锦上添花的信息，不该让它的失败盖掉已经加载好的自动化列表。
    func loadSchedulePreview(workspaceId: String?, now: Date = Date()) async {
        schedulePreviewSeq += 1
        let seq = schedulePreviewSeq
        isLoadingSchedulePreview = true
        defer { if schedulePreviewSeq == seq { isLoadingSchedulePreview = false } }

        let window = TrackerSchedulePreviewPolicy.window(now: now)
        var params = [
            "organization_id": organizationId,
            "from": TrackerSchedulePreviewPolicy.iso(window.from),
            "to": TrackerSchedulePreviewPolicy.iso(window.to),
        ]
        if let workspaceId, !workspaceId.isEmpty { params["space_id"] = workspaceId }

        do {
            let response: TrackerSchedulePreviewResponse = try await APIClient.shared.get(
                path: Endpoints.TabTracker.schedulePreview,
                query: params
            )
            guard schedulePreviewSeq == seq else { return }
            schedulePreview = response.occurrences
            schedulePreviewTruncated = response.truncated
        } catch {
            guard schedulePreviewSeq == seq else { return }
            guard !error.isCancellation else { return }
            schedulePreview = []
            schedulePreviewTruncated = false
            logger.error("loadSchedulePreview failed: \(error.localizedDescription)")
        }
    }

    func loadRuns(trackerId: String) async {
        let seq = (runsSeqByTrackerId[trackerId] ?? 0) + 1
        runsSeqByTrackerId[trackerId] = seq
        loadingRunsTrackerIds.insert(trackerId)
        defer { loadingRunsTrackerIds.remove(trackerId) }

        do {
            let response: TrackerRunListResponse = try await APIClient.shared.get(
                path: Endpoints.TabTracker.runs(trackerId)
            )
            guard runsSeqByTrackerId[trackerId] == seq else { return }
            runsByTrackerId[trackerId] = response.runs
        } catch {
            guard runsSeqByTrackerId[trackerId] == seq else { return }
            guard !error.isCancellation else { return }
            logger.error("loadRuns(\(trackerId)) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Lifecycle actions

    /// 手动触发一次运行，返回新建的 run 并插入本地历史头部。
    func triggerTracker(_ trackerId: String) async throws -> TrackerRun {
        guard TrackerRunExecutionPolicy.canTrigger(
            latestRun: runsByTrackerId[trackerId]?.first
        ) else {
            throw TrackerRunExecutionError.activeRunInProgress
        }
        actionInProgressTrackerId = trackerId
        defer { actionInProgressTrackerId = nil }

        let run: TrackerRun = try await APIClient.shared.post(
            path: Endpoints.TabTracker.trigger(trackerId)
        )
        var runs = runsByTrackerId[trackerId] ?? []
        if !runs.contains(where: { $0.id == run.id }) {
            runs.insert(run, at: 0)
            runsByTrackerId[trackerId] = runs
        }
        return run
    }

    func activateTracker(_ trackerId: String) async throws {
        try await performLifecycle(trackerId, path: Endpoints.TabTracker.activate(trackerId))
    }

    func pauseTracker(_ trackerId: String) async throws {
        try await performLifecycle(trackerId, path: Endpoints.TabTracker.pause(trackerId))
    }

    func resumeTracker(_ trackerId: String) async throws {
        try await performLifecycle(trackerId, path: Endpoints.TabTracker.resume(trackerId))
    }

    func deleteTracker(_ trackerId: String) async throws {
        actionInProgressTrackerId = trackerId
        defer { actionInProgressTrackerId = nil }

        let _: TrackerEmptyResponse = try await APIClient.shared.delete(
            path: Endpoints.TabTracker.event(trackerId)
        )
        trackers.removeAll { $0.id == trackerId }
        trackerDetailsById.removeValue(forKey: trackerId)
        runsByTrackerId.removeValue(forKey: trackerId)
    }

    func cancelRun(trackerId: String, runId: String) async throws {
        actionInProgressTrackerId = trackerId
        defer { actionInProgressTrackerId = nil }

        let run: TrackerRun = try await APIClient.shared.post(
            path: Endpoints.TabTracker.cancelRun(trackerId: trackerId, runId: runId)
        )
        upsertRun(run, trackerId: trackerId)
    }

    // MARK: - Realtime（tracker.events WS）

    /// 进入自动化工作面时订阅当前组织内可见 Workspace 的 Tracker topic。
    func startRealtime(workspaceIds: [String]) {
        guard !isListening else { return }
        isListening = true
        RealtimeGateway.shared.addEnvelopeListener(key: listenerKey) { [weak self] env in
            self?.handleEnvelope(env)
        }
        subscribedTopics = Set(workspaceIds.filter { !$0.isEmpty }.map { "tracker.events.\($0)" })
        RealtimeGateway.shared.subscribe(Array(subscribedTopics))
    }

    /// 退出工作面时摘监听；topic 延迟退订，给收尾事件留一点窗口。
    func stopRealtime() {
        guard isListening else { return }
        isListening = false
        RealtimeGateway.shared.removeEnvelopeListener(key: listenerKey)
        RealtimeGateway.shared.unsubscribeAfterDelay(Array(subscribedTopics), delay: .seconds(5))
        subscribedTopics.removeAll()
    }

    private func handleEnvelope(_ env: WSEnvelope) {
        guard env.type.hasPrefix("tracker.") else { return }
        // 只认已订阅 Workspace 的事件；无 space_id 的旧事件仍由服务端 topic 隔离。
        if let sid = env.payloadString("space_id"), !sid.isEmpty,
           !subscribedTopics.contains("tracker.events.\(sid)") { return }

        switch env.type {
        case "tracker.progress", "tracker.run.started":
            applyRunProgress(env)
        case "tracker.run.completed", "tracker.run.failed", "tracker.run.cancelled":
            applyRunTerminal(env)
        default:
            // tracker.event.{created|updated|deleted|activated|paused|resumed} 生命周期 → 刷新列表。
            // 其它（health_alert / trigger.filtered / notification）暂不落 UI。
            if env.type.hasPrefix("tracker.event.") {
                Task { await loadTrackers(workspaceId: selectedWorkspaceId) }
            }
        }
    }

    private func applyRunProgress(_ env: WSEnvelope) {
        guard let trackerId = env.payloadString("tracker_id"),
              let runId = env.payloadString("run_id") else { return }
        if patchRun(trackerId: trackerId, runId: runId, env: env) { return }
        // 本地还没有这条 run（如刚 started）：若详情已加载该 tracker 的 runs，则补拉。
        if runsByTrackerId[trackerId] != nil {
            Task { await loadRuns(trackerId: trackerId) }
        }
    }

    private func applyRunTerminal(_ env: WSEnvelope) {
        guard let trackerId = env.payloadString("tracker_id"),
              let runId = env.payloadString("run_id") else { return }
        _ = patchRun(trackerId: trackerId, runId: runId, env: env)
        // 终态：刷新列表统计（total/success/fail、last/next run）与该 tracker 的 run 详情。
        Task { await loadTrackers(workspaceId: selectedWorkspaceId) }
        if runsByTrackerId[trackerId] != nil {
            Task { await loadRuns(trackerId: trackerId) }
        }
    }

    /// 就地打补丁在内存 run 上（WS payload 是增量字段，非完整 TrackerRun）。命中返回 true。
    @discardableResult
    private func patchRun(trackerId: String, runId: String, env: WSEnvelope) -> Bool {
        guard var runs = runsByTrackerId[trackerId],
              let idx = runs.firstIndex(where: { $0.id == runId }) else { return false }
        var run = runs[idx]
        if let raw = env.payloadString("status"), let status = TrackerRunStatus(rawValue: raw) {
            run.status = status
        }
        if let progress = env.payloadInt("progress") { run.progress = progress }
        if let msg = env.payloadString("progress_message") { run.progressMessage = msg }
        if let tokens = env.payloadInt("tokens_used") { run.tokensUsed = tokens }
        if let cycle = env.payloadInt("current_cycle") { run.currentCycle = cycle }
        if let maxCycles = env.payloadInt("max_cycles") { run.maxCycles = maxCycles }
        runs[idx] = run
        runsByTrackerId[trackerId] = runs
        return true
    }

    // MARK: - Private

    /// activate / pause / resume 后端都返回最新 Tracker，直接回填本地列表。
    private func performLifecycle(_ trackerId: String, path: String) async throws {
        actionInProgressTrackerId = trackerId
        defer { actionInProgressTrackerId = nil }

        let updated: Tracker = try await APIClient.shared.post(path: path)
        trackerDetailsById[trackerId] = updated
        upsertTracker(updated)
    }

    private func upsertRun(_ run: TrackerRun, trackerId: String) {
        var runs = runsByTrackerId[trackerId] ?? []
        if let idx = runs.firstIndex(where: { $0.id == run.id }) {
            runs[idx] = run
        } else {
            runs.insert(run, at: 0)
        }
        runsByTrackerId[trackerId] = runs
    }

    private func upsertTracker(_ tracker: Tracker) {
        if let idx = trackers.firstIndex(where: { $0.id == tracker.id }) {
            trackers[idx] = tracker
        } else {
            trackers.insert(tracker, at: 0)
        }
    }
}
