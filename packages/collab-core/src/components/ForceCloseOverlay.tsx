/**
 * ForceCloseOverlay — 强制断连提示覆盖层
 *
 * 当服务端发送 force_close 时，在当前协作应用内显示阻断提示。
 *
 * Package-level component uses English defaults.
 * Apps layer can supply translated strings via `title` / `reloadLabel` props.
 */

import React from "react";
import type { ForceCloseMessage } from "../types.js";
import { CloseCode } from "../types.js";

export interface ForceCloseOverlayProps {
  message: ForceCloseMessage;
  /** 重新加载回调 */
  onReload?: () => void;
  /** Override heading text (default: "Disconnected") */
  title?: string;
  /** Override reload button label (default: "Reload") */
  reloadLabel?: string;
  /** 是否有未保存的本地编辑 */
  hasUnsavedEdits?: boolean;
  /** 有未保存编辑时的提示文案 */
  unsavedHint?: string;
  /** 数据已安全保存时的提示文案 */
  safeHint?: string;
  className?: string;
}

const CODE_ICONS: Record<number, string> = {
  [CloseCode.DOCUMENT_NOT_FOUND]: "📄",
  [CloseCode.AUTH_FAILED]: "🔒",
  [CloseCode.DOCUMENT_ARCHIVED]: "📦",
  [CloseCode.DOCUMENT_TOO_LARGE]: "📏",
};

export const ForceCloseOverlay: React.FC<ForceCloseOverlayProps> = ({
  message,
  onReload,
  title = "Disconnected",
  reloadLabel = "Reload",
  hasUnsavedEdits,
  unsavedHint,
  safeHint,
  className = "",
}) => {
  const icon = CODE_ICONS[message.code] || "⚠️";
  const canReload = message.code !== CloseCode.DOCUMENT_TOO_LARGE;

  return (
    <div
      className={`absolute inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm ${className}`}
    >
      <div className="mx-4 max-w-md rounded-xl bg-card p-6 shadow-2xl">
        <div className="mb-4 text-center text-display">{icon}</div>
        <h3 className="mb-2 text-center text-title font-semibold text-foreground">
          {title}
        </h3>
        <p className="mb-2 text-center text-body text-muted-foreground">
          {message.message}
        </p>
        <p className="mb-4 text-center text-caption text-muted-foreground/80">
          {hasUnsavedEdits
            ? (unsavedHint || "Your recent edits are saved locally. They will sync when the connection is restored.")
            : (safeHint || "All your data has been saved.")}
        </p>
        {canReload && onReload && (
          <button
            onClick={onReload}
            className="w-full rounded-lg bg-info px-4 py-2 text-body font-medium text-white hover:bg-info focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            {reloadLabel}
          </button>
        )}
      </div>
    </div>
  );
};
