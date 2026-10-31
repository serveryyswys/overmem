// ui/dashboard/MemorySnapshot.ts
/// <reference path="../../../types/index.d.ts" />

import { DatabaseManager } from '../../db/DatabaseManager.js';
import { NodeManager } from '../../db/NodeManager.js';
import { MemoryNode, ScopeType } from '../../db/models.js';
import { logInfo, logError } from '../../utils/Logger.js';

export interface SessionSnapshot {
  sessionId: string;
  title: string;
  roleCardId: string;
  roleCardName: string;
  lastMessageAt: number;
  scopeType: ScopeType;
  scopeId: string;
  shortCount: number;
  midCount: number;
  longCount: number;
  pendingCount: number;
}

export interface MemorySnapshot {
  sessions: SessionSnapshot[];
  totalShort: number;
  totalMid: number;
  totalLong: number;
  totalPending: number;
  // 明细（OverviewState 用）
  shortBlocks: MemoryNode[];
  midBlocks: MemoryNode[];
  longBlocks: MemoryNode[];
}

/**
 * 一次性加载所有 session 的统计数据。
 * 使用 SQL 聚合 + 一次全量节点查询，避免 N+1。
 */
export function loadSnapshot(db: DatabaseManager, nodes: NodeManager): MemorySnapshot {
  const t0 = Date.now();
  const sessions = db.getAllSessionMeta();

  // 1. 一次性查所有 block/summary 的 scope 分布
  const counts = new Map<string, { short: number; mid: number; long: number; pending: number }>();
  try {
    const conn = db.getConnection();
    const c = conn.rawQuery(
      `SELECT scope_type, scope_id, node_type, level, COUNT(*)
       FROM nodes
       WHERE trashed_at IS NULL
       GROUP BY scope_type, scope_id, node_type, level`,
      []
    );
    while (c.moveToNext()) {
      const key = c.getString(0) + ':' + c.getString(1);
      const t = c.getString(2);
      const lv = c.getString(3) || '';
      const n = c.getInt(4);
      let entry = counts.get(key);
      if (!entry) {
        entry = { short: 0, mid: 0, long: 0, pending: 0 };
        counts.set(key, entry);
      }
      if (t === 'block' && lv === 'short') entry.short += n;
      else if (t === 'summary' && lv === 'mid') entry.mid += n;
      else if (t === 'summary' && lv === 'long') entry.long += n;
    }
    c.close();

    // 2. pending 消息数
    const c2 = conn.rawQuery(
      `SELECT scope_type, scope_id, COUNT(*)
       FROM nodes
       WHERE is_pending = 1 AND node_type = 'message'
       GROUP BY scope_type, scope_id`,
      []
    );
    while (c2.moveToNext()) {
      const key = c2.getString(0) + ':' + c2.getString(1);
      let entry = counts.get(key);
      if (!entry) {
        entry = { short: 0, mid: 0, long: 0, pending: 0 };
        counts.set(key, entry);
      }
      entry.pending = c2.getInt(2);
    }
    c2.close();
  } catch (e: any) {
    logError("Snapshot", "聚合查询失败: " + e.message);
  }

  // 3. 组装 session 快照
  const out: SessionSnapshot[] = [];
  let totalShort = 0, totalMid = 0, totalLong = 0, totalPending = 0;

  for (const s of sessions) {
    const scope = db.getScope(s.sessionId, s.roleCardId || '');
    const key = scope.type + ':' + scope.id;
    const entry = counts.get(key) || { short: 0, mid: 0, long: 0, pending: 0 };
    out.push({
      sessionId: s.sessionId,
      title: s.title || '未命名会话',
      roleCardId: s.roleCardId || '',
      roleCardName: s.roleCardName || '',
      lastMessageAt: s.lastMessageAt,
      scopeType: scope.type,
      scopeId: scope.id,
      shortCount: entry.short,
      midCount: entry.mid,
      longCount: entry.long,
      pendingCount: entry.pending
    });
    totalShort += entry.short;
    totalMid += entry.mid;
    totalLong += entry.long;
    totalPending += entry.pending;
  }

  // 4. 明细（供 OverviewState 使用，按 scope 去重）
  const seenShort = new Set<number>();
  const seenMid = new Set<number>();
  const seenLong = new Set<number>();
  const shortBlocks: MemoryNode[] = [];
  const midBlocks: MemoryNode[] = [];
  const longBlocks: MemoryNode[] = [];

  const seenScopes = new Set<string>();
  for (const s of out) {
    const key = s.scopeType + ':' + s.scopeId;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);

    for (const n of nodes.getBlocks(s.scopeType, s.scopeId)) {
      if (!seenShort.has(n.id)) { seenShort.add(n.id); shortBlocks.push(n); }
    }
    for (const n of nodes.getMidBlocks(s.scopeType, s.scopeId)) {
      if (!seenMid.has(n.id)) { seenMid.add(n.id); midBlocks.push(n); }
    }
    for (const n of nodes.getLongBlocks(s.scopeType, s.scopeId)) {
      if (!seenLong.has(n.id)) { seenLong.add(n.id); longBlocks.push(n); }
    }
  }

  shortBlocks.sort((a, b) => b.seq - a.seq);
  midBlocks.sort((a, b) => b.seq - a.seq);
  longBlocks.sort((a, b) => b.seq - a.seq);

  logInfo("Snapshot",
    `加载完成：${out.length} 会话，短=${totalShort} 中=${totalMid} 长=${totalLong} 缓存=${totalPending}，` +
    `耗时 ${Date.now() - t0}ms`);

  return {
    sessions: out,
    totalShort, totalMid, totalLong, totalPending,
    shortBlocks, midBlocks, longBlocks
  };
}
