import Foundation

enum NativeTabDocCommentWritePolicy {
    static func canCreate(
        saveState: NativeTabDocSaveState,
        isReadOnly: Bool,
        requiresFullEditor: Bool
    ) -> Bool {
        saveState != .conflict && !isReadOnly && !requiresFullEditor
    }

    static func proseMirrorBlockType(for kind: NativeTabDocBlockKind) -> String? {
        switch kind {
        case .paragraph:
            return "paragraph"
        case .heading:
            return "heading"
        case .bulletList, .orderedList, .taskList:
            return "listItem"
        case .codeBlock:
            return "codeBlock"
        case .blockquote:
            return "blockquote"
        case .divider:
            return "horizontalRule"
        case .image:
            return "image"
        case .table:
            return "table"
        case .unsupported:
            return nil
        }
    }

    static func createRequestBody(
        text: String,
        scope: String,
        blockIds: [String] = [],
        blockType: String? = nil,
        selectedText: String? = nil
    ) -> [String: Any] {
        var anchor: [String: Any] = [
            "version": 1,
            "block_ids": blockIds,
        ]
        if let blockType, !blockType.isEmpty {
            anchor["block_type"] = blockType
        }
        if let selectedText, !selectedText.isEmpty {
            anchor["selected_text"] = selectedText
        }
        var body: [String: Any] = [
            "body": text,
            "scope": scope,
            "anchor": anchor,
        ]
        if let selectedText, !selectedText.isEmpty {
            body["selected_text"] = selectedText
        }
        return body
    }
}
