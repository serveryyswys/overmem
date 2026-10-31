// db/DbVersion.ts
/// <reference path="../../types/index.d.ts" />

export enum DbVersion {
  UNKNOWN = 0,
  V3 = 3,
  V4 = 4,
  V5 = 5,
}

export const CURRENT_DB_VERSION = DbVersion.V5;

export function getUserVersion(conn: any): number {
  try {
    const c = conn.rawQuery("PRAGMA user_version", []);
    const v = c.moveToFirst() ? c.getInt(0) : 0;
    c.close();
    return v;
  } catch (_) {
    return 0;
  }
}

export function setUserVersion(conn: any, v: number): void {
  conn.execSQL(`PRAGMA user_version = ${v}`);
}

function tableExists(conn: any, name: string): boolean {
  try {
    const c = conn.rawQuery(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [name]
    );
    const exists = c.moveToFirst();
    c.close();
    return exists;
  } catch (_) {
    return false;
  }
}

/**
 * 只信 user_version。0 返回 UNKNOWN，由调用方判断是全新库还是历史遗留。
 * 不在这里做表结构推断——推断是兜底，只在 UNKNOWN + 有表时用一次。
 */
export function detectDbVersion(conn: any): DbVersion {
  const uv = getUserVersion(conn);
  if (uv >= DbVersion.V5) return DbVersion.V5;
  if (uv === DbVersion.V4) return DbVersion.V4;
  if (uv === DbVersion.V3) return DbVersion.V3;
  return DbVersion.UNKNOWN;
}

/**
 * 表结构推断，仅在 user_version=0 但有表时使用（历史遗留库）。
 * 调用方推断完必须立刻 setUserVersion 回写，下次不再走这里。
 */
export function inferVersionFromSchema(conn: any): DbVersion {
  if (
    tableExists(conn, "short_segments") ||
    tableExists(conn, "short_blocks") ||
    tableExists(conn, "mid_blocks") ||
    tableExists(conn, "long_blocks")
  ) {
    return DbVersion.V3;
  }
  const hasNodes = tableExists(conn, "nodes");
  const hasGroups = tableExists(conn, "message_groups");
  if (hasNodes && hasGroups) return DbVersion.V5;
  if (hasNodes) return DbVersion.V4;
  return DbVersion.UNKNOWN;
}