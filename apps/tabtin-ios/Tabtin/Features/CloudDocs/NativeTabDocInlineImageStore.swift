import UIKit

/// 行内图片的解码缓存与在途请求合并。
///
/// 同一张图会在多次 `updateUIView`、块复用和滚动中被反复请求，缓存以 `fileId`
/// 为主键（签名地址会过期漂移）。失败结果同样记账，避免对着一张坏图无限重试。
@MainActor
final class NativeTabDocInlineImageStore {
    static let shared = NativeTabDocInlineImageStore()

    private let images = NSCache<NSString, UIImage>()
    private var failures: Set<String> = []
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init(countLimit: Int = 60, totalCostLimit: Int = 32 * 1024 * 1024) {
        images.countLimit = countLimit
        images.totalCostLimit = totalCostLimit
    }

    func cachedImage(
        for descriptor: NativeTabDocInlineImagePresentation.Descriptor
    ) -> UIImage? {
        guard let key = NativeTabDocInlineImagePresentation.cacheKey(for: descriptor) else {
            return nil
        }
        return images.object(forKey: key as NSString)
    }

    func hasFailed(
        for descriptor: NativeTabDocInlineImagePresentation.Descriptor
    ) -> Bool {
        guard let key = NativeTabDocInlineImagePresentation.cacheKey(for: descriptor) else {
            return true
        }
        return failures.contains(key)
    }

    /// 返回 nil 表示这张图当前加载不出来，调用方必须退回可读的 alt 占位。
    func image(
        for descriptor: NativeTabDocInlineImagePresentation.Descriptor,
        resolveURL: @escaping (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?
    ) async -> UIImage? {
        guard descriptor.canLoad,
              let key = NativeTabDocInlineImagePresentation.cacheKey(for: descriptor)
        else { return nil }
        if let cached = images.object(forKey: key as NSString) { return cached }
        if failures.contains(key) { return nil }
        if let running = inFlight[key] { return await running.value }

        let task = Task<UIImage?, Never> { [descriptor] in
            guard let url = await resolveURL(descriptor) else { return nil }
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse,
                   !(200..<300).contains(http.statusCode) {
                    return nil
                }
                return UIImage(data: data)
            } catch {
                return nil
            }
        }
        inFlight[key] = task
        let loaded = await task.value
        inFlight[key] = nil
        if let loaded {
            images.setObject(loaded, forKey: key as NSString, cost: decodedCost(of: loaded))
            failures.remove(key)
        } else {
            failures.insert(key)
        }
        return loaded
    }

    /// 直接放入已解码图片，跳过网络。用于本地上传后立即可见，以及测试注入。
    func prime(
        _ image: UIImage,
        for descriptor: NativeTabDocInlineImagePresentation.Descriptor
    ) {
        guard let key = NativeTabDocInlineImagePresentation.cacheKey(for: descriptor) else {
            return
        }
        images.setObject(image, forKey: key as NSString, cost: decodedCost(of: image))
        failures.remove(key)
    }

    /// 会话切换或用户重试时清账，让坏图有机会重新加载。
    func reset() {
        inFlight.values.forEach { $0.cancel() }
        inFlight.removeAll()
        failures.removeAll()
        images.removeAllObjects()
    }

    private func decodedCost(of image: UIImage) -> Int {
        let scale = image.scale
        return Int(image.size.width * scale * image.size.height * scale * 4)
    }
}
