// db/MigrationChain.ts
/// <reference path="../../types/index.d.ts" />

import { EXPECTED_TABLES, EXPECTED_INDEXES, LEGACY_TABLES, TableDef } from './Schema.js';
import { DbVersion, CURRENT_DB_VERSION, setUserVersion } from './DbVersion.js';
import { logInfo, logError, logWarn } from '../utils/Logger.js';
import { sanId, sanGroupId, sanContent, sanError } from '../utils/Sanitizer.js';

// ============================================
// 步骤接口
// ============================================

export interface MigrationStep {
  from: DbVersion;
  to: DbVersion;
  name: string;
  run(conn: any): void;
}

// ============================================
// 通用结构辅助
// ============================================

function ensureAllTables(conn: any): void {
  for (const table of EXPECTED_TABLES) {
    ensureTable(conn, table);
  }
  for (const sql of EXPECTED_INDEXES) {
    try { conn.execSQL(sql); } catch (e: any) {
      logWarn("Migrate", "创建索引失败: " + e.message);
    }
  }
}

function ensureTable(conn: any, table: TableDef): void {
  if (!tableExists(conn, table.name)) {
    const colDefs: string[] = [];
    for (const col of table.columns) {
      let def = `${col.name} ${col.type}`;
      if (col.primary && !table.compositePrimary) def += " PRIMARY KEY";
      if (col.name === "id" && col.primary) def += " AUTOINCREMENT";
      if (col.notNull) def += " NOT NULL";
      if (col.default !== undefined && col.default !== null) {
        def += ` DEFAULT ${col.default}`;
      }
      colDefs.push(def);
    }
    if (table.compositePrimary && table.compositePrimary.length > 0) {
      colDefs.push(`PRIMARY KEY (${table.compositePrimary.join(", ")})`);
    }
    conn.execSQL(
      `CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${colDefs.join(",\n  ")}\n)`
    );
    return;
  }

  const existing = getColumns(conn, table.name);
  for (const col of table.columns) {
    if (existing.indexOf(col.name) === -1) {
      let sql = `ALTER TABLE ${table.name} ADD COLUMN ${col.name} ${col.type}`;
      if (col.default !== undefined && col.default !== null) {
        sql += ` DEFAULT ${col.default}`;
      }
      try { conn.execSQL(sql); } catch (e: any) {
        logWarn("Migrate", `补列 ${table.name}.${col.name} 失败: ` + e.message);
      }
    }
  }
}

function tableExists(conn: any, name: string): boolean {
  try {
    const c = conn.rawQuery(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]
    );
    const ok = c.moveToFirst();
    c.close();
    return ok;
  } catch (_) { return false; }
}

function getColumns(conn: any, table: string): string[] {
  const out: string[] = [];
  try {
    const c = conn.rawQuery(`PRAGMA table_info(${table})`, []);
    while (c.moveToNext()) out.push(c.getString(1));
    c.close();
  } catch (_) {}
  return out;
}

function dropLegacyTables(conn: any): void {
  let dropped = 0;
  for (const name of LEGACY_TABLES) {
    if (tableExists(conn, name)) {
      conn.execSQL(`DROP TABLE IF EXISTS ${name}`);
      dropped++;
    }
  }
  logInfo("Migrate", `删除 ${dropped} 个旧表`);
}

function lastInsertRowId(conn: any): number {
  const c = conn.rawQuery("SELECT last_insert_rowid()", []);
  c.moveToFirst();
  const id = c.getLong(0);
  c.close();
  return id;
}

// ============================================
// v3 数据结构
// ============================================

interface V3Segment {
  id: number; scopeType: string; scopeId: string; sessionId: string;
  role: string; content: string; timestamp: number; msgId: string;
  createdAt: number;
}
interface V3ShortBlock {
  id: number; scopeType: string; scopeId: string; content: string;
  sourceIds: number[]; sessionId: string; createdAt: number;
}
interface V3MidBlock {
  id: number; scopeType: string; scopeId: string; content: string;
  state: string; sourceBlockIds: number[]; sessionId: string;
  createdAt: number; updatedAt: number;
}
interface V3LongBlock {
  id: number; scopeType: string; scopeId: string; content: string;
  state: string; sourceMidIds: number[]; sessionId: string;
  createdAt: number; updatedAt: number;
}
interface V3Pending {
  scopeType: string; scopeId: string; sessionId: string; role: string;
  content: string; timestamp: number; msgId: string; updatedAt: number;
}
interface V3Session {
  sessionId: string; title: string; roleCardId: string; roleCardName: string;
  createdAt: number; updatedAt: number;
  segments: V3Segment[];
  shortBlocks: V3ShortBlock[];
  midBlocks: V3MidBlock[];
  longBlocks: V3LongBlock[];
  pendings: V3Pending[];
}

function parseIntList(s: string): number[] {
  if (!s) return [];
  const out: number[] = [];
  for (const part of s.split(",")) {
    const t = part.trim();
    if (/^\d+$/.test(t)) out.push(parseInt(t, 10));
  }
  return out;
}

function readV3Data(conn: any): V3Session[] {
  const sessions = new Map<string, V3Session>();

  const ensure = (sid: string, ca: number, ua: number): V3Session => {
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        sessionId: sid, title: "", roleCardId: "", roleCardName: "",
        createdAt: ca, updatedAt: ua,
        segments: [], shortBlocks: [], midBlocks: [], longBlocks: [], pendings: []
      });
    }
    return sessions.get(sid)!;
  };

  if (tableExists(conn, "session_meta")) {
    try {
      const c = conn.rawQuery(
        `SELECT session_id, title, role_card_id, role_card_name, created_at, updated_at
         FROM session_meta`, []
      );
      while (c.moveToNext()) {
        const s = ensure(c.getString(0), c.getLong(4), c.getLong(5));
        s.title = c.getString(1) || "";
        s.roleCardId = c.getString(2) || "";
        s.roleCardName = c.getString(3) || "";
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 session_meta 失败: " + e.message); }
  }

  if (tableExists(conn, "short_segments")) {
    try {
      const c = conn.rawQuery(
        `SELECT id, scope_type, scope_id, session_id, role, content,
                timestamp, msg_id, created_at
         FROM short_segments ORDER BY timestamp ASC`, []
      );
      while (c.moveToNext()) {
        const sid = c.getString(3);
        const s = ensure(sid, c.getLong(8), c.getLong(8));
        s.segments.push({
          id: c.getLong(0),
          scopeType: c.getString(1) || "session",
          scopeId: c.getString(2) || sid,
          sessionId: sid,
          role: c.getString(4) || "user",
          content: c.getString(5) || "",
          timestamp: c.getLong(6),
          msgId: c.getString(7) || "",
          createdAt: c.getLong(8)
        });
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 short_segments 失败: " + e.message); }
  }

  if (tableExists(conn, "short_blocks")) {
    try {
      const c = conn.rawQuery(
        `SELECT id, scope_type, scope_id, content, source_ids, session_id,
                created_at, updated_at
         FROM short_blocks`, []
      );
      while (c.moveToNext()) {
        const sid = c.getString(5);
        if (!sessions.has(sid)) continue;
        sessions.get(sid)!.shortBlocks.push({
          id: c.getLong(0),
          scopeType: c.getString(1) || "session",
          scopeId: c.getString(2) || sid,
          content: c.getString(3) || "",
          sourceIds: parseIntList(c.getString(4) || ""),
          sessionId: sid,
          createdAt: c.getLong(6)
        });
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 short_blocks 失败: " + e.message); }
  }

  if (tableExists(conn, "mid_blocks")) {
    try {
      const c = conn.rawQuery(
        `SELECT id, scope_type, scope_id, content, state, source_block_ids,
                session_id, created_at, updated_at
         FROM mid_blocks`, []
      );
      while (c.moveToNext()) {
        const sid = c.getString(6);
        if (!sessions.has(sid)) continue;
        sessions.get(sid)!.midBlocks.push({
          id: c.getLong(0),
          scopeType: c.getString(1) || "session",
          scopeId: c.getString(2) || sid,
          content: c.getString(3) || "",
          state: c.getString(4) || "normal",
          sourceBlockIds: parseIntList(c.getString(5) || ""),
          sessionId: sid,
          createdAt: c.getLong(7),
          updatedAt: c.getLong(8)
        });
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 mid_blocks 失败: " + e.message); }
  }

  if (tableExists(conn, "long_blocks")) {
    try {
      const c = conn.rawQuery(
        `SELECT id, scope_type, scope_id, content, state, source_mid_ids,
                session_id, created_at, updated_at
         FROM long_blocks`, []
      );
      while (c.moveToNext()) {
        const sid = c.getString(6);
        if (!sessions.has(sid)) continue;
        sessions.get(sid)!.longBlocks.push({
          id: c.getLong(0),
          scopeType: c.getString(1) || "session",
          scopeId: c.getString(2) || sid,
          content: c.getString(3) || "",
          state: c.getString(4) || "normal",
          sourceMidIds: parseIntList(c.getString(5) || ""),
          sessionId: sid,
          createdAt: c.getLong(7),
          updatedAt: c.getLong(8)
        });
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 long_blocks 失败: " + e.message); }
  }

  if (tableExists(conn, "pending_segments")) {
    try {
      const c = conn.rawQuery(
        `SELECT scope_type, scope_id, session_id, role, content,
                timestamp, msg_id, updated_at
         FROM pending_segments`, []
      );
      while (c.moveToNext()) {
        const sid = c.getString(2);
        if (!sessions.has(sid)) continue;
        sessions.get(sid)!.pendings.push({
          scopeType: c.getString(0) || "session",
          scopeId: c.getString(1) || sid,
          sessionId: sid,
          role: c.getString(3) || "user",
          content: c.getString(4) || "",
          timestamp: c.getLong(5),
          msgId: c.getString(6) || "",
          updatedAt: c.getLong(7)
        });
      }
      c.close();
    } catch (e: any) { logWarn("v3→v4", "读 pending_segments 失败: " + e.message); }
  }

  return Array.from(sessions.values());
}

// ============================================
// v3 → v4
// ============================================

function migrateV3ToV4(conn: any): void {
  logInfo("v3→v4", "开始");

  ensureAllTables(conn);

  let cleared = 0;
  for (const t of ["edges", "nodes", "chain_meta", "message_groups"]) {
    if (tableExists(conn, t)) {
      conn.execSQL(`DELETE FROM ${t}`);
      cleared++;
    }
  }
  logInfo("v3→v4", `清空 ${cleared} 个目标表`);

  const sessions = readV3Data(conn);
  logInfo("v3→v4", `读取 ${sessions.length} 个会话`);

  const now = Date.now();
  let totalMsg = 0, totalBlock = 0, totalSummary = 0, totalEdge = 0;

  for (const s of sessions) {
    let scopeType = "session";
    let scopeId = s.sessionId;
    if (s.segments.length > 0) {
      scopeType = s.segments[0].scopeType || "session";
      scopeId = s.segments[0].scopeId || s.sessionId;
    } else if (s.shortBlocks.length > 0) {
      scopeType = s.shortBlocks[0].scopeType || "session";
      scopeId = s.shortBlocks[0].scopeId || s.sessionId;
    }

    try {
      const c = conn.rawQuery(
        `SELECT 1 FROM session_meta WHERE session_id = ?`, [s.sessionId]
      );
      const exists = c.moveToFirst();
      c.close();
      if (!exists) {
        conn.execSQL(
          `INSERT INTO session_meta
           (session_id, title, role_card_id, role_card_name,
            last_message_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            s.sessionId,
            s.title || "未命名会话",
            s.roleCardId || "",
            s.roleCardName || "",
            s.updatedAt || now,
            s.createdAt || now,
            now
          ]
        );
      }
    } catch (e: any) {
      logWarn("v3→v4", `session_meta 处理失败: ${e.message}`);
    }

    const sortedSegs = s.segments.slice().sort((a, b) => a.timestamp - b.timestamp);
    const segIdMap = new Map<number, number>();
    const newMsgIds: number[] = [];
    let sMsg = 0;

    for (let i = 0; i < sortedSegs.length; i++) {
      const seg = sortedSegs[i];
      conn.execSQL(
        `INSERT INTO nodes
         (node_type, scope_type, scope_id, session_id, role, level, content,
          timestamp, created_at, updated_at, trashed_at, msg_id, seq,
          is_pending, arousal, meta)
         VALUES ('message', ?, ?, ?, ?, '', ?, ?, ?, ?, NULL, ?, ?, 0, 0, '')`,
        [
          scopeType, scopeId, s.sessionId, seg.role,
          seg.content, seg.timestamp, seg.createdAt || now, now,
          seg.msgId || "", i + 1
        ]
      );
      const newId = lastInsertRowId(conn);
      segIdMap.set(seg.id, newId);
      newMsgIds.push(newId);
      sMsg++;
    }

    let sEdge = 0;
    for (let i = 0; i < newMsgIds.length - 1; i++) {
      conn.execSQL(
        `INSERT INTO edges (from_node, to_node, edge_type, weight, last_active_at, created_at)
         VALUES (?, ?, 'time', 1.0, ?, ?)`,
        [newMsgIds[i], newMsgIds[i + 1], now, now]
      );
      sEdge++;
    }

    const sortedShort = s.shortBlocks.slice().sort((a, b) => a.createdAt - b.createdAt);
    const shortIdMap = new Map<number, number>();
    let sBlock = 0;

    for (let i = 0; i < sortedShort.length; i++) {
      const blk = sortedShort[i];
      conn.execSQL(
        `INSERT INTO nodes
         (node_type, scope_type, scope_id, session_id, role, level, content,
          timestamp, created_at, updated_at, trashed_at, msg_id, seq,
          is_pending, arousal, meta)
         VALUES ('block', ?, ?, ?, '', 'short', ?, ?, ?, ?, NULL, '', ?, 0, 0, '')`,
        [
          scopeType, scopeId, s.sessionId,
          blk.content, blk.createdAt, blk.createdAt, now, i + 1
        ]
      );
      const newId = lastInsertRowId(conn);
      shortIdMap.set(blk.id, newId);
      sBlock++;

      for (const srcOldId of blk.sourceIds) {
        const newSrcId = segIdMap.get(srcOldId);
        if (newSrcId === undefined) continue;
        conn.execSQL(
          `INSERT INTO edges (from_node, to_node, edge_type, weight, last_active_at, created_at)
           VALUES (?, ?, 'fold', 1.0, ?, ?)`,
          [newId, newSrcId, now, now]
        );
        sEdge++;
      }
    }

    const sortedMid = s.midBlocks.slice().sort((a, b) => a.createdAt - b.createdAt);
    const midIdMap = new Map<number, number>();
    let sSummary = 0;

    for (let i = 0; i < sortedMid.length; i++) {
      const blk = sortedMid[i];
      const trashedAt = blk.state === "trash" ? blk.updatedAt : null;
      conn.execSQL(
        `INSERT INTO nodes
         (node_type, scope_type, scope_id, session_id, role, level, content,
          timestamp, created_at, updated_at, trashed_at, msg_id, seq,
          is_pending, arousal, meta)
         VALUES ('summary', ?, ?, ?, '', 'mid', ?, ?, ?, ?, ?, '', ?, 0, 0, '')`,
        [
          scopeType, scopeId, s.sessionId,
          blk.content, blk.createdAt, blk.createdAt, now,
          trashedAt, i + 1
        ]
      );
      const newId = lastInsertRowId(conn);
      midIdMap.set(blk.id, newId);
      sSummary++;

      for (const srcOldId of blk.sourceBlockIds) {
        const newSrcId = shortIdMap.get(srcOldId);
        if (newSrcId === undefined) continue;
        conn.execSQL(
          `INSERT INTO edges (from_node, to_node, edge_type, weight, last_active_at, created_at)
           VALUES (?, ?, 'fold', 1.0, ?, ?)`,
          [newId, newSrcId, now, now]
        );
        sEdge++;
      }
    }

    const sortedLong = s.longBlocks.slice().sort((a, b) => a.createdAt - b.createdAt);

    for (let i = 0; i < sortedLong.length; i++) {
      const blk = sortedLong[i];
      const trashedAt = blk.state === "trash" ? blk.updatedAt : null;
      conn.execSQL(
        `INSERT INTO nodes
         (node_type, scope_type, scope_id, session_id, role, level, content,
          timestamp, created_at, updated_at, trashed_at, msg_id, seq,
          is_pending, arousal, meta)
         VALUES ('summary', ?, ?, ?, '', 'long', ?, ?, ?, ?, ?, '', ?, 0, 0, '')`,
        [
          scopeType, scopeId, s.sessionId,
          blk.content, blk.createdAt, blk.createdAt, now,
          trashedAt, i + 1
        ]
      );
      const newId = lastInsertRowId(conn);
      sSummary++;

      for (const srcOldId of blk.sourceMidIds) {
        const newSrcId = midIdMap.get(srcOldId);
        if (newSrcId === undefined) continue;
        conn.execSQL(
          `INSERT INTO edges (from_node, to_node, edge_type, weight, last_active_at, created_at)
           VALUES (?, ?, 'fold', 1.0, ?, ?)`,
          [newId, newSrcId, now, now]
        );
        sEdge++;
      }
    }

    const sortedPending = s.pendings.slice().sort((a, b) => a.timestamp - b.timestamp);
    let seqCounter = sortedSegs.length;

    for (const p of sortedPending) {
      seqCounter++;
      conn.execSQL(
        `INSERT INTO nodes
         (node_type, scope_type, scope_id, session_id, role, level, content,
          timestamp, created_at, updated_at, trashed_at, msg_id, seq,
          is_pending, arousal, meta)
         VALUES ('message', ?, ?, ?, ?, '', ?, ?, ?, ?, NULL, ?, ?, 1, 0, '')`,
        [
          scopeType, scopeId, s.sessionId, p.role,
          p.content, p.timestamp, p.updatedAt || now, now,
          p.msgId || "", seqCounter
        ]
      );
      sMsg++;
    }

    const headSeq = sortedSegs.length + sortedPending.length;
    if (headSeq > 0) {
      const lastMsgId = newMsgIds.length > 0 ? newMsgIds[newMsgIds.length - 1] : 0;
      const firstMsgId = newMsgIds.length > 0 ? newMsgIds[0] : 0;
      conn.execSQL(
        `INSERT OR REPLACE INTO chain_meta
         (scope_type, scope_id, head_id, tail_id, head_seq, message_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [scopeType, scopeId, lastMsgId, firstMsgId, headSeq, headSeq, now]
      );
    }

    logInfo("v3→v4",
      `会话 ${sanId(s.sessionId)}：消息 ${sMsg}，短块 ${sBlock}，` +
      `摘要 ${sSummary}，边 ${sEdge}`);

    totalMsg += sMsg;
    totalBlock += sBlock;
    totalSummary += sSummary;
    totalEdge += sEdge;
  }

  dropLegacyTables(conn);

  logInfo("v3→v4",
    `完成：${totalMsg} 消息，${totalBlock} 短块，` +
    `${totalSummary} 摘要，${totalEdge} 边`);
}

// ============================================
// v4 → v5
// ============================================

function migrateV4ToV5(conn: any): void {
  logInfo("v4→v5", "开始");

  ensureAllTables(conn);

  let config: any = {};
  try {
    const c = conn.rawQuery(
      `SELECT value FROM config WHERE "key" = 'overmem_config'`, []
    );
    if (c.moveToFirst()) config = JSON.parse(c.getString(0) || "{}");
    c.close();
  } catch (_) { config = {}; }

  const globalPass = config.globalPassthrough === true;
  const sessionPass = config.sessionPassthrough === true;

  const personality = {
    mode: config.personalityMode === "manual" ? "manual" : "auto",
    cardId: config.personalityCardId || "",
    name: config.personalityName || "",
    customText: config.personalityCustomText || ""
  };

  const now = Date.now();
  let groupCount = 0;

  if (globalPass) {
    logInfo("v4→v5", "配置：全局共享");

    const gid = "group_global";

    let n = 0;
    try {
      const c = conn.rawQuery(
        `SELECT COUNT(*) FROM nodes WHERE scope_type='global'`, []
      );
      if (c.moveToFirst()) n = c.getInt(0);
      c.close();
    } catch (_) {}

    conn.execSQL(
      `INSERT OR REPLACE INTO message_groups
       (group_id, order_index, name, is_global,
        inclusions_json, exclusions_json, personality_json,
        enabled, created_at, updated_at)
       VALUES (?, 0, '全局', 1,
               '{"roleCards":[],"sessions":[]}',
               '{"roleCards":[],"sessions":[]}',
               ?, 1, ?, ?)`,
      [gid, JSON.stringify(personality), now, now]
    );

    conn.execSQL(
      `UPDATE nodes SET scope_type='group', scope_id=?
       WHERE scope_type='global'`, [gid]
    );
    conn.execSQL(
      `UPDATE chain_meta SET scope_type='group', scope_id=?
       WHERE scope_type='global'`, [gid]
    );

    logInfo("v4→v5", `迁移 ${n} 个 global 节点 → group_global`);
    groupCount = 1;

  } else if (sessionPass) {
    logInfo("v4→v5", "配置：按角色卡共享");

    const rcSet = new Set<string>();
    try {
      const c = conn.rawQuery(
        `SELECT DISTINCT scope_id FROM chain_meta WHERE scope_type='role_card'`, []
      );
      while (c.moveToNext()) rcSet.add(c.getString(0));
      c.close();
    } catch (_) {}

    logInfo("v4→v5", `发现 ${rcSet.size} 个角色卡`);

    let order = 0;
    for (const rc of rcSet) {
      const gid = "group_role:" + rc;

      let cardName = rc;
      try {
        const c = conn.rawQuery(
          `SELECT role_card_name FROM session_meta
           WHERE role_card_id = ? AND role_card_name != '' LIMIT 1`, [rc]
        );
        if (c.moveToFirst()) cardName = c.getString(0) || rc;
        c.close();
      } catch (_) {}

      let n = 0;
      try {
        const c = conn.rawQuery(
          `SELECT COUNT(*) FROM nodes WHERE scope_type='role_card' AND scope_id=?`,
          [rc]
        );
        if (c.moveToFirst()) n = c.getInt(0);
        c.close();
      } catch (_) {}

      conn.execSQL(
        `INSERT OR REPLACE INTO message_groups
         (group_id, order_index, name, is_global,
          inclusions_json, exclusions_json, personality_json,
          enabled, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, '{"roleCards":[],"sessions":[]}', ?, 1, ?, ?)`,
        [
          gid, order, cardName,
          JSON.stringify({ roleCards: [rc], sessions: [] }),
          JSON.stringify(personality), now, now
        ]
      );

      conn.execSQL(
        `UPDATE nodes SET scope_type='group', scope_id=?
         WHERE scope_type='role_card' AND scope_id=?`, [gid, rc]
      );
      conn.execSQL(
        `UPDATE chain_meta SET scope_type='group', scope_id=?
         WHERE scope_type='role_card' AND scope_id=?`, [gid, rc]
      );

      logInfo("v4→v5",
        `角色卡 ${sanId(rc)} → ${sanGroupId(gid)}：` +
        `${n} 个节点，名称 ${sanContent(cardName)}`);

      order++;
    }
    groupCount = rcSet.size;

  } else {
    // config 未指定透传，检查 nodes 里实际的 scope 分布
    logInfo("v4→v5", "配置未指定透传，检查 nodes 实际 scope 分布");

    // 统计
    const roleCardScopes: string[] = [];
    let hasGlobal = false;
    try {
      const c1 = conn.rawQuery(
        `SELECT DISTINCT scope_id FROM nodes WHERE scope_type='role_card'`, []
      );
      while (c1.moveToNext()) roleCardScopes.push(c1.getString(0));
      c1.close();

      const c2 = conn.rawQuery(
        `SELECT 1 FROM nodes WHERE scope_type='global' LIMIT 1`, []
      );
      hasGlobal = c2.moveToFirst();
      c2.close();
    } catch (_) {}

    if (roleCardScopes.length === 0 && !hasGlobal) {
      logInfo("v4→v5", "nodes 里无 role_card / global scope，保持独立会话");
      groupCount = 0;
    } else {
      logInfo("v4→v5",
        `发现 ${roleCardScopes.length} 个 role_card scope，global=${hasGlobal}，按实际分布生成组`);

      let order = 0;

      // 有 global：先建 group_global
      if (hasGlobal) {
        const gid = "group_global";
        let n = 0;
        try {
          const c = conn.rawQuery(
            `SELECT COUNT(*) FROM nodes WHERE scope_type='global'`, []
          );
          if (c.moveToFirst()) n = c.getInt(0);
          c.close();
        } catch (_) {}

        conn.execSQL(
          `INSERT OR REPLACE INTO message_groups
           (group_id, order_index, name, is_global,
            inclusions_json, exclusions_json, personality_json,
            enabled, created_at, updated_at)
           VALUES (?, ?, '全局', 1,
                   '{"roleCards":[],"sessions":[]}',
                   '{"roleCards":[],"sessions":[]}',
                   ?, 1, ?, ?)`,
          [gid, order, JSON.stringify(personality), now, now]
        );

        conn.execSQL(
          `UPDATE nodes SET scope_type='group', scope_id=?
           WHERE scope_type='global'`, [gid]
        );
        conn.execSQL(
          `UPDATE chain_meta SET scope_type='group', scope_id=?
           WHERE scope_type='global'`, [gid]
        );

        logInfo("v4→v5", `迁移 ${n} 个 global 节点 → group_global`);
        order++;
        groupCount = 1;
      }

      // 每个 role_card 建一个组
      for (const rc of roleCardScopes) {
        const gid = "group_role:" + rc;

        let cardName = rc;
        try {
          const c = conn.rawQuery(
            `SELECT role_card_name FROM session_meta
             WHERE role_card_id = ? AND role_card_name != '' LIMIT 1`, [rc]
          );
          if (c.moveToFirst()) cardName = c.getString(0) || rc;
          c.close();
        } catch (_) {}

        let n = 0;
        try {
          const c = conn.rawQuery(
            `SELECT COUNT(*) FROM nodes WHERE scope_type='role_card' AND scope_id=?`,
            [rc]
          );
          if (c.moveToFirst()) n = c.getInt(0);
          c.close();
        } catch (_) {}

        conn.execSQL(
          `INSERT OR REPLACE INTO message_groups
           (group_id, order_index, name, is_global,
            inclusions_json, exclusions_json, personality_json,
            enabled, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, '{"roleCards":[],"sessions":[]}', ?, 1, ?, ?)`,
          [
            gid, order, cardName,
            JSON.stringify({ roleCards: [rc], sessions: [] }),
            JSON.stringify(personality), now, now
          ]
        );

        conn.execSQL(
          `UPDATE nodes SET scope_type='group', scope_id=?
           WHERE scope_type='role_card' AND scope_id=?`, [gid, rc]
        );
        conn.execSQL(
          `UPDATE chain_meta SET scope_type='group', scope_id=?
           WHERE scope_type='role_card' AND scope_id=?`, [gid, rc]
        );

        logInfo("v4→v5",
          `角色卡 ${sanId(rc)} → ${sanGroupId(gid)}：${n} 个节点`);
        order++;
        groupCount++;
      }
    }
  }

  logInfo("v4→v5", `完成，生成 ${groupCount} 个组`);
}

// ============================================
// 步骤表
// ============================================

export const MIGRATION_STEPS: MigrationStep[] = [
  {
    from: DbVersion.V3,
    to: DbVersion.V4,
    name: "v3 → v4（链式结构）",
    run: migrateV3ToV4
  },
  {
    from: DbVersion.V4,
    to: DbVersion.V5,
    name: "v4 → v5（消息组策略）",
    run: migrateV4ToV5
  }
];

export function planMigration(from: DbVersion, target: DbVersion): MigrationStep[] {
  if (from === DbVersion.UNKNOWN) {
    throw new Error("无法识别数据库版本，拒绝迁移");
  }
  if (from === target) return [];

  const steps: MigrationStep[] = [];
  let v: DbVersion = from;
  while (v < target) {
    const step = MIGRATION_STEPS.find(s => s.from === v);
    if (!step) throw new Error(`缺少 v${v} 的迁移步骤`);
    steps.push(step);
    v = step.to;
  }
  return steps;
}

export function runFullMigration(conn: any, from: DbVersion): void {
  const t0 = Date.now();
  const steps = planMigration(from, CURRENT_DB_VERSION);

  if (steps.length === 0) {
    logInfo("Migrate", `无需迁移，当前 v${from}`);
    return;
  }

  logInfo("Migrate", `开始：v${from} → v${CURRENT_DB_VERSION}，共 ${steps.length} 步`);

  conn.execSQL("BEGIN TRANSACTION");
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const ts = Date.now();
      logInfo("Migrate", `步骤 ${i + 1}/${steps.length}：${step.name}`);

      try {
        step.run(conn);
      } catch (e: any) {
        logError("Migrate", `步骤 ${i + 1}/${steps.length} 失败：${sanError(e)}`);
        throw e;
      }

      logInfo("Migrate", `步骤 ${i + 1}/${steps.length} 完成，耗时 ${Date.now() - ts}ms`);
    }

    setUserVersion(conn, CURRENT_DB_VERSION);
    conn.execSQL("COMMIT");

    logInfo("Migrate", `完成：v${from} → v${CURRENT_DB_VERSION}，总耗时 ${Date.now() - t0}ms`);
  } catch (e: any) {
    try { conn.execSQL("ROLLBACK"); } catch (_) {}
    logError("Migrate", `已回滚，版本保持 v${from}`);
    throw e;
  }
}

export function resetToCurrent(conn: any): void {
  const t0 = Date.now();
  logInfo("Reset", "开始重置");

  conn.execSQL("BEGIN TRANSACTION");
  try {
    const allTables = [
      ...LEGACY_TABLES,
      ...EXPECTED_TABLES.map(t => t.name)
    ];
    let dropped = 0;
    for (const name of allTables) {
      if (tableExists(conn, name)) {
        conn.execSQL(`DROP TABLE IF EXISTS ${name}`);
        dropped++;
      }
    }
    logInfo("Reset", `删除 ${dropped} 个表`);

    ensureAllTables(conn);
    setUserVersion(conn, CURRENT_DB_VERSION);
    conn.execSQL("COMMIT");

    logInfo("Reset", `完成，耗时 ${Date.now() - t0}ms`);
  } catch (e: any) {
    try { conn.execSQL("ROLLBACK"); } catch (_) {}
    logError("Reset", `失败：${sanError(e)}`);
    throw e;
  }
}