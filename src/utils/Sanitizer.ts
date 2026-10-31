// utils/Sanitizer.ts
/// <reference path="../../types/index.d.ts" />

let debugMode = false;

/** 由 DatabaseManager 在读取配置后调用 */
export function setSanitizerDebugMode(on: boolean): void {
  debugMode = on === true;
}

export function isSanitizerDebugMode(): boolean {
  return debugMode;
}

/** 短 ID：前 8 位 + …；调试模式返回全 ID */
export function sanId(id: string | null | undefined): string {
  if (!id) return '(empty)';
  if (debugMode) return id;
  return id.length <= 8 ? id : id.substring(0, 8) + '…';
}

/** 组 ID：保留 group_ 前缀语义；调试模式返回全 ID */
export function sanGroupId(gid: string | null | undefined): string {
  if (!gid) return '(empty)';
  if (debugMode) return gid;
  if (gid === 'group_global') return 'group_global';
  if (gid.indexOf('group_role:') === 0) {
    return 'group_role:' + sanId(gid.substring(11));
  }
  return sanId(gid);
}

/** 内容：输出长度；调试模式输出前 500 字 */
export function sanContent(text: string | null | undefined): string {
  if (!text) return '(empty)';
  if (debugMode) {
    return text.length > 500 ? text.substring(0, 500) + '…' : text;
  }
  return `<${text.length} chars>`;
}

/** 路径：只输出文件名；调试模式输出全路径 */
export function sanPath(p: string | null | undefined): string {
  if (!p) return '(empty)';
  if (debugMode) return p;
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? '…/' + p.substring(idx + 1) : p;
}

/** 错误：调试模式输出栈；否则类型 + 前 100 字 */
export function sanError(e: any): string {
  if (!e) return '(unknown)';
  if (debugMode) {
    return e.stack || String(e);
  }
  const name = e.name || (e.constructor && e.constructor.name) || 'Error';
  const msg = e.message || String(e);
  const short = msg.length > 2000 ? msg.substring(0, 2000) + '…' : msg;
  return `${name}: ${short}`;
}