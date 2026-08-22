/**
 * Image cache — fetch, decode, and cache images for rendering & export.
 *
 * Backend-agnostic: stores raw ArrayBuffer data. Skia-specific decoding
 * (MakeImageFromEncoded) remains in the renderer's shape-dispatch module.
 *
 * This module is shared by:
 *   - rendering/skia/renderers/shape-dispatch (canvas preview)
 *   - export/resource-loader (SVG/PNG export with base64 embedding)
 *   - tabvideo-engine (video frame rendering)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedImage {
  data: ArrayBuffer;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ImageCacheOptions {
  maxEntries?: number;
  /** Maximum total cache size in bytes (default: 512 MB) */
  maxBytes?: number;
  fetchOptions?: RequestInit;
}

/** Doubly-linked list node for O(1) LRU operations. */
interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

/** In-flight fetch entry with ref-counted abort tracking. */
interface PendingFetch {
  promise: Promise<CachedImage | null>;
  abortController: AbortController;
  /** Callers without abort signal — these can never trigger cancellation. */
  permanentCallers: number;
  /** Callers with abort signal who haven't aborted yet. */
  activeAbortable: number;
}

// ---------------------------------------------------------------------------
// Image Cache
// ---------------------------------------------------------------------------

export class ImageCache {
  private _cache = new Map<string, CachedImage>();
  private _pending = new Map<string, PendingFetch>();
  private _lruMap = new Map<string, LRUNode>();
  private _lruHead: LRUNode | null = null; // oldest
  private _lruTail: LRUNode | null = null; // newest
  private _maxEntries: number;
  private _maxBytes: number;
  private _currentBytes = 0;
  private _fetchOptions: RequestInit;

  constructor(options: ImageCacheOptions = {}) {
    this._maxEntries = options.maxEntries ?? 256;
    this._maxBytes = options.maxBytes ?? 512 * 1024 * 1024; // 512 MB
    this._fetchOptions = options.fetchOptions ?? { mode: 'cors' };
  }

  has(key: string): boolean {
    return this._cache.has(key);
  }

  get(key: string): CachedImage | undefined {
    const entry = this._cache.get(key);
    if (entry) {
      this._touchAccess(key);
    }
    return entry;
  }

  set(key: string, image: CachedImage): void {
    const existing = this._cache.get(key);
    if (existing) {
      this._currentBytes -= existing.data.byteLength;
    }
    this._cache.set(key, image);
    this._currentBytes += image.data.byteLength;
    this._touchAccess(key);
    this._evictIfNeeded();
  }

  /**
   * Fetch and cache an image by URL. Returns cached data if available,
   * or fetches and stores it. Deduplicates in-flight requests.
   *
   * When a signal is provided and an in-flight request for the same key
   * already exists, the new signal is linked: if ALL callers abort, the
   * underlying fetch is aborted too.
   */
  async fetch(url: string, key?: string, signal?: AbortSignal): Promise<CachedImage | null> {
    const cacheKey = key ?? url;

    const cached = this._cache.get(cacheKey);
    if (cached) {
      this._touchAccess(cacheKey);
      return cached;
    }

    const existing = this._pending.get(cacheKey);
    if (existing) {
      if (signal) {
        if (signal.aborted) {
          existing.activeAbortable++;
          existing.activeAbortable--;
          this._maybeAbortPending(existing);
        } else {
          existing.activeAbortable++;
          signal.addEventListener('abort', () => {
            existing.activeAbortable--;
            this._maybeAbortPending(existing);
          }, { once: true });
        }
      } else {
        existing.permanentCallers++;
      }
      return existing.promise;
    }

    const ac = new AbortController();
    const entry: PendingFetch = {
      promise: null!,
      abortController: ac,
      permanentCallers: signal ? 0 : 1,
      activeAbortable: signal ? 1 : 0,
    };

    if (signal) {
      if (signal.aborted) {
        entry.activeAbortable--;
        this._maybeAbortPending(entry);
      } else {
        signal.addEventListener('abort', () => {
          entry.activeAbortable--;
          this._maybeAbortPending(entry);
        }, { once: true });
      }
    }

    entry.promise = this._doFetch(url, cacheKey, ac.signal);
    this._pending.set(cacheKey, entry);

    try {
      return await entry.promise;
    } finally {
      this._pending.delete(cacheKey);
    }
  }

  /**
   * Fetch multiple images in parallel. Returns a map of key → CachedImage.
   * The AbortSignal is transparently forwarded to each underlying HTTP request.
   */
  async fetchBatch(
    entries: Array<{ url: string; key?: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, CachedImage>> {
    const results = new Map<string, CachedImage>();

    await Promise.allSettled(
      entries.map(async ({ url, key }) => {
        if (signal?.aborted) return;
        const cacheKey = key ?? url;
        const image = await this.fetch(url, cacheKey, signal);
        if (image) results.set(cacheKey, image);
      }),
    );

    return results;
  }

  /** Convert a cached image to a base64 data URI. */
  toDataUri(key: string): string | null {
    const entry = this._cache.get(key);
    if (!entry) return null;

    const bytes = new Uint8Array(entry.data);
    if (typeof Buffer !== 'undefined') {
      return `data:${entry.mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    const CHUNK_SIZE = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE) as unknown as number[]));
    }
    return `data:${entry.mimeType};base64,${btoa(chunks.join(''))}`;
  }

  get size(): number {
    return this._cache.size;
  }

  get currentBytes(): number {
    return this._currentBytes;
  }

  clear(): void {
    this._cache.clear();
    this._pending.clear();
    this._lruMap.clear();
    this._lruHead = null;
    this._lruTail = null;
    this._currentBytes = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _maybeAbortPending(entry: PendingFetch): void {
    if (entry.permanentCallers === 0 && entry.activeAbortable <= 0) {
      entry.abortController.abort();
    }
  }

  private async _doFetch(url: string, cacheKey: string, signal?: AbortSignal): Promise<CachedImage | null> {
    try {
      const fetchInit: RequestInit = signal
        ? { ...this._fetchOptions, signal }
        : this._fetchOptions;
      const resp = await fetch(url, fetchInit);
      if (!resp.ok) return null;

      const data = await resp.arrayBuffer();
      const mimeType = resp.headers.get('content-type') ?? guessMimeType(url);

      const image: CachedImage = { data, mimeType };
      this.set(cacheKey, image);
      return image;
    } catch {
      return null;
    }
  }

  /** O(1) LRU touch via doubly-linked list + Map. */
  private _touchAccess(key: string): void {
    const existing = this._lruMap.get(key);
    if (existing) {
      this._removeNode(existing);
    }
    const node: LRUNode = { key, prev: null, next: null };
    this._appendNode(node);
    this._lruMap.set(key, node);
  }

  private _removeNode(node: LRUNode): void {
    if (node.prev) node.prev.next = node.next;
    else this._lruHead = node.next;
    if (node.next) node.next.prev = node.prev;
    else this._lruTail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private _appendNode(node: LRUNode): void {
    if (!this._lruTail) {
      this._lruHead = this._lruTail = node;
    } else {
      node.prev = this._lruTail;
      this._lruTail.next = node;
      this._lruTail = node;
    }
  }

  private _evictIfNeeded(): void {
    while (
      (this._cache.size > this._maxEntries || this._currentBytes > this._maxBytes) &&
      this._lruHead
    ) {
      const oldest = this._lruHead;
      this._removeNode(oldest);
      this._lruMap.delete(oldest.key);
      const entry = this._cache.get(oldest.key);
      if (entry) {
        this._currentBytes -= entry.data.byteLength;
        this._cache.delete(oldest.key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const imageCache = new ImageCache();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function guessMimeType(url: string): string {
  const cleaned = url.split('?')[0].split('#')[0];
  const ext = cleaned.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}
