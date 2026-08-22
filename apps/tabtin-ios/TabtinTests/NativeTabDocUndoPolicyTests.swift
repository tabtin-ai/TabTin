import XCTest
@testable import Tabtin

final class NativeTabDocUndoPolicyTests: XCTestCase {
    func testDebounceAndCapMatchAndroid() {
        XCTAssertEqual(NativeTabDocUndoPolicy.textDebounceMilliseconds, 500)
        XCTAssertEqual(NativeTabDocUndoPolicy.maxHistory, 50)
    }

    func testTextEditsShareOnePendingSnapshot() {
        let first = NativeTabDocEditorSnapshot(
            title: "A",
            body: NativeTabDocBody(rootAttributes: [:], blocks: []),
            focusedBlockId: nil
        )
        var pending: NativeTabDocEditorSnapshot? = nil
        pending = NativeTabDocUndoPolicy.captureTextPending(current: first, pending: pending)
        let second = NativeTabDocEditorSnapshot(
            title: "AB",
            body: NativeTabDocBody(rootAttributes: [:], blocks: []),
            focusedBlockId: nil
        )
        pending = NativeTabDocUndoPolicy.captureTextPending(current: second, pending: pending)
        XCTAssertEqual(pending, first)
    }

    func testPushClearsRedoAndDropsOldest() {
        var undo: [NativeTabDocEditorSnapshot] = []
        var redo: [NativeTabDocEditorSnapshot] = [
            NativeTabDocEditorSnapshot(
                title: "redo",
                body: NativeTabDocBody(rootAttributes: [:], blocks: []),
                focusedBlockId: nil
            )
        ]
        for index in 0..<51 {
            NativeTabDocUndoPolicy.push(
                NativeTabDocEditorSnapshot(
                    title: "\(index)",
                    body: NativeTabDocBody(rootAttributes: [:], blocks: []),
                    focusedBlockId: nil
                ),
                undo: &undo,
                redo: &redo
            )
        }
        XCTAssertEqual(undo.count, 50)
        XCTAssertEqual(undo.first?.title, "1")
        XCTAssertTrue(redo.isEmpty)
    }

    func testConflictAndReadOnlyRefuseUndo() {
        XCTAssertFalse(NativeTabDocUndoPolicy.canMutateHistory(canEdit: false, saveState: .dirty))
        XCTAssertFalse(NativeTabDocUndoPolicy.canMutateHistory(canEdit: true, saveState: .conflict))
        XCTAssertFalse(NativeTabDocUndoPolicy.canMutateHistory(canEdit: true, saveState: .permissionDenied))
        XCTAssertTrue(NativeTabDocUndoPolicy.canMutateHistory(canEdit: true, saveState: .dirty))
    }
}
