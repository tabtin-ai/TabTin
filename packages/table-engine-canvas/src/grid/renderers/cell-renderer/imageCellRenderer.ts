import { LRUCache } from 'lru-cache';
import { GRID_DEFAULT } from '../../configs';
import type { IRectangle } from '../../interface';
import { GridInnerIcon } from '../../managers';
import { isPointInsideRectangle } from '../../utils';
import { drawRect, drawSingleLineText } from '../base-renderer';
import type {
  ICellClickCallback,
  ICellClickProps,
  ICellRenderProps,
  IImageCell,
  IImageData,
  IInternalCellRenderer,
} from './interface';
import { CellRegionType, CellType } from './interface';

const imagePositionCache: LRUCache<string, (IRectangle & { id: string })[]> = new LRUCache({
  max: 200,
});

const INNER_PADDING = 4;
const FILE_CARD_MIN_WIDTH = 96;
const FILE_CARD_MAX_WIDTH = 176;
const FILE_CARD_HORIZONTAL_PADDING = 10;
const FILE_BADGE_GAP = 8;
const FILE_BADGE_MIN_SIZE = 20;
const FILE_BADGE_MAX_SIZE = 28;
const FILE_EXTENSION_FALLBACK = 'FILE';
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)(\?.*)?$/i;

const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'text/csv': 'CSV',
  'text/plain': 'TXT',
  'application/json': 'JSON',
  'application/zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'audio/ogg': 'OGG',
  'audio/mp4': 'M4A',
  'video/mp4': 'MP4',
  'video/webm': 'WEBM',
  'video/quicktime': 'MOV',
};

const { cellHorizontalPadding, cellVerticalPaddingXS } = GRID_DEFAULT;

type IRenderableAsset = {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  renderAs: NonNullable<IImageData['renderAs']>;
  img?: HTMLImageElement | ImageBitmap;
  uploading?: boolean;
  uploadStatus?: IImageData['uploadStatus'];
  uploadProgress?: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getFileNameFromUrl = (url: string) => {
  if (!url) return '';
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  const segment = path.split('/').filter(Boolean).pop();
  if (!segment) return '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const resolveAssetName = (item: IImageData, index: number) => {
  const explicitName = item.name?.trim();
  if (explicitName) {
    return explicitName;
  }

  return getFileNameFromUrl(item.url) || `Attachment ${index + 1}`;
};

const isLikelyImageAsset = (item: Pick<IImageData, 'url' | 'name' | 'mimeType'>) => {
  if (item.mimeType?.toLowerCase().startsWith('image/')) {
    return true;
  }

  return IMAGE_FILE_PATTERN.test(item.name || item.url);
};

const resolveAssetRenderAs = (item: IImageData): NonNullable<IImageData['renderAs']> => {
  if (item.renderAs) {
    return item.renderAs;
  }

  return isLikelyImageAsset(item) ? 'image' : 'file';
};

const getFileExtension = (name: string, url: string, mimeType: string) => {
  const sourceName = name || getFileNameFromUrl(url);
  const dotIndex = sourceName.lastIndexOf('.');
  if (dotIndex >= 0 && dotIndex < sourceName.length - 1) {
    return sourceName.slice(dotIndex + 1).toUpperCase().slice(0, 5);
  }

  const normalizedMimeType = mimeType.toLowerCase();
  const mappedExtension = FILE_EXTENSION_BY_MIME[normalizedMimeType];
  if (mappedExtension) {
    return mappedExtension;
  }

  const subtype = normalizedMimeType.split('/')[1]?.split(';')[0]?.split('+')[0]?.trim();
  if (subtype) {
    return subtype.toUpperCase().slice(0, 5);
  }

  return FILE_EXTENSION_FALLBACK;
};

const getFileBadgeColors = (extension: string) => {
  const normalized = extension.toUpperCase();
  if (normalized === 'PDF') {
    return { bg: '#FEE2E2', fg: '#B91C1C' };
  }
  if (['DOC', 'DOCX'].includes(normalized)) {
    return { bg: '#DBEAFE', fg: '#1D4ED8' };
  }
  if (['XLS', 'XLSX', 'CSV'].includes(normalized)) {
    return { bg: '#DCFCE7', fg: '#15803D' };
  }
  if (['PPT', 'PPTX'].includes(normalized)) {
    return { bg: '#FFEDD5', fg: '#C2410C' };
  }
  if (['MP3', 'WAV', 'OGG', 'M4A'].includes(normalized)) {
    return { bg: '#E0F2FE', fg: '#0369A1' };
  }
  if (['MP4', 'MOV', 'WEBM'].includes(normalized)) {
    return { bg: '#EDE9FE', fg: '#5B21B6' };
  }

  return { bg: '#E2E8F0', fg: '#334155' };
};

const isUploadingAsset = (item: Pick<IRenderableAsset, 'uploading' | 'uploadStatus'>) =>
  item.uploading || item.uploadStatus === 'pending' || item.uploadStatus === 'uploading';

const getAssetCollection = (
  data: IImageData[],
  loadImg: (item: IImageData) => HTMLImageElement | ImageBitmap | undefined
) => {
  const collection: IRenderableAsset[] = [];

  for (let index = 0; index < data.length; index++) {
    const { id, url, uploading, uploadStatus, uploadProgress } = data[index];
    const renderAs = resolveAssetRenderAs(data[index]);
    const img = renderAs === 'image' && (url || data[index].resolveUrl)
      ? loadImg(data[index])
      : undefined;
    const name = resolveAssetName(data[index], index);
    const mimeType = data[index].mimeType ?? '';

    if (renderAs === 'file') {
      if (name || url || isUploadingAsset({ uploading, uploadStatus })) {
        collection.push({
          id,
          url,
          name,
          mimeType,
          renderAs,
          uploading,
          uploadStatus,
          uploadProgress,
        });
      }
      continue;
    }

    if (img !== undefined || url || isUploadingAsset({ uploading, uploadStatus })) {
      collection.push({
        id,
        url,
        name,
        mimeType,
        renderAs,
        img,
        uploading,
        uploadStatus,
        uploadProgress,
      });
    }
  }

  return collection;
};

const generateCacheKey = (data: IImageData[], width: number) => {
  return `${String(width)}-${data
    .map(({ id, renderAs }) => `${id}:${renderAs ?? 'image'}`)
    .join(',')}`;
};

const getFileCardWidth = (
  ctx: CanvasRenderingContext2D,
  theme: ICellRenderProps['theme'],
  asset: IRenderableAsset,
  cardHeight: number
) => {
  const badgeSize = clamp(cardHeight - 12, FILE_BADGE_MIN_SIZE, FILE_BADGE_MAX_SIZE);
  ctx.font = `${theme.fontWeight} ${theme.fontSizeXS}px ${theme.fontFamily}`;
  const maxTextWidth =
    FILE_CARD_MAX_WIDTH - FILE_CARD_HORIZONTAL_PADDING * 2 - badgeSize - FILE_BADGE_GAP;
  const measuredNameWidth = Math.min(maxTextWidth, ctx.measureText(asset.name).width);

  return clamp(
    FILE_CARD_HORIZONTAL_PADDING * 2 + badgeSize + FILE_BADGE_GAP + Math.max(28, measuredNameWidth),
    FILE_CARD_MIN_WIDTH,
    FILE_CARD_MAX_WIDTH
  );
};

const drawImagePlaceholder = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
) => {
  drawRect(ctx, {
    x,
    y,
    width,
    height,
    radius: INNER_PADDING,
    fill: '#E2E8F0',
  });

  // Draw broken image icon
  const iconSize = Math.min(width * 0.4, height * 0.4, 24);
  const cx = x + width / 2;
  const cy = y + height / 2;

  ctx.save();
  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Image frame
  const halfIcon = iconSize / 2;
  const left = cx - halfIcon;
  const top = cy - halfIcon;
  const right = cx + halfIcon;
  const bottom = cy + halfIcon;

  ctx.beginPath();
  ctx.moveTo(left, top + iconSize * 0.15);
  ctx.lineTo(left, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, bottom);
  ctx.lineTo(right - iconSize * 0.15, bottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(left, top + iconSize * 0.5);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right - iconSize * 0.5, bottom);
  ctx.stroke();

  // Diagonal break line
  ctx.beginPath();
  ctx.moveTo(left + iconSize * 0.15, bottom);
  ctx.lineTo(right, top + iconSize * 0.15);
  ctx.stroke();

  // Mountain shape (small)
  ctx.beginPath();
  ctx.moveTo(cx - iconSize * 0.15, cy + iconSize * 0.1);
  ctx.lineTo(cx, cy - iconSize * 0.15);
  ctx.lineTo(cx + iconSize * 0.15, cy + iconSize * 0.1);
  ctx.stroke();

  ctx.restore();
};

const drawFileCard = (
  ctx: CanvasRenderingContext2D,
  theme: ICellRenderProps['theme'],
  asset: IRenderableAsset,
  x: number,
  y: number,
  width: number,
  height: number
) => {
  const { cellLineColor, cellTextColor, fontFamily, fontSizeXS, fontSizeXXS, fontWeight } = theme;
  const badgeSize = clamp(height - 12, FILE_BADGE_MIN_SIZE, FILE_BADGE_MAX_SIZE);
  const badgeX = x + FILE_CARD_HORIZONTAL_PADDING;
  const badgeY = y + (height - badgeSize) / 2;
  const badgeText = getFileExtension(asset.name, asset.url, asset.mimeType);
  const badgeColors = getFileBadgeColors(badgeText);
  const textX = badgeX + badgeSize + FILE_BADGE_GAP;
  const textWidth = Math.max(16, width - FILE_CARD_HORIZONTAL_PADDING - (textX - x));

  drawRect(ctx, {
    x,
    y,
    width,
    height,
    radius: INNER_PADDING,
    fill: '#F8FAFC',
    stroke: cellLineColor,
  });

  drawRect(ctx, {
    x: badgeX,
    y: badgeY,
    width: badgeSize,
    height: badgeSize,
    radius: 6,
    fill: badgeColors.bg,
  });

  ctx.save();
  ctx.font = `${fontWeight} ${Math.min(fontSizeXXS, badgeSize - 10)}px ${fontFamily}`;
  drawSingleLineText(ctx, {
    text: badgeText,
    x: badgeX + badgeSize / 2,
    y: badgeY + (badgeSize - Math.min(fontSizeXXS, badgeSize - 10)) / 2 + 0.5,
    fill: badgeColors.fg,
    maxWidth: badgeSize - 6,
    fontSize: Math.min(fontSizeXXS, badgeSize - 10),
    textAlign: 'center',
  });

  ctx.font = `${fontWeight} ${fontSizeXS}px ${fontFamily}`;
  drawSingleLineText(ctx, {
    text: asset.name,
    x: textX,
    y: y + (height - fontSizeXS) / 2 + 0.5,
    fill: cellTextColor,
    maxWidth: textWidth,
    fontSize: fontSizeXS,
  });
  ctx.restore();
};

const drawUploadOverlay = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  progress: number
) => {
  const barWidth = Math.max(20, width - 12);
  const barHeight = 4;
  const barX = x + (width - barWidth) / 2;
  const barY = y + height - 10;

  ctx.save();
  drawRect(ctx, {
    x,
    y,
    width,
    height,
    radius: INNER_PADDING,
    fill: '#020617',
    opacity: 0.35,
  });
  drawRect(ctx, {
    x: barX,
    y: barY,
    width: barWidth,
    height: barHeight,
    radius: barHeight / 2,
    fill: 'rgba(255, 255, 255, 0.28)',
  });
  drawRect(ctx, {
    x: barX,
    y: barY,
    width: Math.max(barHeight, barWidth * progress),
    height: barHeight,
    radius: barHeight / 2,
    fill: '#ffffff',
  });
  ctx.restore();
};

export const imageCellRenderer: IInternalCellRenderer<IImageCell> = {
  type: CellType.Image,
  needsHoverWhenActive: true,
  needsHoverPositionWhenActive: true,
  draw: (cell: IImageCell, props: ICellRenderProps) => {
    const { rect, columnIndex, rowIndex, theme, ctx, imageManager, isActive, spriteManager } =
      props;
    const { iconSizeSM, cellLineColor } = theme;
    const { data, readonly } = cell;
    const { x, y, width, height } = rect;
    const editable = !readonly && isActive;
    const initPadding = editable ? iconSizeSM + 2 : 0;
    const imgHeight = height - cellVerticalPaddingXS * 2;

    const imageCollection = getAssetCollection(data, (item) =>
      imageManager.loadOrGetImage(item.url, columnIndex, rowIndex, {
        cacheKey: item.resolveUrl ? `asset:${item.id}` : undefined,
        resolveUrl: item.resolveUrl,
      })
    );

    if (editable) {
      spriteManager.drawSprite(ctx, {
        sprite: GridInnerIcon.Add,
        x: x + cellHorizontalPadding - 2,
        y: y + (height - iconSizeSM) / 2,
        size: iconSizeSM,
        theme,
      });
    }

    if (!imageCollection.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width - 0.5, height);
    ctx.clip();

    const cacheKey = generateCacheKey(data, width);
    const positions: (IRectangle & { id: string })[] = [];

    let drawX = x + cellHorizontalPadding + initPadding;

    for (const imgItem of imageCollection) {
      if (drawX > x + width) break;
      const { id, img } = imgItem;
      const progress =
        typeof imgItem.uploadProgress === 'number'
          ? Math.min(1, Math.max(0, imgItem.uploadProgress))
          : 0;
      const itemWidth =
        imgItem.renderAs === 'file'
          ? getFileCardWidth(ctx, theme, imgItem, imgHeight)
          : img && img.height > 0
            ? img.width * (imgHeight / img.height)
            : Math.min(imgHeight * 0.78, 72);

      if (imgItem.renderAs === 'file') {
        drawFileCard(ctx, theme, imgItem, drawX, y + cellVerticalPaddingXS, itemWidth, imgHeight);
      } else if (img) {
        ctx.save();
        drawRect(ctx, {
          x: drawX,
          y: y + cellVerticalPaddingXS,
          width: itemWidth,
          height: imgHeight,
          radius: INNER_PADDING,
        });
        ctx.clip();
        ctx.drawImage(img, drawX, y + cellVerticalPaddingXS, itemWidth, imgHeight);
        ctx.restore();
      } else {
        drawRect(ctx, {
          x: drawX,
          y: y + cellVerticalPaddingXS,
          width: itemWidth,
          height: imgHeight,
          radius: INNER_PADDING,
          stroke: cellLineColor,
        });
        drawImagePlaceholder(ctx, drawX, y + cellVerticalPaddingXS, itemWidth, imgHeight);
      }

      if (isUploadingAsset(imgItem)) {
        drawUploadOverlay(ctx, drawX, y + cellVerticalPaddingXS, itemWidth, imgHeight, progress);
      }

      positions.push({
        id,
        x: drawX - x,
        y: cellVerticalPaddingXS,
        width: itemWidth,
        height: imgHeight,
      });
      drawX += itemWidth + INNER_PADDING;
    }

    imagePositionCache.set(cacheKey, positions);

    ctx.restore();
  },
  checkRegion: (cell: IImageCell, props: ICellClickProps, _shouldCalculate?: boolean) => {
    const { data, readonly } = cell;
    const { width, height, theme, isActive, hoverCellPosition } = props;
    const editable = !readonly && isActive;

    const { iconSizeSM } = theme;
    if (!hoverCellPosition) return { type: CellRegionType.Blank };
    const [hoverX, hoverY] = hoverCellPosition;
    const startX = cellHorizontalPadding;
    const startY = (height - iconSizeSM) / 2;

    if (
      editable &&
      isPointInsideRectangle(
        [hoverX, hoverY],
        [startX, startY],
        [startX + iconSizeSM, startY + iconSizeSM]
      )
    ) {
      return { type: CellRegionType.ToggleEditing, data: null };
    }

    const cacheKey = generateCacheKey(data, width);
    const imagePositions = imagePositionCache.get(cacheKey);

    if (imagePositions == null) return { type: CellRegionType.Blank };

    for (let i = 0; i < imagePositions.length; i++) {
      const { id, x, y, width, height } = imagePositions[i];

      if (isPointInsideRectangle([hoverX, hoverY], [x, y], [x + width, y + height])) {
        return {
          type: CellRegionType.Preview,
          data: id,
        };
      }
    }

    return { type: CellRegionType.Blank };
  },
  onClick: (cell: IImageCell, props: ICellClickProps, callback: ICellClickCallback) => {
    const cellRegion = imageCellRenderer.checkRegion?.(cell, props, true);
    if (!cellRegion || cellRegion.type === CellRegionType.Blank) return;
    if (cellRegion.type === CellRegionType.Preview) {
      if (!props.isActive) return;
      cell?.onPreview?.(cellRegion.data as string);
      return callback(cellRegion);
    }
    callback(cellRegion);
  },
};
