import XCTest
@testable import Tabtin

final class ConversationSessionInfoTests: XCTestCase {
    @MainActor
    func testSessionShareSubmissionStartsSynchronouslyAndIgnoresDuplicateTap() async {
        let controller = IMSessionShareSubmissionController()
        let intent = IMSessionShareSubmissionController.Intent(
            sessionId: "session-1",
            peerUserId: "user-2",
            mode: .viewOnly
        )
        var invocationCount = 0
        var successCount = 0
        var requestIds: [String] = []
        var continuation: CheckedContinuation<Void, Never>?

        let operation: @MainActor (String) async throws -> Void = { requestId in
            invocationCount += 1
            requestIds.append(requestId)
            await withCheckedContinuation { continuation = $0 }
        }

        controller.submit(intent: intent, operation: operation) { successCount += 1 }
        XCTAssertTrue(controller.isSubmitting, "首次点击必须同步进入提交态，不能等异步任务启动后再加锁")
        XCTAssertNotNil(controller.clientRequestId.flatMap(UUID.init(uuidString:)))

        controller.submit(intent: intent, operation: operation) { successCount += 1 }
        for _ in 0..<20 where continuation == nil {
            await Task.yield()
        }

        XCTAssertEqual(invocationCount, 1, "网络请求在途时连续点击只能发起一次共享")
        XCTAssertEqual(requestIds.count, 1)
        continuation?.resume()
        for _ in 0..<20 where successCount == 0 {
            await Task.yield()
        }

        XCTAssertEqual(successCount, 1, "成功后只能触发一次关闭流程")
        XCTAssertFalse(controller.isSubmitting)
        XCTAssertNil(controller.clientRequestId, "成功后下一次共享必须使用新的幂等键")
    }

    @MainActor
    func testSessionShareSubmissionReusesRequestIdOnlyForTheSameFailedIntent() async {
        let generatedIds = [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
        ]
        var nextId = 0
        let controller = IMSessionShareSubmissionController {
            defer { nextId += 1 }
            return generatedIds[nextId]
        }
        let viewOnly = IMSessionShareSubmissionController.Intent(
            sessionId: "session-1",
            peerUserId: "user-2",
            mode: .viewOnly
        )
        let continuation = IMSessionShareSubmissionController.Intent(
            sessionId: "session-1",
            peerUserId: "user-2",
            mode: .continueTask
        )
        var requestIds: [String] = []

        controller.submit(
            intent: viewOnly,
            operation: { requestId in
                requestIds.append(requestId)
                throw URLError(.timedOut)
            },
            onSuccess: { XCTFail("失败请求不应进入成功回调") }
        )
        for _ in 0..<20 where controller.errorMessage == nil { await Task.yield() }

        controller.submit(
            intent: viewOnly,
            operation: { requestId in
                requestIds.append(requestId)
                throw URLError(.timedOut)
            },
            onSuccess: { XCTFail("失败请求不应进入成功回调") }
        )
        for _ in 0..<20 where controller.errorMessage == nil { await Task.yield() }

        controller.submit(
            intent: continuation,
            operation: { requestId in
                requestIds.append(requestId)
                throw URLError(.timedOut)
            },
            onSuccess: { XCTFail("失败请求不应进入成功回调") }
        )
        for _ in 0..<20 where controller.errorMessage == nil { await Task.yield() }

        controller.reset()

        controller.submit(
            intent: continuation,
            operation: { requestIds.append($0) },
            onSuccess: {}
        )
        for _ in 0..<20 where controller.isSubmitting { await Task.yield() }

        controller.submit(
            intent: continuation,
            operation: { requestIds.append($0) },
            onSuccess: {}
        )
        for _ in 0..<20 where controller.isSubmitting { await Task.yield() }

        XCTAssertEqual(
            requestIds,
            [generatedIds[0], generatedIds[0], generatedIds[1], generatedIds[2], generatedIds[3]]
        )
    }

    func testSessionDecodesBackendLineageAndFrozenConfigurationFacts() throws {
        let data = Data("""
        {
          "id":"session-1","title":"分支任务","status":"active","is_paused":false,
          "organization_id":"org-1","workspace_id":"workspace-1","project_id":"project-1",
          "agent_id":"agent-frozen","agent_mode":"agent","approval_mode":"always_ask",
          "current_model_id":"model-1","current_model_name":"GPT","context_tier_id":"long",
          "model_param_overrides":{"v":2,"thinking_mode":"deep"},
          "created_at":"2026-07-27T00:00:00Z","updated_at":"2026-07-27T00:01:00Z",
          "forked_from_id":"parent-1","fork_point_message_id":"message-9",
          "fork_count":2,"fork_copy_status":"pending","warnings":["后台复制中"]
        }
        """.utf8)

        let session = try JSONDecoder().decode(ChatSession.self, from: data)

        XCTAssertEqual(session.workspaceId, "workspace-1")
        XCTAssertEqual(session.agentMode, "agent")
        XCTAssertEqual(session.approvalMode, "always_ask")
        XCTAssertEqual(session.contextTierId, "long")
        XCTAssertEqual(session.modelParamOverrides?.version, 2)
        XCTAssertEqual(session.modelParamOverrides?.thinkingMode, .deep)
        XCTAssertEqual(session.forkedFromId, "parent-1")
        XCTAssertEqual(session.forkPointMessageId, "message-9")
        XCTAssertEqual(session.forkCount, 2)
        XCTAssertEqual(session.forkCopyStatus, "pending")
        XCTAssertEqual(session.warnings, ["后台复制中"])
    }

    func testSessionMissingModelParamOverridesRemainsCompatible() throws {
        let session = try JSONDecoder().decode(ChatSession.self, from: Data("""
        {
          "id":"session-2","workspace_id":"workspace-1","organization_id":"org-1",
          "context_tier_id":"standard"
        }
        """.utf8))
        XCTAssertEqual(session.contextTierId, "standard")
        XCTAssertNil(session.modelParamOverrides)
    }

    func testChatRuntimeEndpointsMatchContractPaths() {
        XCTAssertEqual(
            Endpoints.Chat.sessionContextTier("s1"),
            "/chat/sessions/s1/context-tier"
        )
        XCTAssertEqual(
            Endpoints.Chat.sessionModelParams("s1"),
            "/chat/sessions/s1/model-params"
        )
        XCTAssertEqual(
            Endpoints.Chat.sessionModel("s1"),
            "/chat/sessions/s1/model"
        )
    }

    func testForkCopyPresentationNeverClaimsPendingIsReady() {
        XCTAssertEqual(
            ChatSessionInfoPolicy.copyStatusText("pending"),
            "消息正在后台复制；完成前请勿发送新消息"
        )
        XCTAssertEqual(ChatSessionInfoPolicy.copyStatusText("complete"), "复制完成")
        XCTAssertEqual(ChatSessionInfoPolicy.copyStatusText("failed"), "消息复制失败")
        XCTAssertNil(ChatSessionInfoPolicy.copyStatusText(nil))
    }

    func testMissingSessionFactsAreExplicitRatherThanGuessed() {
        XCTAssertEqual(ChatSessionInfoPolicy.display(nil), "未提供")
        XCTAssertEqual(ChatSessionInfoPolicy.display("   "), "未提供")
        XCTAssertEqual(ChatSessionInfoPolicy.display("workspace-1"), "workspace-1")
    }

    func testFrozenConfigurationUsesProductLanguage() {
        XCTAssertEqual(ChatSessionInfoPolicy.modeTitle("agent"), "执行")
        XCTAssertEqual(ChatSessionInfoPolicy.modeTitle("plan"), "规划")
        XCTAssertEqual(ChatSessionInfoPolicy.modeTitle(nil), "未提供")
        XCTAssertEqual(ChatSessionInfoPolicy.modeTitle("study"), "study")
        XCTAssertEqual(ChatSessionInfoPolicy.approvalTitle("always_ask"), "请求权限")
        XCTAssertEqual(ChatSessionInfoPolicy.approvalTitle("full_access"), "全部允许")
        XCTAssertEqual(ChatSessionInfoPolicy.approvalTitle(nil), "未提供")
    }

    func testSessionShareRequestMapsNewLiveModesWithoutExposingFork() {
        let viewOnly = ConversationSessionShareRequest(
            sessionId: "session-1",
            granteeUserId: "user-2",
            mode: .viewOnly,
            conversationId: "dm-1",
            clientRequestId: "share-request-1"
        )
        XCTAssertEqual(viewOnly.body["session_id"] as? String, "session-1")
        XCTAssertEqual(viewOnly.body["grantee_user_id"] as? String, "user-2")
        XCTAssertEqual(viewOnly.body["can_fork"] as? Bool, false)
        XCTAssertEqual(viewOnly.body["can_chat"] as? Bool, false)
        XCTAssertEqual(viewOnly.body["conversation_id"] as? String, "dm-1")
        XCTAssertEqual(viewOnly.body["client_request_id"] as? String, "share-request-1")

        let collaborate = ConversationSessionShareRequest(
            sessionId: "session-1",
            granteeUserId: "user-2",
            mode: .collaborate
        )
        XCTAssertEqual(collaborate.body["can_fork"] as? Bool, false)
        XCTAssertEqual(collaborate.body["can_chat"] as? Bool, true)
        XCTAssertEqual(collaborate.body["access_mode"] as? String, "collaborate")
        XCTAssertTrue(ConversationSessionShareMode.continueTask.isContinuation)
    }

    func testShareRecipientProjectionExcludesSelfAndSortsDeterministically() {
        let me = organizationMember(id: "member-me", userId: "user-me", name: "我")
        let second = organizationMember(id: "member-2", userId: "user-2", name: "Beta")
        let first = organizationMember(id: "member-1", userId: "user-1", name: "Alpha")
        let invalid = organizationMember(id: "member-empty", userId: "", name: "Empty")

        let recipients = ConversationSessionSharePolicy.recipients(
            from: [me, second, invalid, first],
            currentUserId: "user-me"
        )

        XCTAssertEqual(recipients.map(\.userId), ["user-1", "user-2"])
    }

    func testShareRecipientSearchUsesServerNicknameModeForPinyin() {
        XCTAssertNil(ConversationSessionSharePolicy.memberSearchQuery("   "))
        XCTAssertEqual(
            ConversationSessionSharePolicy.memberSearchQuery("  hu  "),
            ["search": "hu", "search_mode": "nickname"]
        )
        XCTAssertEqual(
            ConversationSessionSharePolicy.emptyRecipientsMessage(search: " "),
            "组织内没有其他可共享成员"
        )
        XCTAssertEqual(
            ConversationSessionSharePolicy.emptyRecipientsMessage(search: "hu"),
            "未找到匹配成员"
        )
        XCTAssertNil(
            ConversationSessionSharePolicy.memberSearchErrorMessage(for: CancellationError())
        )
        XCTAssertEqual(
            ConversationSessionSharePolicy.memberSearchErrorMessage(
                for: APIError.networkError(URLError(.timedOut))
            ),
            "搜索组织成员失败，请稍后重试。"
        )
        XCTAssertNotEqual(
            ConversationSessionSharePolicy.MemberSearchIdentity(
                organizationId: "org-1",
                rawQuery: " hu "
            ),
            ConversationSessionSharePolicy.MemberSearchIdentity(
                organizationId: "org-2",
                rawQuery: "hu"
            )
        )
    }

    func testShareRecipientSubtitleDoesNotExposeEmailWithoutUsername() {
        let usernameMember = organizationMember(
            id: "member-1",
            userId: "user-1",
            name: "小林",
            username: " lin ",
            email: "lin@example.com"
        )
        let emailOnlyMember = organizationMember(
            id: "member-2",
            userId: "user-secret-id",
            name: "小周",
            username: nil,
            email: "private@example.com"
        )

        XCTAssertEqual(ConversationSessionSharePolicy.recipientSubtitle(usernameMember), "@lin")
        XCTAssertNil(ConversationSessionSharePolicy.recipientSubtitle(emailOnlyMember))
        XCTAssertEqual(ConversationSessionSharePolicy.memberDisplayName(usernameMember), "小林")
        XCTAssertEqual(ConversationSessionSharePolicy.memberDisplayName(emailOnlyMember), "小周")
        XCTAssertEqual(
            ConversationSessionSharePolicy.retainedRecipientId("user-1", in: [usernameMember]),
            "user-1"
        )
        XCTAssertNil(
            ConversationSessionSharePolicy.retainedRecipientId("user-secret-id", in: [usernameMember])
        )
        XCTAssertEqual(
            ConversationSessionSharePolicy.memberDisplayName(
                organizationMember(
                    id: "member-3",
                    userId: "user-secret-id-2",
                    name: "",
                    username: nil,
                    email: "private-2@example.com"
                )
            ),
            "成员"
        )
    }

    func testShareSubmissionPolicyPreventsDuplicateSuccessAndInFlightRequests() {
        XCTAssertFalse(
            ConversationSessionSharePolicy.canSubmit(
                selectedUserId: nil,
                isSubmitting: false,
                completedShareId: nil
            )
        )
        XCTAssertTrue(
            ConversationSessionSharePolicy.canSubmit(
                selectedUserId: "user-2",
                isSubmitting: false,
                completedShareId: nil
            )
        )
        XCTAssertFalse(
            ConversationSessionSharePolicy.canSubmit(
                selectedUserId: "user-2",
                isSubmitting: true,
                completedShareId: nil
            )
        )
        XCTAssertFalse(
            ConversationSessionSharePolicy.canSubmit(
                selectedUserId: "user-2",
                isSubmitting: false,
                completedShareId: "share-1"
            )
        )
    }

    func testShareSelectionIsFrozenOnlyWhileSubmittingOrAfterSuccess() {
        XCTAssertTrue(
            ConversationSessionSharePolicy.canEditSelection(
                isSubmitting: false,
                completedShareId: nil
            )
        )
        XCTAssertFalse(
            ConversationSessionSharePolicy.canEditSelection(
                isSubmitting: true,
                completedShareId: nil
            )
        )
        XCTAssertFalse(
            ConversationSessionSharePolicy.canEditSelection(
                isSubmitting: false,
                completedShareId: "share-1"
            )
        )
        // 失败不产生 completedShareId，因此保留原选择后可直接重试。
        XCTAssertTrue(
            ConversationSessionSharePolicy.canEditSelection(
                isSubmitting: false,
                completedShareId: nil
            )
        )
    }

    func testShareSuccessProjectionNamesDirectMessageAnchor() {
        let response = ConversationSessionShareResponse(
            id: "share-1",
            sessionId: "session-1",
            sessionTitle: "调研",
            granteeUserId: "user-2",
            canFork: false,
            canChat: false,
            conversationId: "dm-1",
            messageId: 42
        )

        XCTAssertEqual(
            ConversationSessionSharePolicy.destinationText(
                recipientName: "小林",
                response: response
            ),
            "共享卡已发送到你与小林的私信（消息 #42）。"
        )
    }

    func testArchivePolicyBlocksEveryNonTerminalRunWithoutCancellingIt() {
        XCTAssertNotNil(
            ConversationArchivePolicy.blockedReason(
                isStreaming: true,
                authoritativeStatus: nil
            )
        )
        for status in [
            SessionRunStatus.queued,
            .running,
            .waitingUser,
            .paused,
            .cancelling,
        ] {
            XCTAssertNotNil(
                ConversationArchivePolicy.blockedReason(
                    isStreaming: false,
                    authoritativeStatus: status
                )
            )
        }
        for status in [
            SessionRunStatus.completed,
            .failed,
            .cancelled,
            .interrupted,
        ] {
            XCTAssertNil(
                ConversationArchivePolicy.blockedReason(
                    isStreaming: false,
                    authoritativeStatus: status
                )
            )
        }
    }

    func testArchiveContextPrefersAuthoritativeScopeAndFallsBackToEntryScope() {
        XCTAssertEqual(
            ConversationArchiveContext.resolving(
                sessionId: " session-1 ",
                authoritativeOrganizationId: "org-authoritative",
                cachedOrganizationId: "org-cached",
                fallbackOrganizationId: "org-entry",
                authoritativeSpaceId: "space-authoritative",
                cachedSpaceId: "space-cached",
                fallbackSpaceId: "space-entry"
            ),
            ConversationArchiveContext(
                sessionId: "session-1",
                organizationId: "org-authoritative",
                spaceId: "space-authoritative"
            )
        )

        let fallback = ConversationArchiveContext.resolving(
            sessionId: "session-2",
            authoritativeOrganizationId: nil,
            cachedOrganizationId: " ",
            fallbackOrganizationId: "org-entry",
            authoritativeSpaceId: nil,
            cachedSpaceId: nil,
            fallbackSpaceId: "space-entry"
        )
        XCTAssertEqual(fallback?.organizationId, "org-entry")
        XCTAssertEqual(fallback?.spaceId, "space-entry")
        XCTAssertTrue(fallback?.belongs(toSpace: "space-entry") == true)
        XCTAssertFalse(fallback?.belongs(toSpace: "space-other") == true)
    }

    private func organizationMember(
        id: String,
        userId: String,
        name: String,
        username: String? = nil,
        email: String? = nil
    ) -> OrganizationMember {
        OrganizationMember(
            id: id,
            userId: userId,
            role: .viewer,
            joinedAt: nil,
            user: MemberUser(
                id: userId,
                nickname: name,
                username: username,
                email: email,
                phone: nil,
                avatar: nil
            )
        )
    }
}
