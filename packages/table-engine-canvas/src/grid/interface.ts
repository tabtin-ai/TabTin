import type { IUser } from './shims/context';
import type { IGridTheme } from './configs/gridTheme';
import type { ICell } from './renderers/cell-renderer/interface';
export * from './renderers/cell-renderer/interface';

export interface IScrollState {
  scrollTop: number;
  scrollLeft: number;
  isScrolling: boolean;
}

export type OverlayCoordinateSpace = 'container' | 'client';

export interface IPosition {
  x: number;
  y: number;
  /** `client` = viewport coords (context menu). Default `container` = relative to grid container. */
  coordinateSpace?: OverlayCoordinateSpace;
}

export interface IRegionPosition extends IPosition {
  rowIndex: number;
  columnIndex: number;
}

export interface IRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IRowTreeData {
  treeDepth?: number;
  treeHasChildren?: boolean;
  treeExpanded?: boolean;
  /** 1-based display index counting only root rows; undefined for child rows */
  rootDisplayIndex?: number;
}

export enum SelectionRegionType {
  Rows = 'Rows',
  Columns = 'Columns',
  Cells = 'Cells',
  None = 'None',
}

export enum RegionType {
  Cell = 'Cell',
  ActiveCell = 'ActiveCell',
  CellValue = 'CellValue',
  AppendRow = 'AppendRow',
  AppendColumn = 'AppendColumn',
  ColumnHeader = 'ColumnHeader',
  GroupStatistic = 'GroupStatistic',
  ColumnStatistic = 'ColumnStatistic',
  ColumnHeaderMenu = 'ColumnHeaderMenu',
  ColumnPrimaryIcon = 'ColumnPrimaryIcon',
  ColumnDescription = 'ColumnDescription',
  ColumnResizeHandler = 'ColumnResizeHandler',
  ColumnFreezeHandler = 'ColumnFreezeHandler',
  RowHeaderDragHandler = 'RowHeaderDragHandler',
  RowHeaderExpandHandler = 'RowHeaderExpandHandler',
  RowHeaderCheckbox = 'RowHeaderCheckbox',
  RowTreeExpandHandler = 'RowTreeExpandHandler',
  RowTreeAddSubRecord = 'RowTreeAddSubRecord',
  CommentCount = 'CommentCount',
  RowGroupControl = 'RowGroupControl',
  RowGroupHeader = 'RowGroupHeader',
  RowCountLabel = 'RowCountLabel',
  RowHeader = 'RowHeader',
  AllCheckbox = 'AllCheckbox',
  FillHandler = 'FillHandler',
  Blank = 'Blank',
  None = 'None',
}

export type ICellRange = [colIndex: number, rowIndex: number]; // The beginning and the end come in pairs
export type IColumnRange = [colStartIndex: number, colEndIndex: number];
export type IRowRange = [rowStartIndex: number, rowEndIndex: number];
export type IRange = ICellRange | IColumnRange | IRowRange;

export interface IMouseState extends IRegionPosition {
  type: RegionType;
  isOutOfBounds: boolean;
}

export interface IColumnStatistics {
  [columnId: string]: IColumnStatistic | null;
}

export interface IColumnStatistic {
  total: string;
  groups?: Record<string, string>;
}

export interface IGridColumn {
  id?: string;
  name: string;
  icon?: string;
  width?: number;
  hasMenu?: boolean;
  readonly?: boolean;
  isPrimary?: boolean;
  description?: string;
  statisticLabel?: {
    showAlways: boolean;
    label: string;
  };
  customTheme?: Partial<IGridTheme>;
}

export interface IColumnResizeState {
  columnIndex: number;
  width: number;
  x: number;
}

export interface IColumnFreezeState {
  sourceIndex: number;
  targetIndex: number;
  isFreezing: boolean;
}

export interface IDragState {
  type: DragRegionType;
  delta: number;
  ranges: IRange[];
  isDragging: boolean;
}

export enum DragRegionType {
  Rows = 'Rows',
  Columns = 'Columns',
  None = 'None',
}

export type IScrollDirection = -1 | 0 | 1;

export enum MouseButtonType {
  Left = 0,
  Center = 1,
  Right = 2,
}

export enum RowControlType {
  Drag = 'Drag',
  Expand = 'Expand',
  Checkbox = 'Checkbox',
}

export interface IRowControlItem {
  type: RowControlType;
  icon?: string;
}

export type ICellItem = [colIndex: number, rowIndex: number];

export type ICollaborator = {
  activeCell?: ICellItem;
  activeCellId: [recordId: string, field: string];
  user?: Omit<IUser, 'phone'>;
  userId?: string;
  userName?: string;
  borderColor: string;
  timeStamp: number;
}[];

export type ICellPosition = [x: number, y: number];

export interface IPositionWithBounds {
  bounds: IRectangle;
  eventPosition: IPosition;
}

export enum DraggableType {
  All = 'all',
  None = 'none',
  Column = 'column',
  Row = 'row',
}

export enum GridCustomIcon {
  Description = 'description',
}

export enum SelectableType {
  All = 'all',
  None = 'none',
  Column = 'column',
  Row = 'row',
  Cell = 'cell',
}

export interface IActiveCellBound {
  rowIndex: number;
  columnIndex: number;
  width: number;
  height: number;
  totalHeight: number;
  scrollTop: number;
  scrollEnable: boolean;
}

export enum LinearRowType {
  Group = 0,
  Row = 1,
  Append = 2,
}

export interface IGroupHeaderPoint {
  id: string;
  type: LinearRowType.Group;
  depth: number;
  value?: unknown;
  isCollapsed?: boolean;
  /** 全表该组总数（metadata） */
  count?: number;
  /** 当前已挂载到画布的行数 */
  loadedCount?: number;
  /** 组头计数徽章文案；loaded < count 时为「a / b」 */
  countLabel?: string;
}

export interface IGroupRowPoint {
  type: LinearRowType.Row;
  count: number;
}

export interface IGroupAddButtonPoint {
  type: LinearRowType.Append;
  groupPath?: string;
  groupValues?: Record<string, unknown>;
}

export type IGroupPoint = IGroupHeaderPoint | IGroupRowPoint | IGroupAddButtonPoint;

export type ILinearRow =
  | {
      type: LinearRowType.Row;
      displayIndex: number;
      realIndex: number;
    }
  | {
      id: string;
      type: LinearRowType.Group;
      value: unknown;
      depth: number;
      realIndex: number;
      isCollapsed: boolean;
      count?: number;
      loadedCount?: number;
      countLabel?: string;
    }
  | {
      type: LinearRowType.Append;
      value: unknown;
      realIndex: number;
      groupPath?: string;
      groupValues?: Record<string, unknown>;
    };

export interface IGroupCollection {
  groupColumns: IGridColumn[];
  getGroupCell: (cellValue: unknown, depth: number) => ICell;
}

export interface IColumnLoading {
  index: number;
  progress: number;
  onCancel?: () => void;
}

export interface ICellError {
  cellItem: ICellItem;
  errorMsg: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}
