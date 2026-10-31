// db/MessageGroupManager.ts
/// <reference path="../../types/index.d.ts" />

import { DatabaseManager } from './DatabaseManager.js';
import { MessageGroup } from './models.js';
import { logInfo, logError, logDebug } from '../utils/Logger.js';
import { sanId, sanGroupId, sanError } from '../utils/Sanitizer.js';

export class MessageGroupManager {
  private static instance: MessageGroupManager | null = null;
  private db: DatabaseManager;

  private constructor(db: DatabaseManager) {
    this.db = db;
  }

  public static getInstance(db: DatabaseManager): MessageGroupManager {
    if (!MessageGroupManager.instance) {
      MessageGroupManager.instance = new MessageGroupManager(db);
    }
    return MessageGroupManager.instance;
  }

  // ============================================
  // 策略解析
  // ============================================

  public resolve(sessionId: string, roleCardId: string): MessageGroup | null {
    const groups = this.listEnabled();
    for (const g of groups) {
      if (this.matchesExclusion(g, sessionId, roleCardId)) {
        logDebug("Group", `会话 ${sanId(sessionId)} 命中组 ${sanGroupId(g.groupId)} 的排除`);
        continue;
      }
      if (this.matchesInclusion(g, sessionId, roleCardId)) {
        logDebug("Group", `会话 ${sanId(sessionId)} 命中组 ${sanGroupId(g.groupId)}`);
        return g;
      }
    }
    return null;
  }

  private matchesInclusion(g: MessageGroup, s: string, r: string): boolean {
    if (g.isGlobal) return true;
    if (r && g.inclusions.roleCards.indexOf(r) >= 0) return true;
    if (g.inclusions.sessions.indexOf(s) >= 0) return true;
    return false;
  }

  private matchesExclusion(g: MessageGroup, s: string, r: string): boolean {
    if (r && g.exclusions.roleCards.indexOf(r) >= 0) return true;
    if (g.exclusions.sessions.indexOf(s) >= 0) return true;
    return false;
  }

  // ============================================
  // 有效性判定
  // ============================================

  public isValid(g: MessageGroup): boolean {
    return this.describeInvalid(g) === '';
  }

  public describeInvalid(g: MessageGroup): string {
    const hasRole = g.inclusions.roleCards.length > 0;
    const hasSession = g.inclusions.sessions.length > 0;

    if (g.isGlobal && (hasRole || hasSession)) {
      return 'global 与其他包含项共存';
    }
    if (!g.isGlobal && !hasRole && !hasSession) {
      return '缺少包含项';
    }
    if (!g.isGlobal) {
      const roleCovered =
        g.inclusions.roleCards.every(r => g.exclusions.roleCards.indexOf(r) >= 0);
      const sessionCovered =
        g.inclusions.sessions.every(s => g.exclusions.sessions.indexOf(s) >= 0);
      if (roleCovered && sessionCovered) {
        return '包含项被排除项完全覆盖';
      }
    }
    return '';
  }

  // ============================================
  // 读写
  // ============================================

  public listAll(): MessageGroup[] {
    try {
      const conn = this.db.getConnection();
      const cursor = conn.rawQuery(
        `SELECT group_id, order_index, name, is_global,
                inclusions_json, exclusions_json, personality_json,
                enabled, created_at, updated_at
         FROM message_groups ORDER BY order_index ASC`,
        []
      );
      const out: MessageGroup[] = [];
      while (cursor.moveToNext()) out.push(this.rowToGroup(cursor));
      cursor.close();
      return out;
    } catch (e: any) {
      logError("Group", `读取全部组失败：${sanError(e)}`);
      return [];
    }
  }

  public listEnabled(): MessageGroup[] {
    const all = this.listAll();
    const out: MessageGroup[] = [];
    for (const g of all) {
      if (!g.enabled) {
        logDebug("Group", `跳过 ${sanGroupId(g.groupId)}：未启用`);
        continue;
      }
      const reason = this.describeInvalid(g);
      if (reason) {
        logDebug("Group", `跳过 ${sanGroupId(g.groupId)}：${reason}`);
        continue;
      }
      out.push(g);
    }
    return out;
  }

  public getById(groupId: string): MessageGroup | null {
    try {
      const conn = this.db.getConnection();
      const cursor = conn.rawQuery(
        `SELECT group_id, order_index, name, is_global,
                inclusions_json, exclusions_json, personality_json,
                enabled, created_at, updated_at
         FROM message_groups WHERE group_id = ?`,
        [groupId]
      );
      if (cursor.moveToFirst()) {
        const g = this.rowToGroup(cursor);
        cursor.close();
        return g;
      }
      cursor.close();
      return null;
    } catch (e: any) {
      logError("Group", `读取 ${sanGroupId(groupId)} 失败：${sanError(e)}`);
      return null;
    }
  }

  public upsert(g: MessageGroup): boolean {
    try {
      const conn = this.db.getConnection();
      const now = Date.now();
      conn.execSQL(
        `INSERT OR REPLACE INTO message_groups
         (group_id, order_index, name, is_global,
          inclusions_json, exclusions_json, personality_json,
          enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.groupId,
          g.orderIndex,
          g.name,
          g.isGlobal ? 1 : 0,
          JSON.stringify(g.inclusions),
          JSON.stringify(g.exclusions),
          JSON.stringify(g.personality),
          g.enabled ? 1 : 0,
          g.createdAt || now,
          now
        ]
      );
      logInfo("Group", `保存 ${sanGroupId(g.groupId)}，order=${g.orderIndex}`);
      return true;
    } catch (e: any) {
      logError("Group", `保存 ${sanGroupId(g.groupId)} 失败：${sanError(e)}`);
      return false;
    }
  }

  public delete(groupId: string): boolean {
    try {
      const conn = this.db.getConnection();
      conn.execSQL(`DELETE FROM message_groups WHERE group_id = ?`, [groupId]);
      logInfo("Group", `删除 ${sanGroupId(groupId)}`);
      return true;
    } catch (e: any) {
      logError("Group", `删除 ${sanGroupId(groupId)} 失败：${sanError(e)}`);
      return false;
    }
  }

  public reorder(orderedIds: string[]): void {
    try {
      const conn = this.db.getConnection();
      const now = Date.now();
      for (let i = 0; i < orderedIds.length; i++) {
        conn.execSQL(
          `UPDATE message_groups SET order_index=?, updated_at=? WHERE group_id=?`,
          [i, now, orderedIds[i]]
        );
      }
      logInfo("Group", `重排 ${orderedIds.length} 个组`);
    } catch (e: any) {
      logError("Group", `重排失败：${sanError(e)}`);
    }
  }

  // ============================================
  // 行映射
  // ============================================

  private rowToGroup(cursor: any): MessageGroup {
    let inclusions: any = { roleCards: [], sessions: [] };
    let exclusions: any = { roleCards: [], sessions: [] };
    let personality: any = { mode: 'auto', cardId: '', name: '', customText: '' };
    try { inclusions = JSON.parse(cursor.getString(4) || '{}'); } catch (_) {}
    try { exclusions = JSON.parse(cursor.getString(5) || '{}'); } catch (_) {}
    try { personality = JSON.parse(cursor.getString(6) || '{}'); } catch (_) {}

    return {
      groupId: cursor.getString(0),
      orderIndex: cursor.getInt(1),
      name: cursor.getString(2) || '',
      isGlobal: cursor.getInt(3) === 1,
      inclusions: {
        roleCards: Array.isArray(inclusions.roleCards) ? inclusions.roleCards : [],
        sessions: Array.isArray(inclusions.sessions) ? inclusions.sessions : []
      },
      exclusions: {
        roleCards: Array.isArray(exclusions.roleCards) ? exclusions.roleCards : [],
        sessions: Array.isArray(exclusions.sessions) ? exclusions.sessions : []
      },
      personality: {
        mode: personality.mode === 'manual' ? 'manual' : 'auto',
        cardId: personality.cardId || '',
        name: personality.name || '',
        customText: personality.customText || ''
      },
      enabled: cursor.getInt(7) === 1,
      createdAt: cursor.getLong(8),
      updatedAt: cursor.getLong(9)
    };
  }
}