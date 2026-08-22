import type { IGridTheme } from '../../configs';
import type { ICellPosition, IGridColumn, IRectangle, IRowControlItem } from '../../interface';
import type { CoordinateManager, ImageManager, SpriteManager } from '../../managers';
import type { ICell } from '../cell-renderer/interface';
import type { IRenderLayerProps } from '../../RenderLayer';

export interface ICellDrawerProps extends IRectangle {
  getCellContent: IRenderLayerProps['getCellContent'];
  theme: IGridTheme;
  fill?: string;
  stroke?: string;
  isActive?: boolean;
  rowIndex: number;
  columnIndex: number;
  imageManager: ImageManager;
  spriteManager: SpriteManager;
  hoverCellPosition?: ICellPosition | null;
  /** Pixel indent for sub-record tree hierarchy (first column only) */
  treeIndent?: number;
  /** Tree depth level (0 = root; undefined = not in tree mode) */
  treeDepth?: number;
  /** Whether this row has child records in tree mode */
  treeHasChildren?: boolean;
  /** Whether children are currently expanded */
  treeExpanded?: boolean;
  /** Pre-fetched cell content to avoid redundant getCellContent calls */
  cell?: ICell;
  /** Comment total rendered at the end of the primary-field cell. */
  commentCount?: number;
}

export interface IRowHeaderDrawerProps extends IRectangle {
  displayIndex: string;
  theme: IGridTheme;
  rowControls: IRowControlItem[];
  spriteManager: SpriteManager;
  fill?: string;
  stroke?: string;
  isHover?: boolean;
  isChecked?: boolean;
  rowIndexVisible?: boolean;
  /** Sub-record tree depth (0 = root, undefined = no tree) — used for row number display */
  treeDepth?: number;
}

export interface IGroupRowHeaderDrawerProps extends IRectangle {
  depth: number;
  theme: IGridTheme;
  isCollapsed: boolean;
  spriteManager: SpriteManager;
  groupCollection: IRenderLayerProps['groupCollection'];
}

export interface IGroupRowDrawerProps extends IGroupRowHeaderDrawerProps {
  columnIndex: number;
  rowIndex: number;
  value: unknown;
  isHover: boolean;
  imageManager: ImageManager;
  countLabel?: string;
}

export interface IAppendRowDrawerProps extends IRectangle {
  theme: IGridTheme;
  isHover: boolean;
  spriteManager: SpriteManager;
  coordInstance: CoordinateManager;
}

export interface IFieldHeadDrawerProps extends IRectangle {
  column: IGridColumn;
  theme: IGridTheme;
  spriteManager: SpriteManager;
  fill?: string;
  hasMenu?: boolean;
}

export interface IAppendColumnDrawerProps extends IRectangle {
  theme: IGridTheme;
  isHover: boolean;
  isColumnAppendEnable?: boolean;
}

export interface IGridHeaderDrawerProps extends IRectangle {
  theme: IGridTheme;
  isChecked: boolean;
  rowControls: IRowControlItem[];
  isMultiSelectionEnable?: boolean;
}

export enum RenderRegion {
  Freeze = 'Freeze',
  Other = 'Other',
}

export enum DividerRegion {
  Top = 'Top',
  Bottom = 'Bottom',
}

export interface ILayoutDrawerProps extends IRenderLayerProps {
  shouldRerender?: boolean;
}

export interface ICacheDrawerProps {
  containerWidth: number;
  containerHeight: number;
  pixelRatio: number;
  shouldRerender?: boolean;
  /** When set, shifts existing cache content by (dx, dy) CSS pixels and clips to the newly exposed strip */
  scrollShift?: { dx: number; dy: number } | null;
  draw: (cacheCtx: CanvasRenderingContext2D) => void;
}

export interface IGroupStatisticDrawerProps extends IRectangle {
  theme: IGridTheme;
  bgColor?: string;
  isHovered: boolean;
  text?: string;
  textOffsetY?: number;
  showAlways?: boolean;
  defaultLabel?: string;
}
