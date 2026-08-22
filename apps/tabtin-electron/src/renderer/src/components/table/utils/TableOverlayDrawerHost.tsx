import React from 'react';
import { createPortal } from 'react-dom';
import { useOverlayContainer } from '@tabtin/smartsheet-ui';

export function useTableOverlayDrawerContainer(open: boolean): {
  host: React.ReactNode;
  container: HTMLDivElement | null;
  ready: boolean;
} {
  const overlayContainer = useOverlayContainer();
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null);

  const host = overlayContainer
    ? createPortal(
        <div
          ref={setContainer}
          data-table-drawer-host
          className="pointer-events-none absolute inset-0 z-modal"
        />,
        overlayContainer,
      )
    : null;

  return {
    host,
    container,
    ready: !open || !overlayContainer || Boolean(container),
  };
}
