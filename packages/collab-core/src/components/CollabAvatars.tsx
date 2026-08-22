/**
 * CollabAvatars — 在线协作者头像列表
 *
 * 显示当前在线的其他协作者，每人一个彩色圆点/头像。
 * Agent 标记为 "AI" 标签 + type-agent 语义色。
 */

import React from "react";
import { identityAvatarColor, identityAvatarInitial } from "@tabtin/shared";
import type { CollabPeerState } from "../types.js";
import { resolveAvatarSrc } from "../utils/resolveAvatarSrc.js";

export interface CollabAvatarsProps {
  peers: CollabPeerState[];
  /** 最多显示几个头像，超出显示 +N */
  maxVisible?: number;
  className?: string;
  /** 自定义溢出提示文案，如 `(count) => \`还有 ${count} 位协作者\`` */
  overflowLabel?: (count: number) => string;
}

export const CollabAvatars: React.FC<CollabAvatarsProps> = ({
  peers,
  maxVisible = 5,
  className = "",
  overflowLabel,
}) => {
  if (peers.length === 0) return null;

  const visiblePeers = peers.slice(0, maxVisible);
  const overflowCount = peers.length - maxVisible;

  return (
    <div className={`flex items-center -space-x-1.5 ${className}`}>
      {visiblePeers.map((peer, index) => (
        <PeerAvatar key={peer.clientId ?? `${peer.user.id}-${index}`} peer={peer} />
      ))}
      {overflowCount > 0 && (
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-muted text-caption font-medium text-muted-foreground dark:border-background"
          title={overflowLabel?.(overflowCount) ?? `+${overflowCount} more`}
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
};

const PeerAvatar: React.FC<{ peer: CollabPeerState }> = ({ peer }) => {
  const { user } = peer;
  const isAgent = user.type === "agent";
  const initials = isAgent ? "AI" : identityAvatarInitial(user.name);
  const resolvedAvatar = resolveAvatarSrc(user.avatar);
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);
  const showImage = Boolean(resolvedAvatar && resolvedAvatar !== failedAvatarUrl);

  return (
    <span
      className="relative flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-white text-caption font-bold text-white dark:border-background"
      style={{ backgroundColor: isAgent ? "hsl(var(--type-agent))" : identityAvatarColor(user.id) }}
      title={`${user.name || "Unknown"}${isAgent ? " (AI)" : ""}`}
    >
      {showImage ? (
        <img
          src={resolvedAvatar ?? undefined}
          alt={user.name}
          className="h-full w-full rounded-full object-cover"
          onError={() => {
            if (resolvedAvatar) setFailedAvatarUrl(resolvedAvatar);
          }}
        />
      ) : (
        initials
      )}
      {/* Agent 标识角标 */}
      {isAgent && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-type-agent text-[6px] font-bold text-white ring-1 ring-white dark:ring-background">
          AI
        </span>
      )}
    </span>
  );
};
