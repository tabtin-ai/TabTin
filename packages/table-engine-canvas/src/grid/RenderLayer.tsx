import type { FC } from 'react';
import { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import type { IVisibleRegion } from './hooks';
import type { IInteractionLayerProps } from './InteractionLayer';
import { RegionType } from './interface';
import type {
  ILinearRow,
  ICellItem,
  IPosition,
  IDragState,
  IMouseState,
  IColumnResizeState,
  ICellPosition,
  IActiveCellBound,
  IColumnFreezeState,
  IRowTreeData,
} from './interface';
import type { CombinedSelection } from './managers';
import { drawGrid } from './renderers';

const DRAW_THROTTLE_MS = 8;

export interface IRenderLayerProps
  extends Pick<
    IInteractionLayerProps,
    | 'theme'
    | 'width'
    | 'height'
    | 'columns'
    | 'commentCountMap'
    | 'rowControls'
    | 'imageManager'
    | 'spriteManager'
    | 'scrollState'
    | 'coordInstance'
    | 'columnStatistics'
    | 'groupCollection'
    | 'rowIndexVisible'
    | 'searchCursor'
    | 'prefillingRowIndexes'
    | 'searchHitIndex'
    | 'collaborators'
    | 'columnHeaderHeight'
    | 'isMultiSelectionEnable'
    | 'getCellContent'
  > {
  getRowTreeData?: (rowIndex: number) => IRowTreeData | null;
  isEditing?: boolean;
  isFilling?: boolean;
  isFillEnabled?: boolean;
  visibleRegion: IVisibleRegion;
  activeCell: ICellItem | null;
  activeCellBound: IActiveCellBound | null;
  dragState: IDragState;
  mouseState: IMouseState;
  columnFreezeState: IColumnFreezeState;
  selection: CombinedSelection;
  isSelecting: boolean;
  isInteracting?: boolean;
  forceRenderFlag: string | number;
  hoverCellPosition: ICellPosition | null;
  hoveredColumnResizeIndex: number;
  columnResizeState: IColumnResizeState;
  isColumnFreezable?: boolean;
  isRowAppendEnable?: boolean;
  isColumnResizable?: boolean;
  isColumnAppendEnable?: boolean;
  isColumnHeaderMenuVisible?: boolean;
  real2RowIndex: (index: number) => number;
  getLinearRow: (index: number) => ILinearRow;
}

export const RenderLayer: FC<React.PropsWithChildren<IRenderLayerProps>> = (props) => {
  const {
    theme,
    width,
    height,
    columns,
    commentCountMap,
    isEditing,
    rowControls,
    visibleRegion,
    imageManager,
    spriteManager,
    activeCell,
    activeCellBound,
    collaborators,
    searchCursor,
    prefillingRowIndexes,
    searchHitIndex,
    dragState,
    scrollState,
    columnFreezeState,
    hoverCellPosition,
    mouseState: originMouseState,
    selection,
    isSelecting,
    isInteracting: _isInteracting,
    coordInstance,
    forceRenderFlag,
    groupCollection,
    rowIndexVisible,
    columnStatistics,
    columnResizeState,
    columnHeaderHeight,
    hoveredColumnResizeIndex,
    isColumnFreezable,
    isRowAppendEnable,
    isColumnResizable,
    isColumnAppendEnable,
    isMultiSelectionEnable,
    isColumnHeaderMenuVisible,
    getCellContent,
    getRowTreeData,
    real2RowIndex,
    getLinearRow,
    isFilling,
    isFillEnabled,
  } = props;
  const { containerWidth } = coordInstance;
  const { x, y, columnIndex, rowIndex, type, isOutOfBounds } = originMouseState;
  const isInteracting = _isInteracting || type === RegionType.ColumnFreezeHandler;

  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPropsRef = useRef<IRenderLayerProps | undefined>(undefined);
  const lastMainDrawFrameRef = useRef<number>(0);
  const hoverRafRef = useRef(0);

  const cacheCanvas = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.style.opacity = '0';
    canvas.style.position = 'fixed';
    return canvas;
  }, []);

  const mouseState: IMouseState = useMemo(() => {
    return {
      type,
      rowIndex,
      columnIndex,
      isOutOfBounds,
      x: 0,
      y: 0,
    };
  }, [columnIndex, rowIndex, type, isOutOfBounds]);

  const mousePosition: IPosition | null = useMemo(() => {
    if (!isInteracting) return null;
    return { x, y };
  }, [x, y, isInteracting]);

  const mouseStateRef = useRef(mouseState);
  const mousePositionRef = useRef(mousePosition);
  const hoverCellPositionRef = useRef(hoverCellPosition);
  mouseStateRef.current = mouseState;
  mousePositionRef.current = mousePosition;
  hoverCellPositionRef.current = hoverCellPosition;

  // buildProps 每次 render 都重建，捕获当前 render 的全部 props。
  // 通过 buildPropsRef 暴露给 rAF 回调，确保延迟绘制总是用最新数据。
  const buildProps = (): IRenderLayerProps => {
    const ms = mouseStateRef.current;
    const mp = mousePositionRef.current;
    return {
      theme,
      width,
      height,
      columns,
      commentCountMap,
      isEditing,
      rowControls,
      visibleRegion,
      imageManager,
      spriteManager,
      activeCell,
      activeCellBound,
      collaborators,
      searchCursor,
      prefillingRowIndexes,
      searchHitIndex,
      dragState,
      scrollState,
      columnFreezeState,
      hoverCellPosition: hoverCellPositionRef.current,
      mouseState: mp ? { ...ms, ...mp } : ms,
      selection,
      isFilling,
      isFillEnabled,
      isSelecting,
      isInteracting,
      coordInstance,
      forceRenderFlag,
      groupCollection,
      rowIndexVisible,
      columnStatistics,
      columnResizeState,
      columnHeaderHeight,
      hoveredColumnResizeIndex,
      isColumnFreezable,
      isRowAppendEnable,
      isColumnResizable,
      isColumnAppendEnable,
      isColumnHeaderMenuVisible,
      isMultiSelectionEnable,
      getCellContent,
      getRowTreeData,
      real2RowIndex,
      getLinearRow,
    };
  };

  const buildPropsRef = useRef(buildProps);
  buildPropsRef.current = buildProps;

  // 稳定的核心绘制函数：通过 ref 读取最新 buildProps，不受闭包过期影响
  const doDrawCore = useCallback(() => {
    const mainCanvas = mainCanvasRef.current;
    if (mainCanvas == null) return;
    const lastProps = lastPropsRef.current;
    const props = buildPropsRef.current();
    lastPropsRef.current = props;
    try {
      drawGrid(mainCanvas, cacheCanvas, props, lastProps);
    } catch (error) {
      console.error('[RenderLayer] drawGrid failed', error);
    }
  }, [cacheCanvas]);

  const drawRafIdRef = useRef<number>(0);

  // 带节流的绘制：被节流时延迟到 rAF，但 rAF 回调通过 doDrawCore 使用最新数据
  const doDraw = () => {
    const now = performance.now();
    if (now - lastMainDrawFrameRef.current < DRAW_THROTTLE_MS) {
      if (drawRafIdRef.current) {
        cancelAnimationFrame(drawRafIdRef.current);
      }
      drawRafIdRef.current = requestAnimationFrame(() => {
        drawRafIdRef.current = 0;
        lastMainDrawFrameRef.current = performance.now();
        doDrawCore();
      });
      return;
    }
    lastMainDrawFrameRef.current = now;
    doDrawCore();
  };

  useEffect(() => {
    return () => {
      if (drawRafIdRef.current) {
        cancelAnimationFrame(drawRafIdRef.current);
        drawRafIdRef.current = 0;
      }
    };
  }, []);

  // 数据级变化（columns / theme / getCellContent 等）：useEffect 即可
  useEffect(() => {
    doDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    theme, width, height, columns, commentCountMap, rowControls,
    imageManager, spriteManager, collaborators, searchHitIndex,
    prefillingRowIndexes, columnFreezeState, coordInstance,
    groupCollection, rowIndexVisible, columnStatistics,
    columnHeaderHeight, isColumnFreezable, isRowAppendEnable,
    isColumnResizable, isColumnAppendEnable, isColumnHeaderMenuVisible,
    isMultiSelectionEnable, isFillEnabled, cacheCanvas,
    getCellContent, getRowTreeData, real2RowIndex, getLinearRow,
  ]);

  // 交互态变化（activeCell / selection / isEditing 等）：
  // 必须 useLayoutEffect — 在浏览器 paint 前同步绘制 canvas，
  // 否则 DOM（编辑器位置）已更新但 canvas 还是旧帧，产生一帧闪烁。
  useLayoutEffect(() => {
    lastMainDrawFrameRef.current = performance.now();
    doDrawCore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scrollState, selection, isSelecting, isEditing, isInteracting,
    activeCell, activeCellBound, dragState, visibleRegion,
    forceRenderFlag, isFilling, searchCursor,
    columnResizeState, hoveredColumnResizeIndex,
    doDrawCore,
  ]);

  // hover 变化：优先级低，rAF 延迟即可，但通过 doDrawCore 保证不用过期数据
  useEffect(() => {
    if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      doDrawCore();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mouseState, mousePosition, hoverCellPosition, doDrawCore]);

  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
    };
  }, []);

  return (
    <div
      style={{
        position: 'relative',
        width: containerWidth,
        height,
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={mainCanvasRef}
        className="pointer-events-none"
        style={{
          pointerEvents: 'none',
          width: containerWidth,
          height,
          backgroundColor: theme.cellBg,
        }}
      />
    </div>
  );
};
