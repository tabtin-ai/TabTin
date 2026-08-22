import Foundation

struct NativeTabDocEditorSnapshot: Equatable {
    var title: String
    var body: NativeTabDocBody
    var focusedBlockId: UUID?
}

enum NativeTabDocUndoPolicy {
    static let textDebounceMilliseconds = 500
    static let maxHistory = 50

    static func canMutateHistory(
        canEdit: Bool,
        saveState: NativeTabDocSaveState
    ) -> Bool {
        canEdit && saveState != .conflict && saveState != .permissionDenied
    }

    static func captureTextPending(
        current: NativeTabDocEditorSnapshot,
        pending: NativeTabDocEditorSnapshot?
    ) -> NativeTabDocEditorSnapshot {
        pending ?? current
    }

    static func push(
        _ snapshot: NativeTabDocEditorSnapshot,
        undo: inout [NativeTabDocEditorSnapshot],
        redo: inout [NativeTabDocEditorSnapshot]
    ) {
        undo.append(snapshot)
        if undo.count > maxHistory {
            undo.removeFirst()
        }
        redo.removeAll()
    }
}
