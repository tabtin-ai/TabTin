/**
 * 版本还原服务端重同步（resync）核心算法。
 *
 * : 版本还原原本走「force-close 踢下线 → 客户端延迟重连 → 重拉全量快照」，
 * 固定开销大且体验为断线闪烁。resync 改为在服务端内存 Y.Doc 上算出「当前内容 →
 * 还原后内容」的 CRDT delta，applyUpdate 后由 Hocuspocus 经既有协作链路广播给所有
 * 在线客户端，客户端无需断线即可收敛到还原后的内容。
 *
 * 还原是**权威覆盖**语义（rollback）：必须删除「当前有、目标没有」的条目（被还原删掉
 * 的行 / 视图 / 文本），不能像重连合并那样保留并发条目。computeResyncDelta 通过
 * 「复制当前文档 → 清空所有根类型 → 灌入目标状态」生成同时包含删除与插入的 delta，
 * 天然满足覆盖语义，且对 table（JSON snapshot 构建的 Y.Doc）与 docs（Yjs binary）通用。
 */

import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

/** resync delta 应用到 Y.Doc 时使用的 transaction origin，便于下游识别来源。 */
export const RESYNC_ORIGIN = "version-resync";

const MAX_YJS_CLIENT_ID = 0xFFFF_FFFF;

function getStructClientIds(doc: Y.Doc): number[] {
  return [...doc.store.clients.keys()];
}

function getMaxClientId(clientIds: Iterable<number>): number {
  let maxClientId = -1;
  for (const clientId of clientIds) {
    if (clientId > maxClientId) maxClientId = clientId;
  }
  return maxClientId;
}

/**
 * 给尚未写入内容的目标文档分配一个高于 live 文档全部 struct 的 clientID。
 *
 * computeResyncDelta 会先删除 live map key，再插入目标文档的同名 key。Y.Map 的冲突
 * 决胜依赖 struct clientID；随机 target clientID 较小时，目标插入会输给旧 key 的
 * tombstone，最终只广播 delete（ 的整表空白）。
 */
export function assignDominatingResyncClientId(liveYdoc: Y.Doc, targetDoc: Y.Doc): void {
  if (getStructClientIds(targetDoc).length > 0) {
    throw new Error("resync target clientID must be assigned before writing target content");
  }
  const maxLiveClientId = getMaxClientId(getStructClientIds(liveYdoc));
  if (maxLiveClientId >= MAX_YJS_CLIENT_ID) {
    throw new Error("no dominating Yjs clientID available for authoritative resync");
  }
  targetDoc.clientID = maxLiveClientId + 1;
}

/** resync / baseline 重置结果。loaded=false 表示文档不在本节点内存，调用方应回退。 */
export interface ResyncResult {
  loaded: boolean;
}

/**  collab-first 还原：编辑者上下文，用于 persist 写库。 */
export interface CollabFirstRestoreEditorContext {
  editor_type?: string;
  editor_id?: string;
  editor_name?: string;
  agent_run_id?: string;
  system_policy?: string;
}

/**  collab-first 还原结果。loaded=true 时 Django 负责 restore_from_snapshot 写 DB。 */
export interface CollabFirstRestoreResult {
  loaded: boolean;
}

/**
 * 具备「服务端版本还原重同步」能力的 Database 扩展契约。
 * BaseCollabDatabase（table 等）与 docs 的 Database 各自实现。
 */
export interface ResyncCapableExtension {
  /** 本节点已加载该文档时：用还原后的权威内容重建内存 Y.Doc 并广播；否则返回 loaded=false。 */
  resyncLoadedDocument(instance: Hocuspocus, documentName: string): Promise<ResyncResult>;
}

/**
 * : 表格 collab-first 版本还原——用 VH 快照直接更新在线 Y.Doc 并 persist 写回 Django。
 */
export interface CollabFirstRestoreCapableExtension extends ResyncCapableExtension {
  collabFirstRestoreLoadedDocument(
    instance: Hocuspocus,
    documentName: string,
    snapshot: Record<string, unknown>,
    editorContext: CollabFirstRestoreEditorContext,
  ): Promise<CollabFirstRestoreResult>;
}

/** 从某个 Hocuspocus 实例的扩展列表中找到实现 resync 契约的 Database 扩展。 */
export function findResyncExtension(
  instance: Hocuspocus,
): ResyncCapableExtension | null {
  const exts = instance.configuration.extensions as unknown[];
  for (const ext of exts) {
    if (ext && typeof (ext as ResyncCapableExtension).resyncLoadedDocument === "function") {
      return ext as ResyncCapableExtension;
    }
  }
  return null;
}

/** 查找支持 collab-first 还原的 Database 扩展（当前仅 table）。 */
export function findCollabFirstRestoreExtension(
  instance: Hocuspocus,
): CollabFirstRestoreCapableExtension | null {
  const exts = instance.configuration.extensions as unknown[];
  for (const ext of exts) {
    if (
      ext
      && typeof (ext as CollabFirstRestoreCapableExtension).collabFirstRestoreLoadedDocument
        === "function"
    ) {
      return ext as CollabFirstRestoreCapableExtension;
    }
  }
  return null;
}

/**
 * 通过 applyUpdate 载入的根类型在被 typed getter（getMap/getArray…）访问前是泛型
 * AbstractType，`instanceof Y.Map` 等判定失效。改用 Yjs 内部结构区分：
 * - 链表型（Array/Text/XmlFragment/XmlElement）内容挂在 `_start`；
 * - Map 型内容挂在 `_map`。
 * 命中后用对应 typed getter 触发 morph 再清空（链表型一律按 Array 删除条目即可清空，
 * 因为只需要让删除进入 delete set，不关心 JS 包装类型）。
 */
interface YInternalType {
  _start: unknown;
  _map: Map<string, unknown>;
}

function clearRootType(doc: Y.Doc, name: string): void {
  const type = doc.share.get(name) as unknown as YInternalType | undefined;
  if (!type) return;
  if (type._start != null) {
    const arr = doc.getArray(name);
    if (arr.length > 0) arr.delete(0, arr.length);
  } else if (type._map != null && type._map.size > 0) {
    doc.getMap(name).clear();
  }
}

/**
 * 计算把 liveYdoc 当前内容**整体替换**为 targetState 内容所需的 CRDT delta。
 *
 * 关键不变量：
 * 1. workDoc 以 liveYdoc 完整状态初始化，因此与 liveYdoc 共享 struct ID 与 state
 *    vector。基于 liveSV 编码出的 delta 应用回 liveYdoc 时，删除操作能精确命中
 *    liveYdoc 中的既有条目。
 * 2. 清空所有根类型后再灌入 targetState。目标文档必须先通过
 *    assignDominatingResyncClientId 分配高于 live 全部 struct 的 clientID；否则同名
 *    Y.Map key 的目标插入可能输给旧 tombstone，退化为纯删除。函数会拒绝不安全输入。
 *
 * 前置条件：targetState 不得与 liveYdoc 同源（例如 TabDoc VH 存的是同一文档的历史
 * Y.js binary 因果子集）。此时 applyUpdate(workDoc, targetState) 为 no-op，delta 仅含
 * 删除。TabDoc 还原请走 replaceXmlFragment（见 DocsDatabase.resyncLoadedDocument）。
 *
 * @param liveYdoc    在线 Y.Doc（Hocuspocus 内存文档），不会被本函数改动。
 * @param targetState 还原后内容的 Yjs 完整 update（Y.encodeStateAsUpdate 产物）。
 * @returns 可直接 Y.applyUpdate 到 liveYdoc 的 delta；应用后会广播给所有连接。
 */
export function computeResyncDelta(liveYdoc: Y.Doc, targetState: Uint8Array): Uint8Array {
  const liveSV = Y.encodeStateVector(liveYdoc);
  const workDoc = new Y.Doc();
  const targetProbe = new Y.Doc();
  try {
    Y.applyUpdate(targetProbe, targetState);
    const maxLiveClientId = getMaxClientId(getStructClientIds(liveYdoc));
    const targetClientIds = getStructClientIds(targetProbe);
    const targetClientId = targetClientIds[0] ?? -1;
    if (targetClientIds.length !== 1 || targetClientId <= maxLiveClientId) {
      throw new Error(
        `unsafe resync target clientIDs: target=${targetClientIds.join(",")}, liveMax=${maxLiveClientId}`,
      );
    }

    Y.applyUpdate(workDoc, Y.encodeStateAsUpdate(liveYdoc));
    workDoc.transact(() => {
      for (const name of [...workDoc.share.keys()]) {
        clearRootType(workDoc, name);
      }
    });
    Y.applyUpdate(workDoc, targetState);
    return Y.encodeStateAsUpdate(workDoc, liveSV);
  } finally {
    targetProbe.destroy();
    workDoc.destroy();
  }
}
