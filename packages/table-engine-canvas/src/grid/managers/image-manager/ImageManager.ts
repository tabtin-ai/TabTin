import { throttle } from 'lodash';
import type { ICellItem, IRectangle } from '../../interface';

interface ILoadResult {
  img: HTMLImageElement | undefined;
  cancel: () => void;
  url: string;
  cells: number[];
  /** 图片是否正在加载中（img.src 已设置但 onload 未触发） */
  loading: boolean;
}

export interface IGlobalImageManager {
  setWindow(newWindow: IRectangle, freezeCols: number): void;
  loadOrGetImage(
    url: string,
    col: number,
    row: number,
    options?: IImageLoadOptions
  ): HTMLImageElement | ImageBitmap | undefined;
  setCallback(imageLoaded: (locations: ICellItem[]) => void): void;
}

export interface IImageLoadOptions {
  cacheKey?: string;
  resolveUrl?: () => Promise<string>;
}

const imgPool: HTMLImageElement[] = [];

const rowShift = 1 << 16;

function packColRowToNumber(col: number, row: number) {
  return row * rowShift + col;
}

function unpackCol(packed: number): number {
  return packed % rowShift;
}

function unpackRow(packed: number, col: number): number {
  return (packed - col) / rowShift;
}

function unpackNumberToColRow(packed: number): [number, number] {
  const col = unpackCol(packed);
  const row = unpackRow(packed, col);
  return [col, row];
}

const DEFAULT_MAX_CACHE_SIZE = 200;

export class ImageManager implements IGlobalImageManager {
  private imageLoaded: (locations: ICellItem[]) => void = () => undefined;
  private loadedLocations: [number, number][] = [];
  private maxCacheSize: number;
  private lruOrder: string[] = [];

  private visibleWindow: IRectangle = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };

  private freezeColumnCount = 0;

  private isInWindow = (packed: number) => {
    const col = unpackCol(packed);
    const row = unpackRow(packed, col);
    const w = this.visibleWindow;
    // width/height 非正时窗口无效，所有单元格视为窗外
    if (w.width <= 0 || w.height <= 0) return false;
    const rowInRange = row >= w.y && row <= w.y + w.height;
    if (!rowInRange) return false;
    // 冻结列：列索引合法且在冻结范围内
    if (col >= 0 && col < this.freezeColumnCount) return true;
    return col >= w.x && col <= w.x + w.width;
  };

  private cache: Record<string, ILoadResult> = {};

  constructor(maxCacheSize = DEFAULT_MAX_CACHE_SIZE) {
    this.maxCacheSize = maxCacheSize;
  }

  private touchLru(key: string) {
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
    this.lruOrder.push(key);
  }

  private evictLru() {
    let skipped = 0;
    // 限制最大扫描轮数，避免全部 loading 时 O(n) 空扫
    const maxSkip = Math.min(this.lruOrder.length, this.maxCacheSize);
    while (this.lruOrder.length - skipped > this.maxCacheSize && skipped < maxSkip) {
      const oldestKey = this.lruOrder[skipped];
      if (oldestKey == null) break;
      const entry = this.cache[oldestKey];
      if (entry && entry.loading) {
        // 正在加载中的 entry 延迟淘汰，避免中止进行中的网络请求
        skipped++;
        continue;
      }
      this.lruOrder.splice(skipped, 1);
      if (entry) {
        entry.cancel();
        delete this.cache[oldestKey];
      }
    }
  }

  public setCallback(imageLoaded: (locations: ICellItem[]) => void) {
    this.imageLoaded = imageLoaded;
  }

  private sendLoaded = throttle(() => {
    this.imageLoaded(this.loadedLocations);
    this.loadedLocations = [];
  }, 20);

  private clearOutOfWindow = () => {
    const keys = Object.keys(this.cache);
    for (const key of keys) {
      const obj = this.cache[key];

      let keep = false;
      for (let j = 0; j < obj.cells.length; j++) {
        const packed = obj.cells[j];
        if (this.isInWindow(packed)) {
          keep = true;
          break;
        }
      }

      if (keep) {
        obj.cells = obj.cells.filter(this.isInWindow);
      } else if (obj.loading) {
        // 正在加载中的 entry 不立即清除，等加载完成后再决定
        // 仅清理 cells 列表，加载完成回调中会检查 cells 是否为空
        obj.cells = [];
      } else {
        obj.cancel();
        delete this.cache[key];
        const lruIdx = this.lruOrder.indexOf(key);
        if (lruIdx !== -1) this.lruOrder.splice(lruIdx, 1);
      }
    }
  };

  public setWindow(newWindow: IRectangle, freezeColumnCount: number): void {
    if (
      this.visibleWindow.x === newWindow.x &&
      this.visibleWindow.y === newWindow.y &&
      this.visibleWindow.width === newWindow.width &&
      this.visibleWindow.height === newWindow.height &&
      this.freezeColumnCount === freezeColumnCount
    )
      return;
    this.visibleWindow = newWindow;
    this.freezeColumnCount = freezeColumnCount;
    this.clearOutOfWindow();
  }

  private loadImage(
    url: string,
    col: number,
    row: number,
    key: string,
    resolveUrl?: () => Promise<string>
  ) {
    let loaded = false;
    const img = imgPool.pop() ?? new Image();

    let canceled = false;
    const result: ILoadResult = {
      img: undefined,
      cells: [packColRowToNumber(col, row)],
      url,
      loading: true,
      cancel: () => {
        if (canceled) return;
        canceled = true;
        result.loading = false;
        if (imgPool.length < 12) {
          imgPool.unshift(img); // never retain more than 12
        } else if (!loaded) {
          img.src = '';
        }
      },
    };

    const loadPromise = new Promise((r) => img.addEventListener('load', () => r(null)));
    // use request animation time to avoid paying src set costs during draw calls
    requestAnimationFrame(async () => {
      try {
        const resolvedUrl = resolveUrl ? await resolveUrl() : url;
        if (canceled) return;
        if (!resolvedUrl) throw new Error('Image URL resolver returned an empty URL');
        img.src = resolvedUrl;
        await loadPromise;
        await img.decode();
        result.loading = false;
        const toWrite = this.cache[key];
        if (toWrite !== undefined && !canceled) {
          if (toWrite.cells.length === 0) {
            // entry 在加载期间被 clearOutOfWindow 标记为无关，清理掉
            toWrite.cancel();
            delete this.cache[key];
            const lruIdx = this.lruOrder.indexOf(key);
            if (lruIdx !== -1) this.lruOrder.splice(lruIdx, 1);
            return;
          }
          toWrite.img = img;
          for (const packed of toWrite.cells) {
            this.loadedLocations.push(unpackNumberToColRow(packed));
          }
          loaded = true;
          this.sendLoaded();
        }
      } catch {
        result.loading = false;
        result.cancel();
        delete this.cache[key];
        const lruIdx = this.lruOrder.indexOf(key);
        if (lruIdx !== -1) this.lruOrder.splice(lruIdx, 1);
      }
    });
    this.cache[key] = result;
    this.touchLru(key);
    this.evictLru();
  }

  public loadOrGetImage(
    url: string,
    col: number,
    row: number,
    options: IImageLoadOptions = {}
  ): HTMLImageElement | ImageBitmap | undefined {
    const key = options.cacheKey ?? url;

    const current = this.cache[key];
    if (current !== undefined) {
      const packed = packColRowToNumber(col, row);
      if (!current.cells.includes(packed)) {
        current.cells.push(packed);
      }
      this.touchLru(key);
      return current.img;
    } else {
      this.loadImage(url, col, row, key, options.resolveUrl);
    }
    return undefined;
  }
}
