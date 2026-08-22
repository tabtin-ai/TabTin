import SwiftUI
import UIKit

enum IdentityAvatarImagePresentation: Equatable {
    case image
    case loading
    case fallback

    static func mode(
        hasRemoteImage: Bool,
        hasCachedImage: Bool,
        didFail: Bool
    ) -> Self {
        guard hasRemoteImage else { return .fallback }
        if hasCachedImage { return .image }
        return didFail ? .fallback : .loading
    }
}

/// 对齐 Electron `ColorAvatar`：真实头像优先；否则按 seed 生成平台统一彩色首字头像。
struct IdentityColorAvatar: View {
    let name: String
    var seed: String? = nil
    var imageUrl: String? = nil
    var size: CGFloat = 40
    var group: Bool = false
    var channel: Bool = false

    @State private var loadedImage: UIImage?
    @State private var loadedImageURL: URL?
    @State private var imageFailed: Bool

    init(
        name: String,
        seed: String? = nil,
        imageUrl: String? = nil,
        size: CGFloat = 40,
        group: Bool = false,
        channel: Bool = false
    ) {
        self.name = name
        self.seed = seed
        self.imageUrl = imageUrl
        self.size = size
        self.group = group
        self.channel = channel
        let normalizedImageUrl = imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = normalizedImageUrl.flatMap { $0.isEmpty ? nil : URL(string: $0) }
        let cached = AvatarImageMemoryCache.shared.cachedImage(for: url)
        _loadedImage = State(initialValue: cached)
        _loadedImageURL = State(initialValue: cached == nil ? nil : url)
        _imageFailed = State(initialValue: false)
    }

    private var identity: String {
        if let seed, !seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return seed
        }
        return name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "?" : name
    }

    private var remoteURL: URL? {
        guard let trimmed = imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return URL(string: trimmed)
    }

    private var displayedImage: UIImage? {
        guard let remoteURL else { return nil }
        if loadedImageURL == remoteURL, let loadedImage { return loadedImage }
        return AvatarImageMemoryCache.shared.cachedImage(for: remoteURL)
    }

    private var presentation: IdentityAvatarImagePresentation {
        IdentityAvatarImagePresentation.mode(
            hasRemoteImage: remoteURL != nil,
            hasCachedImage: displayedImage != nil,
            didFail: imageFailed
        )
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(IdentityAvatar.color(identity))
            if presentation == .image, let displayedImage {
                Image(uiImage: displayedImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else if presentation == .fallback {
                fallbackContent
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: remoteURL) {
            guard let remoteURL else {
                loadedImage = nil
                loadedImageURL = nil
                imageFailed = false
                return
            }
            if let cached = AvatarImageMemoryCache.shared.cachedImage(for: remoteURL) {
                loadedImage = cached
                loadedImageURL = remoteURL
                imageFailed = false
                return
            }
            loadedImage = nil
            loadedImageURL = nil
            imageFailed = false
            if let image = await AvatarImageMemoryCache.shared.image(for: remoteURL) {
                guard !Task.isCancelled else { return }
                loadedImage = image
                loadedImageURL = remoteURL
            } else if !Task.isCancelled {
                imageFailed = true
            }
        }
    }

    @ViewBuilder
    private var fallbackContent: some View {
        if channel {
            Image(systemName: "number")
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundStyle(.white)
        } else if group {
            Image(systemName: "person.2.fill")
                .font(.system(size: size * 0.34, weight: .semibold))
                .foregroundStyle(.white)
        } else {
            Text(IdentityAvatar.initial(name))
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundStyle(.white)
        }
    }
}
