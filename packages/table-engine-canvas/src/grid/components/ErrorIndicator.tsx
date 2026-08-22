/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
import { AlertCircle, RefreshCcw, X } from '../../icons/inlineIcons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../shims/i18n';
import type { ICellError, IScrollState } from '../interface';
import type { CoordinateManager } from '../managers';

export interface IErrorIndicatorProps {
  cellErrors: ICellError[];
  coordInstance: CoordinateManager;
  scrollState: IScrollState;
}

const stopEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

const ErrorActionButton = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-body font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
    onMouseDown={stopEvent}
    onClick={(event) => {
      stopEvent(event);
      onClick();
    }}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export const ErrorIndicator = (props: IErrorIndicatorProps) => {
  const { cellErrors, coordInstance, scrollState } = props;
  const { t } = useTranslation();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  if (!cellErrors.length) return null;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!overlayRef.current?.contains(event.target as Node)) {
        setActiveKey(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  const { scrollLeft, scrollTop } = scrollState;
  const { rowInitSize, freezeColumnCount, freezeRegionWidth, containerWidth, containerHeight } =
    coordInstance;

  return (
    <div ref={overlayRef} className="pointer-events-none absolute left-0 top-0 z-sticky">
      {cellErrors.map(({ cellItem, errorMsg, onRetry, onDismiss }) => {
        const [columnIndex, rowIndex] = cellItem;
        const rowHeight = coordInstance.getRowHeight(rowIndex);
        const rowOffset = coordInstance.getRowOffset(rowIndex);
        const columnWidth = coordInstance.getColumnWidth(columnIndex);
        const columnOffset = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);

        const y = rowOffset - scrollTop;
        const isFreeze = columnIndex < freezeColumnCount;
        const isColumnVisible =
          isFreeze ||
          (columnOffset + columnWidth - 24 >= freezeRegionWidth &&
            columnOffset <= containerWidth);
        const isRowVisible = y >= rowInitSize - 4 && y <= containerHeight - rowInitSize + 4;

        if (!isColumnVisible || !isRowVisible) return null;

        const key = `error-${columnIndex}-${rowIndex}`;
        const isOpen = activeKey === key;

        return (
          <div
            key={key}
            className="absolute"
            style={{
              left: columnOffset,
              top: rowOffset - scrollTop,
              width: columnWidth,
              height: rowHeight,
            }}
            onMouseEnter={() => setActiveKey(key)}
            onMouseLeave={() => setActiveKey((current) => (current === key ? null : current))}
          >
            <div className="pointer-events-auto absolute right-1 top-1">
              <button
                type="button"
                aria-label={t('aiError.title')}
                className="relative flex size-6 items-center justify-center rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-destructive/20 focus:outline-none focus:ring-2 focus:ring-destructive/40"
                onMouseDown={stopEvent}
                onClick={(event) => {
                  stopEvent(event);
                  setActiveKey((current) => (current === key ? null : key));
                }}
              >
                <AlertCircle className="size-4" />
              </button>
            </div>
            {isOpen && (
              <div
                role="tooltip"
                className="pointer-events-auto absolute right-1 top-8 w-[280px] rounded-lg border border-border/30 [border-width:0.5px] bg-popover/80 backdrop-blur-md p-3 shadow-xl"
                onMouseDown={stopEvent}
              >
                <div className="space-y-2">
                  <p className="text-body font-medium text-foreground">{t('aiError.title')}</p>
                  <p className="break-words text-body leading-5 text-muted-foreground">{errorMsg}</p>
                  {(onRetry || onDismiss) && (
                    <div className="flex gap-2 pt-1">
                      {onRetry && (
                        <ErrorActionButton
                          label={t('aiError.retry')}
                          icon={<RefreshCcw className="size-3" />}
                          onClick={() => {
                            onRetry();
                            setActiveKey(null);
                          }}
                        />
                      )}
                      {onDismiss && (
                        <ErrorActionButton
                          label={t('aiError.dismiss')}
                          icon={<X className="size-3" />}
                          onClick={() => {
                            onDismiss();
                            setActiveKey(null);
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
