import XCTest
@testable import Tabtin

/// MessageHistoryMapper 纯映射单测：持久化 content_blocks_json → 精简 ChatMessage。
final class MessageHistoryTests: XCTestCase {

    private func decode(_ json: String) throws -> MessageHistoryResponse {
        try JSONDecoder().decode(MessageHistoryResponse.self, from: Data(json.utf8))
    }

    func testUserMessageUsesContent() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"m1","role":"user","content":"你好 Agent","created_at":"2026-06-18T10:00:00.000Z"}
        ],"total":1,"has_more":false}
        """#)
        let msgs = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].role, .user)
        XCTAssertEqual(msgs[0].text, "你好 Agent")
        XCTAssertEqual(msgs[0].persistedId, "m1")
        XCTAssertFalse(msgs[0].isStreaming)
    }

    func testAssistantTextThinkingAndToolUse() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"a1","role":"assistant","content":"summary","created_at":"2026-06-18T10:01:00.000Z",
           "content_blocks_json":[
             {"type":"thinking","thinking":"先想一下"},
             {"type":"text","text":"这是回答"},
             {"type":"tool_use","tool_use_id":"t1","name":"read_file","input":{"path":"a.swift"}}
           ]}
        ]}
        """#)
        let msgs = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(msgs.count, 1)
        let m = msgs[0]
        XCTAssertEqual(m.role, .assistant)
        XCTAssertEqual(m.text, "这是回答")
        XCTAssertEqual(m.thinking.count, 1)
        XCTAssertEqual(m.thinking[0].text, "先想一下")
        XCTAssertTrue(m.thinking[0].completed)
        XCTAssertEqual(m.toolCalls.count, 1)
        XCTAssertEqual(m.toolCalls[0].name, "read_file")
        XCTAssertEqual(m.toolCalls[0].toolCallId, "t1")
        XCTAssertTrue(m.toolCalls[0].finalized)
        XCTAssertTrue(m.toolCalls[0].inputJson.contains("a.swift"))
    }

    func testAssistantPreservesMessageLevelAgentIdentity() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"a-agent","role":"assistant","agent_id":"agent-new","content":"已切换"}
        ]}
        """#)

        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        XCTAssertEqual(message.agentId, "agent-new")
    }

    func testSharedSessionUserPreservesSenderIdentity() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"shared-user","role":"user","content":"协作者的新消息",
           "sender_user_id":"user-2","sender_display_name":"小林"}
        ]}
        """#)

        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        XCTAssertEqual(message.senderUserId, "user-2")
        XCTAssertEqual(message.senderDisplayName, "小林")
    }

    func testAgentSwitchAuditFactsAreHiddenFromTimeline() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"switch-fact","role":"system","content":"任意审计文案",
           "metadata":{"system_fact":"agent_switched"}},
          {"id":"switch-legacy","role":"system","content":"Agent 已切换成数据版"},
          {"id":"other-system","role":"system","content":"上下文已压缩到此",
           "metadata":{"system_fact":"other"}}
        ]}
        """#)

        let messages = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(messages.map(\.id), ["other-system"])
        XCTAssertEqual(messages.first?.text, "上下文已压缩到此")
    }

    func testBlocksPreserveContentBlockOrder() throws {
        // 历史回放也要按 content_block 真实顺序穿插：思考→正文→工具→正文。
        let resp = try decode(#"""
        {"messages":[
          {"id":"a9","role":"assistant","content":"","content_blocks_json":[
             {"type":"thinking","thinking":"先想"},
             {"type":"text","text":"正文一"},
             {"type":"tool_use","tool_use_id":"t1","name":"run","input":{}},
             {"type":"text","text":"正文二"}
          ]}
        ]}
        """#)
        let m = MessageHistoryMapper.map(resp.messages)[0]
        let kinds = m.blocks.map { block -> String in
            switch block {
            case .thinking: return "think"
            case .text: return "text"
            case .tool: return "tool"
            case .attachment: return "attachment"
            case .richContent: return "rich"
            case .contextRef: return "context"
            }
        }
        XCTAssertEqual(kinds, ["think", "text", "tool", "text"])
        XCTAssertEqual(m.text, "正文一正文二")
    }

    func testSearchResultsRichContentPreservesElectronFields() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"search-artifact","role":"assistant","content":"[富内容]","content_blocks_json":[
            {
              "type":"tabtin_rich_content",
              "kind":"search_results",
              "summary":"web_search: 百度 官网 (10000000)",
              "payload":{
                "query":"百度 官网",
                "total_count":10000000,
                "search_results":[
                  {
                    "title":"百度",
                    "url":"https://www.baidu.com/",
                    "snippet":"百度官方网站",
                    "score":0.98,
                    "content_type":"web"
                  }
                ]
              }
            }
          ]}
        ]}
        """#)

        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        guard case let .richContent(block) = try XCTUnwrap(message.blocks.first) else {
            return XCTFail("search_results 应映射为富内容块")
        }
        XCTAssertEqual(block.kind, "search_results")
        XCTAssertEqual(block.query, "百度 官网")
        XCTAssertEqual(block.totalCount, 10_000_000)
        XCTAssertEqual(block.searchResults.count, 1)
        XCTAssertEqual(block.searchResults[0].title, "百度")
        XCTAssertEqual(block.searchResults[0].url, "https://www.baidu.com/")
        XCTAssertEqual(block.searchResults[0].score, 0.98)
        XCTAssertEqual(block.searchResults[0].contentType, "web")
    }

    func testFormalOssImagePreservesFileIdentityAndIgnoresResourceURI() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"oss-image-history","role":"assistant","content":"","message_kind":"tool_artifact","content_blocks_json":[
            {
              "type":"tabtin_rich_content",
              "kind":"image",
              "summary":"永久图片",
              "payload":{
                "artifact_kind":"oss_file",
                "file_id":"file-ios-001",
                "file_name":"mountain.png",
                "mime_type":"image/png",
                "file_size":8090,
                "access_url":"https://oss.example.com/mountain.png",
                "source_tool_use_id":"tool-use-ios-history",
                "url":"tabtin://resource/file/file-ios-001?hint=tabfiles"
              }
            }
          ]}
        ]}
        """#)

        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        guard case let .richContent(block) = try XCTUnwrap(message.blocks.first) else {
            return XCTFail("正式图片应映射为富内容块")
        }
        XCTAssertEqual(block.fileId, "file-ios-001")
        XCTAssertEqual(block.url, "https://oss.example.com/mountain.png")
        XCTAssertEqual(block.filename, "mountain.png")
        XCTAssertEqual(block.mimeType, "image/png")
        XCTAssertEqual(block.fileSize, 8090)
        XCTAssertEqual(block.sourceToolUseId, "tool-use-ios-history")
    }

    func testSystemRichArtifactWithoutTextDoesNotRenderEmptyNotice() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"legacy-file-preview","role":"system","content":"","message_kind":"tool_artifact","content_blocks_json":[
            {
              "type":"tabtin_rich_content",
              "kind":"file",
              "summary":"photo_1.jpg",
              "payload":{
                "artifact_kind":"local_file",
                "relative_path":"attachments/photo_1.jpg",
                "filename":"photo_1.jpg"
              }
            }
          ]}
        ]}
        """#)

        let cachedMessage = try XCTUnwrap(MessageHistoryMapper.mapOne(resp.messages[0]))
        XCTAssertTrue(
            cachedMessage.isTimelineTransparent,
            "缓存恢复的 system 富内容没有正文时也不能退化成只有 info 图标的空提示"
        )
        XCTAssertTrue(
            MessageHistoryMapper.map(resp.messages).isEmpty,
            "网络历史中的 system 富内容没有正文时不能进入时间线"
        )
    }

    /// 旧服务把 web_search 结果重复落成一条 tool_artifact 气泡，工具卡已承载同一份结果，
    /// 整条气泡不得进主时间线——否则历史回放出现第二张搜索卡。
    func testLegacyWebSearchArtifactMessageIsHiddenFromTimeline() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"tool-1","role":"assistant","content":"[工具调用]","content_blocks_json":[
            {"type":"server_tool_use","id":"srv-9","name":"web_search","input":{"query":"TabTin"}},
            {"type":"web_search_tool_result","tool_use_id":"srv-9","content":[{"type":"web_search_result","title":"TabTin","url":"https://tabtin.ai"}]}
          ]},
          {"id":"artifact-1","role":"assistant","content":"","message_kind":"tool_artifact","content_blocks_json":[
            {"type":"tabtin_rich_content","kind":"search_results","summary":"web_search: TabTin (12)","payload":{"query":"TabTin"}}
          ]}
        ]}
        """#)

        XCTAssertEqual(MessageHistoryMapper.map(resp.messages).map(\.id), ["tool-1"])
    }

    /// 与上一条相对：rag / 知识库检索的 search_results 产物气泡没有对应工具卡承载，
    /// 必须照常渲染，不能被 web_search 的去重策略连坐。
    func testNonWebSearchResultsArtifactStillRenders() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"rag-1","role":"assistant","content":"","message_kind":"tool_artifact","content_blocks_json":[
            {
              "type":"tabtin_rich_content",
              "kind":"search_results",
              "summary":"知识库检索: 报销流程 (3)",
              "payload":{
                "query":"报销流程",
                "search_results":[{"title":"报销制度","url":"https://tabtin.ai/doc/1"}]
              }
            }
          ]}
        ]}
        """#)

        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        guard case let .richContent(block) = try XCTUnwrap(message.blocks.first) else {
            return XCTFail("rag search_results 应保留为富内容块")
        }
        XCTAssertEqual(block.kind, "search_results")
        XCTAssertEqual(block.searchResults.count, 1)
    }

    func testSearchResultScoreRejectsNonFiniteAndKeepsFiniteValues() {
        let results = RichSearchResult.fromPayload([
            ["title": "nan", "score": "nan"],
            ["title": "overflow", "score": "1e309"],
            ["title": "negative", "score": -2.0],
            ["title": "normal", "score": 0.75],
        ])

        XCTAssertNil(results[0].score)
        XCTAssertNil(results[1].score)
        XCTAssertEqual(results[2].score, -2.0)
        XCTAssertEqual(results[3].score, 0.75)
    }

    func testMultipleTextBlocksConcatenate() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"a2","role":"assistant","content":"","content_blocks_json":[
             {"type":"text","text":"第一段"},
             {"type":"text","text":"第二段"}
          ]}
        ]}
        """#)
        let m = MessageHistoryMapper.map(resp.messages)[0]
        XCTAssertEqual(m.text, "第一段第二段")
    }

    func testEmptyBlocksFallBackToContent() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"a3","role":"assistant","content":"只有摘要","content_blocks_json":[]}
        ]}
        """#)
        let m = MessageHistoryMapper.map(resp.messages)[0]
        XCTAssertEqual(m.text, "只有摘要")
    }

    func testTextSummaryPlaceholderNotRenderedAsText() throws {
        // 纯 tool_use 消息：content 是 Django 占位 "[工具调用]"，不能当正文渲染。
        let resp = try decode(#"""
        {"messages":[
          {"id":"a4","role":"assistant","content":"[工具调用]","content_blocks_json":[
             {"type":"tool_use","tool_use_id":"t9","name":"run","input":{}}
          ]}
        ]}
        """#)
        let m = MessageHistoryMapper.map(resp.messages)[0]
        XCTAssertEqual(m.text, "")
        XCTAssertEqual(m.toolCalls.count, 1)
    }

    func testWebSearchServerToolPairsResultAndHidesLegacyArtifact() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"search-1","role":"assistant","content":"[工具调用]","content_blocks_json":[
            {"type":"server_tool_use","id":"srv-1","name":"web_search","input":{"query":"TabTin"}},
            {"type":"web_search_tool_result","tool_use_id":"srv-1","content":[{"type":"web_search_result","title":"TabTin","url":"https://tabtin.ai"}]},
            {"type":"tabtin_rich_content","kind":"search_results","summary":"旧搜索 artifact"}
          ]}
        ]}
        """#)

        let message = MessageHistoryMapper.map(resp.messages)[0]
        XCTAssertEqual(message.toolCalls.count, 1)
        XCTAssertEqual(message.toolCalls[0].name, "web_search")
        XCTAssertTrue(message.toolCalls[0].inputJson.contains("TabTin"))
        XCTAssertTrue(message.toolCalls[0].resultText?.contains("https://tabtin.ai") == true)
        XCTAssertFalse(message.blocks.contains { if case .richContent = $0 { return true }; return false })
    }

    func testAttachmentOnlyUserMessageDoesNotRenderRichContentSummaryAsText() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"u-image","role":"user","content":"[富内容]","content_blocks_json":[
             {"type":"image","filename":"reference.png","url":"https://oss.example.com/reference.png"},
             {"type":"file","filename":"notes.pdf","url":"https://oss.example.com/notes.pdf"}
          ]}
        ]}
        """#)

        let m = MessageHistoryMapper.map(resp.messages)[0]

        XCTAssertEqual(m.text, "")
        XCTAssertEqual(m.blocks.count, 2)
        guard case let .attachment(image) = m.blocks[0] else {
            return XCTFail("图片必须作为附件，而不是富内容或正文")
        }
        XCTAssertEqual(image.kind, .image)
        guard case let .attachment(file) = m.blocks[1] else {
            return XCTFail("文件必须作为附件，而不是空白正文")
        }
        XCTAssertEqual(file.kind, .file)
    }

    func testThinkingPlaceholderNotRenderedAsText() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"a5","role":"assistant","content":"[思考中]","content_blocks_json":[]}
        ]}
        """#)
        XCTAssertEqual(MessageHistoryMapper.mapOne(resp.messages[0])?.text, "")
        // 占位被滤掉后不剩任何可视块，空壳不得再占时间线位（ 对齐 Electron，
        // 否则会切开相邻「执行详情 · N 步」的跨消息合并）。
        XCTAssertTrue(MessageHistoryMapper.map(resp.messages).isEmpty)
    }

    func testUnknownRoleFallsBackToSystem() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"s1","role":"tool","content":"noise"}
        ]}
        """#)
        let m = MessageHistoryMapper.map(resp.messages)[0]
        XCTAssertEqual(m.role, .system)
    }

    func testSubagentTranscriptMessagesAreFilteredFromMainTimeline() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"parent","role":"assistant","content":"父会话回答","created_at":"2026-06-18T10:00:00.000Z"},
          {"id":"child","role":"assistant","content":"子 Agent 详情","subagent_run_id":"run-child",
           "created_at":"2026-06-18T10:00:01.000Z"}
        ]}
        """#)

        let msgs = MessageHistoryMapper.map(resp.messages)

        XCTAssertEqual(msgs.map(\.id), ["parent"])
        XCTAssertNil(msgs[0].subagentRunId)
    }

    func testAgentProfileContextIsHiddenForTypedAndLegacyHistory() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"profile-kind","role":"user","message_kind":"agent_profile_context","content":"<context type=\"agent-profile\">profile</context>"},
          {"id":"profile-legacy","role":"user","content":"<context type=\"agent-profile\">profile</context>"},
          {"id":"referenced","role":"user","content":"<context type=\"referenced\">doc</context>"},
          {"id":"normal","role":"user","content":"hello"}
        ]}
        """#)

        let msgs = MessageHistoryMapper.map(resp.messages)

        XCTAssertEqual(msgs.map(\.id), ["referenced", "normal"])
    }

    func testInternalContextMessagesAreFilteredFromMainTimeline() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"user","role":"user","content":"真实问题"},
          {"id":"env","role":"system","message_kind":"environment_context",
           "content":"<context type=\"environment\">\ncurrent_datetime: 2026\n</context>"},
          {"id":"profile","role":"system","message_kind":"agent_profile_context",
           "content":"<context type=\"agent-profile\">\n你是小 Tin。\n</context>"},
          {"id":"system-prompt","role":"system","message_kind":"system_prompt_context",
           "content":"<system-prompt>internal</system-prompt>"},
          {"id":"external-archive","role":"assistant","message_kind":"external_archive_context",
           "content":"外部归档上下文"},
          {"id":"legacy-external","role":"user","message_kind":"llm",
           "content":"<context type=\"external-archive\">legacy archive</context>"},
          {"id":"legacy-identity","role":"user","message_kind":"llm",
           "content":"<identity>internal identity</identity>"},
          {"id":"share-briefing","role":"system","message_kind":"llm",
           "content":"共享会话 briefing","metadata":{"share_briefing":true}},
          {"id":"share-contract","role":"system","message_kind":"llm",
           "content":"共享会话 contract","metadata":{"share_contract":true}}
        ]}
        """#)

        XCTAssertEqual(MessageHistoryMapper.map(resp.messages).map(\.id), ["user"])
    }

    ///  / ：压缩检查点进时间线，但标记为 pill 展示（禁止当用户气泡）。
    func testCompactionSummaryMessagesAppearAsPresentationNotInternalHide() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"user","role":"user","content":"真实问题"},
          {"id":"compact-kind","role":"user","message_kind":"compaction_summary",
           "content":"摘要正文不应出现"},
          {"id":"compact-markers","role":"user","message_kind":"llm",
           "content":"[对话摘要]\n先前讨论了发布计划\n[摘要结束]\n[最近对话如下]"},
          {"id":"assistant","role":"assistant","content":"好的"}
        ]}
        """#)

        let mapped = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(mapped.map(\.id), ["user", "compact-kind", "compact-markers", "assistant"])
        XCTAssertTrue(mapped[1].isCompactionSummary)
        XCTAssertTrue(mapped[2].isCompactionSummary)
        XCTAssertFalse(mapped[0].isCompactionSummary)
        XCTAssertFalse(InternalUserContextVisibility.isHidden(messageKind: "compaction_summary", text: nil))
        XCTAssertFalse(InternalUserContextVisibility.isHidden(
            text: "[对话摘要]\nx\n[摘要结束]"
        ))
        XCTAssertTrue(CompactionSummaryPresentation.isPresentation(
            messageKind: "compaction_summary", text: nil
        ))
        XCTAssertTrue(CompactionSummaryPresentation.isPresentation(
            messageKind: nil, text: "[对话摘要]\nx\n[摘要结束]"
        ))
    }

    func testLegacyAgentProfileContextMisclassifiedAsLLMIsFiltered() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"profile","role":"user","message_kind":"llm",
           "content":"<context type=\"agent-profile\">\n你是小 Tin。\n</context>"},
          {"id":"assistant","role":"assistant","content":"你好"}
        ]}
        """#)

        XCTAssertEqual(MessageHistoryMapper.map(resp.messages).map(\.id), ["assistant"])
    }

    func testMissingIdSkipped() throws {
        let resp = try decode(#"""
        {"messages":[
          {"role":"user","content":"没有 id"},
          {"id":"ok","role":"user","content":"有 id"}
        ]}
        """#)
        let msgs = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].id, "ok")
    }

    /// 多轮 tool → tool_result → tool：合成 user carrier 不得占时间线，否则会切成多个「执行详情 · 2 步」。
    func testSyntheticToolResultCarriersDoNotSplitExecutionGroups() throws {
        let resp = try decode(#"""
        {"messages":[
          {"id":"u1","role":"user","content":"测试生成在线文档"},
          {"id":"a1","role":"assistant","content":"[工具调用]","content_blocks_json":[
             {"type":"thinking","thinking":"先查帮助"},
             {"type":"tool_use","tool_use_id":"t1","name":"run_terminal_command","input":{"command":"tabtin doc --help"}}
          ]},
          {"id":"tr1","role":"user","content":"[工具调用]","content_blocks_json":[
             {"type":"tool_result","tool_use_id":"t1","content":"Usage: tabtin doc"}
          ]},
          {"id":"a2","role":"assistant","content":"[工具调用]","content_blocks_json":[
             {"type":"thinking","thinking":"再创建文档"},
             {"type":"tool_use","tool_use_id":"t2","name":"run_terminal_command","input":{"command":"tabtin doc create"}}
          ]},
          {"id":"tr2","role":"user","content":"[工具调用]","content_blocks_json":[
             {"type":"tool_result","tool_use_id":"t2","content":"{\"ok\":true}"}
          ]},
          {"id":"a3","role":"assistant","content":"完成","content_blocks_json":[
             {"type":"thinking","thinking":"收尾"},
             {"type":"text","text":"✅ 在线文档已生成"}
          ]}
        ]}
        """#)

        let msgs = MessageHistoryMapper.map(resp.messages)
        XCTAssertEqual(msgs.map(\.id), ["u1", "a1", "a2", "a3"])
        XCTAssertEqual(msgs[1].toolCalls.first?.resultText, "Usage: tabtin doc")
        XCTAssertEqual(msgs[2].toolCalls.first?.resultText, "{\"ok\":true}")

        let units = MessageListRenderUnit.group(msgs)
        // user + 跨消息执行组(a1+a2) + 终答(a3)
        XCTAssertEqual(units.count, 3)
        guard case let .stepGroup(grouped) = units[1] else {
            return XCTFail("tool_result carrier 剔除后，相邻纯步骤子轮应合成一个执行组")
        }
        XCTAssertEqual(grouped.map(\.id), ["a1", "a2"])
        guard case let .single(final) = units[2] else {
            return XCTFail("终答带可见正文应单独成气泡")
        }
        XCTAssertEqual(final.id, "a3")
    }
}

final class ContextRefNavigationPolicyTests: XCTestCase {
    func testPlatformDocumentPrefersCurrentEnvironmentResourceNavigation() {
        let block = makeBlock(
            type: "document",
            resourceId: "doc-current-environment",
            url: "https://wrong-environment.example.com/tabdoc/doc-from-pc"
        )

        XCTAssertEqual(
            ContextRefNavigationPolicy.destination(for: block),
            .resource(type: "tabdoc", id: "doc-current-environment")
        )
    }

    func testWebReferenceKeepsExternalURLNavigation() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/source"))
        let block = makeBlock(type: "web", resourceId: nil, url: url.absoluteString)

        XCTAssertEqual(
            ContextRefNavigationPolicy.destination(for: block),
            .externalURL(url)
        )
    }

    func testPlatformReferenceWithoutResourceIdFallsBackToURL() throws {
        let url = try XCTUnwrap(URL(string: "https://legacy.example.com/tabdoc/doc-1"))
        let block = makeBlock(type: "document", resourceId: nil, url: url.absoluteString)

        XCTAssertEqual(
            ContextRefNavigationPolicy.destination(for: block),
            .externalURL(url)
        )
    }

    private func makeBlock(type: String, resourceId: String?, url: String?) -> ContextRefBlock {
        ContextRefBlock(
            index: 0,
            type: type,
            resourceId: resourceId,
            url: url,
            tableId: nil,
            docId: nil,
            rowIds: [],
            fieldIds: [],
            label: "引用",
            preview: nil,
            spaceId: nil,
            spaceName: nil,
            locationHint: nil
        )
    }
}
