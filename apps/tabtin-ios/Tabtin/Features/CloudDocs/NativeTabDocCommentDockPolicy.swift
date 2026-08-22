import Foundation

/// 文档很短时，评论区沉到当前可见区下沿，空白留在正文和评论之间。
/// 正文已经超过一屏时不再垫高，评论仍跟在文末后面。
enum NativeTabDocCommentDockPolicy {
    static func extraTop(
        viewportHeight: CGFloat,
        precedingHeight: CGFloat,
        footerContentHeight: CGFloat
    ) -> CGFloat {
        guard viewportHeight > 0, footerContentHeight >= 0 else { return 0 }
        return max(0, viewportHeight - precedingHeight - footerContentHeight)
    }
}
