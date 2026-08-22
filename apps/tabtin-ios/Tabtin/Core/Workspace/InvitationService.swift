import Foundation
import os

enum InvitationLink {
    static func url(token: String, webBaseURL: String = AppConfig.webBaseURL) -> String {
        let base = webBaseURL
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encodedToken = normalizedToken.addingPercentEncoding(withAllowedCharacters: allowed)
            ?? normalizedToken
        return "\(base)/invite/\(encodedToken)"
    }
}

@MainActor @Observable
final class InvitationService {
    static let shared = InvitationService()

    private(set) var invitations: [OrganizationInvitation] = []
    private(set) var pendingInvitations: [PendingInvitation] = []
    private(set) var isLoading = false
    private(set) var isLoadingPendingInvitations = false
    private(set) var isMutating = false
    private(set) var errorMessage: String?
    private(set) var pendingInvitationsErrorMessage: String?

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "InvitationService")
    /// “我的待处理邀请”是账号级数据：任务由 Store 持有，避免个人页 `.task` / 下拉刷新
    /// 的任一等待者消失时把共享请求一起取消。
    private var pendingInvitationsLoadTask: Task<Void, Never>?
    private var lifecycleGeneration = 0
    private var pendingInvitationsRequestSeq = 0
    /// 组织邀请仍跟随详情页生命周期，但用序号丢弃跨页面/跨组织的迟到结果。
    private var invitationsRequestSeq = 0
    private var invitationsOrganizationId: String?

    private init() {
        AuthService.shared.registerLogoutHook { [weak self] in
            self?.clearAll()
        }
    }

    func invitationInfo(token: String) async throws -> InvitationInfo {
        try await APIClient.shared.get(path: Endpoints.Context.invitationInfo(token))
    }

    func acceptInvitation(token: String) async throws -> AcceptInvitationResponse {
        let response: AcceptInvitationResponse = try await APIClient.shared.post(
            path: Endpoints.Context.invitationAccept(token)
        )
        await WorkspaceStore.shared.loadOrganizations()
        if let organization = WorkspaceStore.shared.organizations.first(where: {
            $0.id == response.organizationId
        }) {
            await WorkspaceStore.shared.selectOrganization(organization)
        }
        return response
    }

    func loadMyPendingInvitations() async {
        guard AuthService.shared.isAuthenticated else { return }

        if let task = pendingInvitationsLoadTask {
            await task.value
            return
        }

        pendingInvitationsRequestSeq += 1
        let generation = lifecycleGeneration
        let seq = pendingInvitationsRequestSeq
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performPendingInvitationsLoad(generation: generation, seq: seq)
            if self.lifecycleGeneration == generation,
               self.pendingInvitationsRequestSeq == seq {
                self.pendingInvitationsLoadTask = nil
            }
        }
        pendingInvitationsLoadTask = task
        await task.value
    }

    private func performPendingInvitationsLoad(generation: Int, seq: Int) async {
        guard isCurrentPendingInvitationsLoad(generation: generation, seq: seq) else { return }

        isLoadingPendingInvitations = true
        pendingInvitationsErrorMessage = nil
        defer {
            if isCurrentPendingInvitationsLoad(generation: generation, seq: seq) {
                isLoadingPendingInvitations = false
            }
        }
        do {
            let response: PendingInvitationListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.invitationsMyPending
            )
            guard isCurrentPendingInvitationsLoad(generation: generation, seq: seq),
                  !Task.isCancelled else { return }
            pendingInvitations = response.invitations
        } catch {
            guard isCurrentPendingInvitationsLoad(generation: generation, seq: seq) else { return }
            if error.isCancellation || Task.isCancelled { return }
            pendingInvitationsErrorMessage = error.localizedDescription
            logger.error("load pending invitations failed: \(error.localizedDescription)")
        }
    }

    private func isCurrentPendingInvitationsLoad(generation: Int, seq: Int) -> Bool {
        lifecycleGeneration == generation
            && pendingInvitationsRequestSeq == seq
            && AuthService.shared.isAuthenticated
    }

    func loadInvitations(organizationId: String) async {
        guard AuthService.shared.isAuthenticated else { return }
        if invitationsOrganizationId != organizationId {
            invitations = []
            invitationsOrganizationId = organizationId
        }
        invitationsRequestSeq += 1
        let generation = lifecycleGeneration
        let seq = invitationsRequestSeq
        isLoading = invitations.isEmpty
        errorMessage = nil
        defer {
            if isCurrentInvitationsLoad(organizationId: organizationId, generation: generation, seq: seq) {
                isLoading = false
            }
        }

        do {
            let response: InvitationListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationInvitations(organizationId)
            )
            guard isCurrentInvitationsLoad(organizationId: organizationId, generation: generation, seq: seq),
                  !Task.isCancelled else { return }
            invitations = response.invitations
        } catch {
            guard isCurrentInvitationsLoad(organizationId: organizationId, generation: generation, seq: seq) else { return }
            if error.isCancellation || Task.isCancelled { return }
            errorMessage = error.localizedDescription
            logger.error("load invitations failed: \(error.localizedDescription)")
        }
    }

    private func isCurrentInvitationsLoad(organizationId: String, generation: Int, seq: Int) -> Bool {
        lifecycleGeneration == generation
            && invitationsRequestSeq == seq
            && invitationsOrganizationId == organizationId
            && WorkspaceStore.shared.selectedOrganizationId == organizationId
            && AuthService.shared.isAuthenticated
    }

    @discardableResult
    func createEmailInvitation(organizationId: String, email: String, role: OrganizationRole, expiresHours: Int = 72) async throws -> OrganizationInvitation {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let result: OrganizationInvitation = try await APIClient.shared.post(
                path: Endpoints.Context.organizationInvitationsEmail(organizationId),
                body: [
                    "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
                    "role": role.rawValue,
                    "expires_hours": expiresHours
                ]
            )
            await loadInvitations(organizationId: organizationId)
            return result
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    /// 手机号邀请仅支持已注册用户，服务端固定授予编辑者角色。
    @discardableResult
    func createPhoneInvitation(organizationId: String, phone: String, expiresHours: Int = 72) async throws -> OrganizationInvitation {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let result: OrganizationInvitation = try await APIClient.shared.post(
                path: Endpoints.Context.organizationInvitationsPhone(organizationId),
                body: [
                    "phone": phone.trimmingCharacters(in: .whitespacesAndNewlines),
                    "role": OrganizationRole.editor.rawValue,
                    "expires_hours": expiresHours
                ]
            )
            await loadInvitations(organizationId: organizationId)
            return result
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func createLinkInvitation(organizationId: String, role: OrganizationRole, maxUses: Int = -1, expiresHours: Int = 168) async throws -> OrganizationInvitation {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let result: OrganizationInvitation = try await APIClient.shared.post(
                path: Endpoints.Context.organizationInvitationsLink(organizationId),
                body: [
                    "role": role.rawValue,
                    "max_uses": maxUses,
                    "expires_hours": expiresHours
                ]
            )
            await loadInvitations(organizationId: organizationId)
            return result
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    /// 直邀：按 User ID 直接邀请（对齐 Android WsInviteTab 的 User ID 直邀）。
    @discardableResult
    func createDirectInvitation(organizationId: String, userId: String, role: OrganizationRole, expiresHours: Int = 72) async throws -> OrganizationInvitation {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let result: OrganizationInvitation = try await APIClient.shared.post(
                path: Endpoints.Context.organizationInvitationsDirect(organizationId),
                body: [
                    "user_id": userId.trimmingCharacters(in: .whitespacesAndNewlines),
                    "role": role.rawValue,
                    "expires_hours": expiresHours
                ]
            )
            await loadInvitations(organizationId: organizationId)
            return result
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    func cancelInvitation(organizationId: String, invitationId: String) async throws {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let _: MessageResponse = try await APIClient.shared.delete(
                path: Endpoints.Context.organizationInvitation(organizationId, invitationId: invitationId)
            )
            invitationsRequestSeq += 1
            isLoading = false
            invitations.removeAll { $0.id == invitationId }
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func respondToInvitation(invitationId: String, accept: Bool) async throws -> InvitationRespondResponse {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }

        do {
            let result: InvitationRespondResponse = try await APIClient.shared.post(
                path: Endpoints.Context.invitationRespond(invitationId),
                body: ["accept": accept]
            )
            pendingInvitations.removeAll { $0.id == invitationId }
            pendingInvitationsRequestSeq += 1
            pendingInvitationsLoadTask?.cancel()
            pendingInvitationsLoadTask = nil
            isLoadingPendingInvitations = false
            pendingInvitationsErrorMessage = nil
            if accept { await WorkspaceStore.shared.loadOrganizations() }
            return result
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    func clearAll() {
        lifecycleGeneration += 1
        pendingInvitationsRequestSeq += 1
        invitationsRequestSeq += 1
        pendingInvitationsLoadTask?.cancel()
        pendingInvitationsLoadTask = nil
        invitations = []
        invitationsOrganizationId = nil
        pendingInvitations = []
        isLoading = false
        isLoadingPendingInvitations = false
        isMutating = false
        errorMessage = nil
        pendingInvitationsErrorMessage = nil
    }
}
