import XCTest
@testable import Tabtin

final class CloudDrivePresentationTests: XCTestCase {
    func testTabTinResourceTypesUseBrandedKinds() {
        XCTAssertEqual(resolve(itemType: " TABDOC ", title: "draft.pdf"), .tabdoc)
        XCTAssertEqual(resolve(itemType: "TabData", title: "sheet.docx"), .tabdata)
        XCTAssertEqual(resolve(itemType: "document", title: "legacy.bin"), .tabdoc)
        XCTAssertEqual(resolve(itemType: "table", title: "legacy.bin"), .tabdata)
    }

    func testMIMEWinsOverConflictingExtension() {
        XCTAssertEqual(resolve(title: "scan.pdf", mime: " IMAGE/JPEG; charset=binary "), .image)
        XCTAssertEqual(resolve(title: "notes.txt", mime: "application/pdf"), .pdf)
        XCTAssertEqual(resolve(title: "deck.pptx", mime: "audio/mpeg"), .audio)
    }

    func testMIMEClassificationMatrix() {
        let cases: [(String, CloudDriveFileKind)] = [
            ("image/heic", .image),
            ("application/pdf", .pdf),
            ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", .word),
            ("application/vnd.oasis.opendocument.text", .word),
            ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", .spreadsheet),
            ("application/vnd.oasis.opendocument.spreadsheet", .spreadsheet),
            ("text/csv", .spreadsheet),
            ("application/vnd.openxmlformats-officedocument.presentationml.presentation", .presentation),
            ("application/vnd.oasis.opendocument.presentation", .presentation),
            ("application/json", .text),
            ("text/markdown", .text),
            ("audio/wav", .audio),
            ("video/mp4", .video),
            ("application/x-7z-compressed", .archive),
        ]

        for (mime, expected) in cases {
            XCTAssertEqual(resolve(title: "no-extension", mime: mime), expected, mime)
        }
    }

    func testExtensionClassificationMatrix() {
        let cases: [(String, CloudDriveFileKind)] = [
            ("photo.PNG", .image),
            ("photo.AVIF", .image),
            ("manual.PDF", .pdf),
            ("brief.DOCX", .word),
            ("brief.ODT", .word),
            ("ledger.XLS", .spreadsheet),
            ("export.csv", .spreadsheet),
            ("export.TSV", .spreadsheet),
            ("ledger.ODS", .spreadsheet),
            ("pitch.KEY", .presentation),
            ("pitch.ODP", .presentation),
            ("readme.MD", .text),
            ("payload.JSON", .text),
            ("events.JSONL", .text),
            ("settings.TOML", .text),
            ("settings.INI", .text),
            ("output.LOG", .text),
            ("theme.SCSS", .text),
            ("source.SWIFT", .text),
            ("recording.M4A", .audio),
            ("clip.MOV", .video),
            ("clip.MPEG", .video),
            ("clip.MPG", .video),
            ("bundle.ZIP", .archive),
            ("bundle.RAR", .archive),
            ("bundle.7Z", .archive),
            ("bundle.TAR", .archive),
            ("bundle.GZ", .archive),
            ("unknown.bin", .file),
        ]

        for (title, expected) in cases {
            XCTAssertEqual(resolve(itemType: "tabfiles", title: title), expected, title)
        }
    }

    func testExplicitExtensionHandlesDotsWhitespaceAndEmptyValues() {
        XCTAssertEqual(resolve(title: "no-extension", extension: " .PPTX "), .presentation)
        XCTAssertEqual(resolve(title: "fallback.PDF", mime: "", extension: "  "), .pdf)
        XCTAssertEqual(resolve(itemType: nil, title: nil, mime: nil, extension: nil), .file)
        XCTAssertEqual(resolve(itemType: " ", title: "", mime: " ", extension: "."), .file)
    }

    func testGenericMIMEDoesNotBlockExtensionFallback() {
        XCTAssertEqual(resolve(title: "archive.tar", mime: "application/octet-stream"), .archive)
        XCTAssertEqual(resolve(title: "picture.webp", mime: "binary/octet-stream"), .image)
    }

    func testSafePreviewTextKeepsContentAndRejectsDownloadURLs() {
        XCTAssertEqual(CloudDrivePresentationResolver.safePreviewText("  正常摘要内容  "), "正常摘要内容")
        XCTAssertNil(CloudDrivePresentationResolver.safePreviewText("HTTPS://example.com/signed?token=secret"))
        XCTAssertNil(CloudDrivePresentationResolver.safePreviewText("data:text/plain;base64,SGVsbG8="))
        XCTAssertNil(CloudDrivePresentationResolver.safePreviewText("blob:https://example.com/id"))
        XCTAssertNil(CloudDrivePresentationResolver.safePreviewText("//cdn.example.com/signed"))
        XCTAssertNil(CloudDrivePresentationResolver.safePreviewText("  "))
    }

    func testTabularPreviewContentKeepsVisibleFieldsAndSummary() {
        let content = TabularPreviewContent(
            fieldNames: [" 名称 ", "", "状态", "负责人", "忽略列"],
            previewText: "  Agent 刚更新了 3 条建议  "
        )

        XCTAssertEqual(content.fieldNames, ["名称", "状态", "负责人"])
        XCTAssertEqual(content.previewText, "Agent 刚更新了 3 条建议")
        XCTAssertTrue(content.hasContent)
    }

    func testTabularPreviewContentReportsEmptyInsteadOfDrawingAContentlessGrid() {
        let content = TabularPreviewContent(fieldNames: [" ", "\n"], previewText: "  ")

        XCTAssertTrue(content.fieldNames.isEmpty)
        XCTAssertNil(content.previewText)
        XCTAssertFalse(content.hasContent)
    }

    func testTabularPreviewContentPromotesPipeSeparatedSchemaSummaryToHeaders() {
        let content = TabularPreviewContent(
            previewText: "Bug 描述 | GitHub Issue 链接 | 操作录屏 /..."
        )

        XCTAssertEqual(content.fieldNames, ["Bug 描述", "GitHub Issue 链接", "操作录屏"])
        XCTAssertNil(content.previewText)
        XCTAssertTrue(content.hasContent)
    }

    func testResumeProjectorUsesNewestVisitedResourceAndSkipsInvalidOrHidden() {
        let older = resource(id: "older", lastVisitedAt: "2026-08-10T08:00:00Z")
        let newer = resource(id: "newer", lastVisitedAt: "2026-08-11T08:00:00.123Z")
        let invalid = resource(id: "invalid", lastVisitedAt: "not-a-date")
        var hidden = resource(id: "hidden", lastVisitedAt: "2026-08-12T08:00:00Z")
        hidden.canView = false

        XCTAssertEqual(
            CloudDriveResumeProjector.mostRecentlyVisited(in: [newer, invalid, older, hidden])?.id,
            "newer"
        )
        XCTAssertNil(CloudDriveResumeProjector.mostRecentlyVisited(in: [invalid, hidden]))
    }

    func testResumeHeroStaysVisibleInAllAndRecentRootContexts() {
        for scope in [CloudDriveScope.all, .recent] {
            XCTAssertTrue(
                CloudDriveHomeVisibilityPolicy.shouldShowResumeHero(
                    scope: scope,
                    isSearching: false,
                    isAtRoot: true
                ),
                scope.rawValue
            )
        }

        XCTAssertFalse(
            CloudDriveHomeVisibilityPolicy.shouldShowResumeHero(
                scope: .shared,
                isSearching: false,
                isAtRoot: true
            )
        )
        XCTAssertFalse(
            CloudDriveHomeVisibilityPolicy.shouldShowResumeHero(
                scope: .recent,
                isSearching: true,
                isAtRoot: true
            )
        )
        XCTAssertFalse(
            CloudDriveHomeVisibilityPolicy.shouldShowResumeHero(
                scope: .recent,
                isSearching: false,
                isAtRoot: false
            )
        )
    }

    func testQuickActionsStayVisibleInAllAndRecentContexts() {
        for scope in [CloudDriveScope.all, .recent] {
            XCTAssertTrue(
                CloudDriveHomeVisibilityPolicy.shouldShowQuickActions(
                    scope: scope,
                    isSearching: false
                ),
                scope.rawValue
            )
        }

        XCTAssertFalse(
            CloudDriveHomeVisibilityPolicy.shouldShowQuickActions(
                scope: .shared,
                isSearching: false
            )
        )
        XCTAssertFalse(
            CloudDriveHomeVisibilityPolicy.shouldShowQuickActions(
                scope: .recent,
                isSearching: true
            )
        )
    }

    func testWorkbenchTabFilesUseCloudDriveKinds() {
        let pdf = TaskWorkbenchOutput(
            id: "tabfiles:file-pdf",
            resourceType: "tabfiles",
            resourceId: "file-pdf",
            title: "周报.pdf",
            preview: nil,
            timestamp: Date(),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabfiles",
                resourceId: "file-pdf",
                title: "周报.pdf",
                locationHint: nil
            ),
            mimeType: "application/pdf"
        )
        let image = TaskWorkbenchOutput(
            id: "tabfiles:file-image",
            resourceType: "tabfiles",
            resourceId: "file-image",
            title: "封面.pdf",
            preview: nil,
            timestamp: Date(),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabfiles",
                resourceId: "file-image",
                title: "封面.pdf",
                locationHint: nil
            ),
            mimeType: "image/png"
        )
        let markdown = TaskWorkbenchOutput(
            id: "tabfiles:file-text",
            resourceType: "tabfiles",
            resourceId: "file-text",
            title: "notes.md",
            preview: nil,
            timestamp: Date(),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabfiles",
                resourceId: "file-text",
                title: "notes.md",
                locationHint: nil
            )
        )
        let doc = TaskWorkbenchOutput(
            id: "tabdoc:doc-1",
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "计划",
            preview: nil,
            timestamp: Date(),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabdoc",
                resourceId: "doc-1",
                title: "计划",
                locationHint: nil
            )
        )

        XCTAssertEqual(pdf.fileKind, .pdf)
        XCTAssertEqual(pdf.presentationTypeLabel, "PDF")
        XCTAssertEqual(image.fileKind, .image)
        XCTAssertEqual(image.presentationTypeLabel, "图片")
        XCTAssertEqual(markdown.fileKind, .text)
        XCTAssertEqual(markdown.presentationTypeLabel, "文本与代码")
        XCTAssertNil(doc.fileKind)
        XCTAssertEqual(doc.presentationTypeLabel, "TabDoc")

        let viewport = CloudDriveRowPresentation(output: image, organizationId: "org-1")
        XCTAssertEqual(viewport.kind, .image)
        XCTAssertEqual(viewport.fileRecordId, "file-image")
        XCTAssertEqual(viewport.contextItemId, "")
        XCTAssertEqual(viewport.organizationId, "org-1")
        XCTAssertEqual(viewport.accessContext.accessRoute, .fileRecord)
        XCTAssertEqual(
            CloudFileSignedPreviewPolicy.cacheKey(for: viewport.accessContext),
            "file:file-image"
        )
        XCTAssertEqual(
            CloudFileSignedPreviewPolicy.httpURL(from: "https://cdn.example/preview.png")?.absoluteString,
            "https://cdn.example/preview.png"
        )
        XCTAssertNil(CloudFileSignedPreviewPolicy.httpURL(from: "javascript:alert(1)"))
        XCTAssertTrue(CloudFileDetailPresentation.showsLiveImage(.image))
        XCTAssertFalse(CloudFileDetailPresentation.showsLiveImage(.pdf))
        XCTAssertEqual(
            CloudFileDetailPresentation.actions(
                canPreview: true,
                hasShareableLink: true,
                canManageCollaborators: true,
                canTrash: true
            ),
            [.preview, .openExternally, .download, .copyLink, .share, .collaborators, .trash]
        )
    }

    private func resolve(
        itemType: String? = "tabfiles",
        title: String? = nil,
        mime: String? = nil,
        extension fileExtension: String? = nil
    ) -> CloudDriveFileKind {
        CloudDrivePresentationResolver.kind(
            itemType: itemType,
            title: title,
            mimeType: mime,
            fileExtension: fileExtension
        )
    }

    private func resource(id: String, lastVisitedAt: String?) -> SpaceResource {
        var resource = SpaceResource(
            id: id,
            itemType: "tabdoc",
            title: id,
            preview: nil,
            resourceId: "resource-\(id)",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        resource.lastVisitedAt = lastVisitedAt
        return resource
    }
}
