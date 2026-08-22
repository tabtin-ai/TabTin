import XCTest
@testable import Tabtin

/// 校验附件消息（image/file）的 metadata 解析与判定便捷属性。
final class IMAttachmentModelTests: XCTestCase {
    private func decode(_ json: String) -> IMMessage {
        try! JSONDecoder().decode(IMMessage.self, from: Data(json.utf8))
    }

    func testImageMessageParsesAttachmentFields() {
        let msg = decode("""
        {
          "id": 1, "seq": 1, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "看图",
          "message_type": 4, "has_attachment": true,
          "metadata": {"file_id": "f-1", "file_name": "pic.png", "file_size": 2048, "file_type": "image/png"}
        }
        """)
        XCTAssertTrue(msg.isImageAttachment)
        XCTAssertFalse(msg.isFileAttachment)
        XCTAssertEqual(msg.attachmentFileId, "f-1")
        XCTAssertEqual(msg.attachmentFileName, "pic.png")
        XCTAssertEqual(msg.attachmentFileSize, 2048)
    }

    func testFileMessageParsesAsFileAttachment() {
        let msg = decode("""
        {
          "id": 2, "seq": 2, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 3, "has_attachment": true,
          "metadata": {"file_id": "f-2", "file_name": "report.pdf", "file_size": 10240, "file_type": "application/pdf"}
        }
        """)
        XCTAssertTrue(msg.isFileAttachment)
        XCTAssertFalse(msg.isImageAttachment)
        XCTAssertEqual(msg.attachmentFileName, "report.pdf")
    }

    func testFullAttachmentSnapshotUsesBackendMessageIdForDownload() {
        let msg = decode("""
        {
          "id": 10, "seq": 10, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 4, "has_attachment": true,
          "metadata": {"kind": "message", "tabtin_message_id": "914", "file_id": "f-3", "file_name": "pic.png"}
        }
        """)

        XCTAssertEqual(msg.attachmentLookupMessageId, 914)
    }

    func testMetadataExposesCompatibleInlineAttachmentURLs() {
        let msg = decode("""
        {
          "id": 10, "seq": 10, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 4, "has_attachment": true,
          "metadata": {
            "file_id": "f-3",
            "download_url": " https://example-assets.oss-cn-shanghai.aliyuncs.com/a.png ",
            "cdn_url": "https://assets.example.com/a.png",
            "access_url": "ftp://ignored.test/a.png",
            "url": "https://assets.example.com/a.png"
          }
        }
        """)

        XCTAssertEqual(
            msg.metadata?.inlineAttachmentURLs,
            [
                "https://example-assets.oss-cn-shanghai.aliyuncs.com/a.png",
                "https://assets.example.com/a.png",
            ]
        )
    }

    func testTextMessageHasNoAttachment() {
        let msg = decode("""
        {
          "id": 3, "seq": 3, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "你好",
          "message_type": 1, "has_attachment": false, "metadata": {}
        }
        """)
        XCTAssertFalse(msg.isImageAttachment)
        XCTAssertFalse(msg.isFileAttachment)
        XCTAssertNil(msg.attachmentFileId)
    }

    func testImageTypeButMissingFileIdIsNotAttachment() {
        // message_type=image 但 metadata 无 file_id / has_attachment 缺省 → 不当作附件，避免空气泡。
        let msg = decode("""
        {
          "id": 4, "seq": 4, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 4, "metadata": {}
        }
        """)
        XCTAssertFalse(msg.isImageAttachment)
        XCTAssertNil(msg.attachmentFileId)
    }

    func testDocumentCardMessageParsesResourceCard() {
        let msg = decode("""
        {
          "id": 10, "seq": 10, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "分享给你",
          "message_type": 1, "has_attachment": false,
          "metadata": {"card": {"type": "document", "resource_id": "d-1", "name": "周报", "description": "本周进展…"}}
        }
        """)
        let card = try! XCTUnwrap(msg.resourceCard)
        XCTAssertEqual(card.typedType, .document)
        XCTAssertEqual(card.displayName, "周报")
        XCTAssertEqual(card.description, "本周进展…")
        XCTAssertFalse(msg.isImageAttachment)
    }

    func testResourceCardDisplayNameUsesCompatibleTitleFields() {
        let document = decode("""
        {
          "id": 101, "seq": 101, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 1,
          "metadata": {"card": {"type": "document", "resource_id": "d-2", "title": "云文档标题"}}
        }
        """)
        XCTAssertEqual(document.resourceCard?.displayName, "云文档标题")

        let table = decode("""
        {
          "id": 102, "seq": 102, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 1,
          "metadata": {"card": {"type": "table", "resource_id": "t-2", "displayName": "客户表"}}
        }
        """)
        XCTAssertEqual(table.resourceCard?.displayName, "客户表")

        let contact = decode("""
        {
          "id": 103, "seq": 103, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 1,
          "metadata": {"card": {"type": "contact", "user_id": "u9", "display_name": "沈庾涛", "username": "syt"}}
        }
        """)
        XCTAssertEqual(contact.resourceCard?.displayName, "沈庾涛")

        let fileNamedDocument = decode("""
        {
          "id": 104, "seq": 104, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 1,
          "metadata": {"card": {"type": "document", "resource_id": "d-3", "file_name": "会议纪要"}}
        }
        """)
        XCTAssertEqual(fileNamedDocument.resourceCard?.displayName, "会议纪要")
    }

    func testResourceCardDisplayNameFallsBackToSpecificType() throws {
        let document = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"document","resource_id":"doc-1"}"#.utf8)
        )
        let table = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"table","resource_id":"table-1"}"#.utf8)
        )
        let contact = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"contact","user_id":"user-1"}"#.utf8)
        )

        XCTAssertEqual(document.displayName, "云文档")
        XCTAssertEqual(table.displayName, "表格")
        XCTAssertEqual(contact.displayName, "用户")
    }

    func testResourceCardDisplayNameUsesMessageContentFallback() {
        let contact = decode("""
        {
          "id": 105, "seq": 105, "conversation_id": "c1", "sender_id": "u2",
          "content": "[名片] 童俊芳",
          "message_type": 1,
          "metadata": {"card": {"type": "contact", "user_id": "u9"}}
        }
        """)
        XCTAssertEqual(contact.resourceCardDisplayName, "童俊芳")

        let document = decode("""
        {
          "id": 106, "seq": 106, "conversation_id": "c1", "sender_id": "u2",
          "content": "[文档] 未命名",
          "message_type": 1,
          "metadata": {"card": {"type": "document", "resource_id": "d9"}}
        }
        """)
        XCTAssertEqual(document.resourceCardDisplayName, "未命名")
    }

    func testTableCardParsesPreviewTable() {
        let msg = decode("""
        {
          "id": 11, "seq": 11, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 1,
          "metadata": {"card": {"type": "table", "resource_id": "t-1", "name": "客户表",
            "preview_table": {"columns": [{"key": "f1", "label": "名称"}, {"key": "f2", "label": "状态"}],
              "rows": [{"f1": "A", "f2": "进行中"}], "total_rows": 42}}}
        }
        """)
        let card = try! XCTUnwrap(msg.resourceCard)
        XCTAssertEqual(card.typedType, .table)
        let preview = try! XCTUnwrap(card.previewTable)
        XCTAssertEqual(preview.columns.map(\.label), ["名称", "状态"])
        XCTAssertEqual(preview.rows.first?["f1"], "A")
        XCTAssertEqual(preview.totalRows, 42)
    }

    func testResourceCardIgnoresUnrelatedMalformedFields() {
        let msg = decode("""
        {
          "id": 111, "seq": 111, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "[文档] 方案",
          "message_type": 1,
          "metadata": {"card": {
            "type": "document",
            "resource_id": "doc-1",
            "name": "方案",
            "can_fork": "true",
            "preview_table": {"columns": "bad"}
          }}
        }
        """)

        let card = try! XCTUnwrap(msg.resourceCard)
        XCTAssertEqual(card.typedType, .document)
        XCTAssertEqual(card.resourceId, "doc-1")
        XCTAssertEqual(card.displayName, "方案")
    }

    func testRecoverableResourceCardUsesCardTypeWhenCachedCardWasLost() {
        let msg = IMMessage(
            id: 112,
            seq: 112,
            conversationId: "c1",
            senderId: "u2",
            content: "[文档] 未命名文档",
            messageType: IMMessageType.text.rawValue,
            metadata: IMMessageMetadata(cardType: "document", hasCardPayload: true)
        )

        let card = try! XCTUnwrap(msg.resourceCard)
        XCTAssertEqual(card.typedType, .document)
        XCTAssertEqual(card.displayName, "未命名文档")
    }

    func testContactCardParsesIdentity() {
        let msg = decode("""
        {
          "id": 12, "seq": 12, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 1,
          "metadata": {"card": {"type": "contact", "user_id": "u9", "name": "李四", "username": "lisi", "avatar": ""}}
        }
        """)
        let card = try! XCTUnwrap(msg.resourceCard)
        XCTAssertEqual(card.typedType, .contact)
        XCTAssertEqual(card.displayName, "李四")
        XCTAssertEqual(card.username, "lisi")
    }

    func testUnknownCardTypeIsIgnored() {
        // 未知/非法 card 类型不当资源卡渲染，回退普通文本，避免空卡片。
        let msg = decode("""
        {
          "id": 13, "seq": 13, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "hi",
          "message_type": 1, "metadata": {"card": {"type": "space", "name": "X"}}
        }
        """)
        XCTAssertNil(msg.resourceCard)
    }

    func testCodexSessionCardParsesDownloadableSessionMetadata() throws {
        let msg = decode("""
        {
          "id": 131, "seq": 131, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "[Codex 会话] 排查 IM",
          "message_type": 3, "has_attachment": true,
          "metadata": {
            "file_id": "file-codex-1", "file_name": "session.zip", "file_size": 2048,
            "card": {
              "type": "codex_session", "schema_version": 1,
              "codex_session_id": " session-1 ",
              "codex_session_name": " 排查 IM ",
              "suggested_working_directory": " /workspace/tabtin "
            }
          }
        }
        """)

        let card = try XCTUnwrap(msg.codexSessionCard)
        XCTAssertEqual(card.sessionId, "session-1")
        XCTAssertEqual(card.sessionName, "排查 IM")
        XCTAssertEqual(card.suggestedWorkingDirectory, "/workspace/tabtin")
        XCTAssertTrue(msg.isFileAttachment)
        XCTAssertFalse(msg.isForwardRestrictedCard)
        let forwardPayload = try XCTUnwrap(msg.forwardableCard?.requestPayload())
        XCTAssertEqual(forwardPayload["type"] as? String, "codex_session")
        XCTAssertEqual(forwardPayload["schema_version"] as? Int, 1)
        XCTAssertEqual(forwardPayload["codex_session_id"] as? String, "session-1")
        XCTAssertEqual(forwardPayload["codex_session_name"] as? String, "排查 IM")
        XCTAssertEqual(forwardPayload["suggested_working_directory"] as? String, "/workspace/tabtin")
    }

    func testCodexSessionCardRejectsFutureSchemaAndIncompletePayloads() {
        let future = decode("""
        {
          "id": 132, "seq": 132, "conversation_id": "c1", "sender_id": "u2", "message_type": 3,
          "metadata": {"card": {
            "type": "codex_session", "schema_version": 2,
            "codex_session_id": "session-1", "codex_session_name": "排查 IM"
          }}
        }
        """)
        let incomplete = decode("""
        {
          "id": 133, "seq": 133, "conversation_id": "c1", "sender_id": "u2", "message_type": 3,
          "metadata": {"card": {
            "type": "codex_session", "schema_version": 1,
            "codex_session_id": "session-1", "codex_session_name": "   "
          }}
        }
        """)

        XCTAssertNil(future.codexSessionCard)
        XCTAssertNil(incomplete.codexSessionCard)
        XCTAssertNil(future.forwardableCard)
        XCTAssertNil(incomplete.forwardableCard)
        XCTAssertTrue(future.hasStructuredCard)
        XCTAssertTrue(incomplete.hasStructuredCard)
    }

    func testSessionShareCardParsesAsTaskShareNotUnsupportedResource() throws {
        let msg = decode("""
        {
          "id": 14, "seq": 14, "conversation_id": "c1", "sender_id": "u1",
          "sender_type": "user", "sender_name": "我", "content": "[任务共享] 新任务",
          "message_type": 1,
          "metadata": {"card": {
            "type": "session_share",
            "share_id": "share-1",
            "session_id": "session-1",
            "session_title": "新任务",
            "owner_user_id": "u1",
            "grantee_user_id": "u2",
            "can_fork": true,
            "can_chat": true,
            "status": "active"
          }}
        }
        """)

        let card = try XCTUnwrap(msg.sessionShareCard)
        XCTAssertEqual(card.shareId, "share-1")
        XCTAssertEqual(card.sessionId, "session-1")
        XCTAssertEqual(card.displayTitle, "新任务")
        XCTAssertEqual(card.normalizedStatus, "active")
        XCTAssertTrue(card.canFork)
        XCTAssertTrue(card.canChat)
        XCTAssertNil(msg.resourceCard)
        XCTAssertTrue(msg.isForwardRestrictedCard)
    }

    func testAttachmentURLDecodesEnvelopeFields() {
        let att = try! JSONDecoder().decode(IMAttachmentURL.self, from: Data("""
        {"download_url": "https://oss.example.com/x.png", "file_name": "x.png", "expires_in": 3600}
        """.utf8))
        XCTAssertEqual(att.downloadURL, "https://oss.example.com/x.png")
        XCTAssertEqual(att.expiresIn, 3600)
    }

    func testReferenceAttachmentUsesBackendMessageIdForDownload() {
        let msg = decode("""
        {
          "id": 44, "seq": 44, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 4, "has_attachment": true,
          "metadata": {
            "kind": "tabtin_ref", "tabtin_message_id": "912",
            "file_id": "f-1", "file_name": "pic.png", "file_type": "image/png"
          }
        }
        """)

        XCTAssertEqual(msg.attachmentLookupMessageId, 912)
    }

    func testRestAttachmentKeepsMessageIdForDownload() {
        let msg = decode("""
        {
          "id": 45, "seq": 45, "conversation_id": "c1", "sender_id": "u2",
          "message_type": 3, "has_attachment": true,
          "metadata": {"file_id": "f-2", "file_name": "report.pdf"}
        }
        """)

        XCTAssertEqual(msg.attachmentLookupMessageId, 45)
    }

    // MARK: - 解码容错（#1：单条坏 metadata 不得拖垮整条/整页）

    func testMalformedCardDegradesToTextNotDecodeFailure() {
        // card 被下发成字符串（非对象）：不应抛错，退化为无卡片的普通文本消息。
        let msg = decode("""
        {
          "id": 20, "seq": 20, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "hi",
          "message_type": 1, "metadata": {"card": "不是对象"}
        }
        """)
        XCTAssertNil(msg.resourceCard)
        XCTAssertEqual(msg.content, "hi")
    }

    func testMalformedNestedCardFieldKeepsSupportedCardShell() {
        // card 是对象但内部 preview_table 类型异常：坏字段退 nil，已支持卡片仍要保留。
        let msg = decode("""
        {
          "id": 21, "seq": 21, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "看表",
          "message_type": 1, "metadata": {"card": {"type": "table", "name": "表", "preview_table": "坏"}}
        }
        """)
        XCTAssertEqual(msg.resourceCard?.typedType, .table)
        XCTAssertEqual(msg.resourceCard?.displayName, "表")
        XCTAssertNil(msg.resourceCard?.previewTable)
        XCTAssertEqual(msg.content, "看表")
    }

    func testMetadataNotObjectDegradesToNil() {
        // 整个 metadata 被下发成非对象（字符串）：metadata 退 nil，消息仍可解码。
        let msg = decode("""
        {
          "id": 22, "seq": 22, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "文本",
          "message_type": 1, "metadata": "oops"
        }
        """)
        XCTAssertNil(msg.metadata)
        XCTAssertNil(msg.resourceCard)
        XCTAssertNil(msg.attachmentFileId)
        XCTAssertEqual(msg.content, "文本")
    }

    func testMalformedFileSizeDegradesFieldOnly() {
        // file_size 下发成字符串：仅该字段退 nil，file_id/附件判定不受影响。
        let msg = decode("""
        {
          "id": 23, "seq": 23, "conversation_id": "c1", "sender_id": "u2",
          "sender_type": "user", "sender_name": "张三", "content": "",
          "message_type": 4, "has_attachment": true,
          "metadata": {"file_id": "f-9", "file_name": "p.png", "file_size": "big", "file_type": "image/png"}
        }
        """)
        XCTAssertTrue(msg.isImageAttachment)
        XCTAssertEqual(msg.attachmentFileId, "f-9")
        XCTAssertNil(msg.attachmentFileSize)
    }

    func testBadMessageDoesNotFailWholePageDecode() {
        // 关键回归：一页历史里某条 metadata 异常，不得让整个 [IMMessage] 解码失败。
        let page = """
        [
          {"id": 1, "seq": 1, "conversation_id": "c1", "sender_id": "u2",
           "sender_type": "user", "sender_name": "张三", "content": "正常一",
           "message_type": 1, "metadata": {}},
          {"id": 2, "seq": 2, "conversation_id": "c1", "sender_id": "u2",
           "sender_type": "user", "sender_name": "张三", "content": "坏卡",
           "message_type": 1, "metadata": {"card": {"type": "table", "preview_table": 123}}},
          {"id": 3, "seq": 3, "conversation_id": "c1", "sender_id": "u2",
           "sender_type": "user", "sender_name": "张三", "content": "正常二",
           "message_type": 1, "metadata": "oops"}
        ]
        """
        let msgs = try! JSONDecoder().decode([IMMessage].self, from: Data(page.utf8))
        XCTAssertEqual(msgs.count, 3)
        XCTAssertEqual(msgs.map(\.content), ["正常一", "坏卡", "正常二"])
        XCTAssertEqual(msgs[1].resourceCard?.typedType, .table)
        XCTAssertNil(msgs[1].resourceCard?.previewTable)
        XCTAssertNil(msgs[2].metadata)
    }

    // MARK: - 相册图片格式识别（ 回归）

    /// PNG 魔数 → image/png / png（上传前 prepareImageData 仍输出 PNG，扩展名/MIME 一致）。
    func testDetectImageFormatPNG() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D])
        let format = ChatAttachmentUploadConfig.detectImageFormat(from: png)
        XCTAssertEqual(format.mimeType, "image/png")
        XCTAssertEqual(format.fileExtension, "png")
    }

    /// HEIC（ftyp…heic）不应被识别为 PNG/GIF，落到 JPEG 分支（prepareImageData 会转码为 JPEG）。
    func testDetectImageFormatHEICFallsToJPEG() {
        // 偏移 4 起 "ftypheic"；前 4 字节为 box size。
        let heic = Data([0x00, 0x00, 0x00, 0x18] + Array("ftypheic".utf8))
        let format = ChatAttachmentUploadConfig.detectImageFormat(from: heic)
        XCTAssertEqual(format.mimeType, "image/jpeg", "HEIC 无法直传，应按 JPEG 处理（后续转码）")
        XCTAssertEqual(format.fileExtension, "jpg")
    }

    /// GIF 魔数 → image/gif / gif（跳过压缩、保留动画，扩展名/MIME 一致）。
    func testDetectImageFormatGIF() {
        let gif = Data(Array("GIF89a".utf8) + [0x01, 0x00, 0x01, 0x00])
        let format = ChatAttachmentUploadConfig.detectImageFormat(from: gif)
        XCTAssertEqual(format.mimeType, "image/gif")
        XCTAssertEqual(format.fileExtension, "gif")
    }

    /// JPEG 魔数（FF D8 FF）→ image/jpeg / jpg。
    func testDetectImageFormatJPEG() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10] + Array("JFIF".utf8))
        let format = ChatAttachmentUploadConfig.detectImageFormat(from: jpeg)
        XCTAssertEqual(format.mimeType, "image/jpeg")
        XCTAssertEqual(format.fileExtension, "jpg")
    }

    // MARK: - importPhoto → addPhoto 端到端归一化（ 回归）
    //
    // 复现「相册返回原始字节、importPhoto 无条件命名 .jpg」的场景：即使传入 .jpg 文件名，
    // addPhoto 也必须按字节魔数把扩展名/MIME 归一化到与上传/转码产物一致，
    // 避免选 PNG/HEIC 时扩展名/MIME 与字节内容不符（服务端/接收端按 JPEG 解析失败）。

    /// 选 PNG（即便调用方传 .jpg 文件名）：扩展名/MIME 应归一化为 png（转码仍输出 PNG，保留透明）。
    @MainActor
    func testAddPhotoNormalizesPngExtensionAndMimeEvenWhenNamedJpg() {
        let manager = ChatAttachmentManager()
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + Array(repeating: 0, count: 32))
        let error = manager.addPhoto(
            data: png,
            filename: "image_1.jpg",
            scope: attachmentUploadScope
        )
        XCTAssertNil(error)
        let attachment = manager.attachments.first
        XCTAssertEqual(attachment?.mimeType, "image/png", "PNG 应保留 image/png，不被伪装成 jpeg")
        XCTAssertEqual((attachment?.name as NSString?)?.pathExtension, "png", "文件名扩展应改为 png")
        manager.clear(contextId: "conv-1", deactivateUploaded: false)
    }

    /// 选 HEIC（调用方传 .heic 文件名）：因无法直传，扩展名/MIME 归一化为 jpg/image-jpeg（上传前转码 JPEG）。
    @MainActor
    func testAddPhotoNormalizesHeicToJpegForConsistentUpload() {
        let manager = ChatAttachmentManager()
        let heic = Data([0x00, 0x00, 0x00, 0x18] + Array("ftypheic".utf8) + Array(repeating: 0, count: 16))
        let error = manager.addPhoto(
            data: heic,
            filename: "image_1.heic",
            scope: attachmentUploadScope
        )
        XCTAssertNil(error)
        let attachment = manager.attachments.first
        XCTAssertEqual(attachment?.mimeType, "image/jpeg", "HEIC 转码为 JPEG，MIME 应与最终字节一致")
        XCTAssertEqual((attachment?.name as NSString?)?.pathExtension, "jpg", "文件名扩展应改为 jpg")
        manager.clear(contextId: "conv-1", deactivateUploaded: false)
    }

    private var attachmentUploadScope: UploadScope {
        UploadScope(
            module: "chat",
            contextType: "message",
            contextId: "conv-1",
            organizationId: "org-1",
            isPublic: false
        )
    }
}
