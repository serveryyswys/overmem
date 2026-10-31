// db/DatabaseManager.ts
/// <reference path="../../types/index.d.ts" />

const fs = require('fs');
const path = require('path');

import {
  SessionMeta, OverMemConfig, ScopeType, BlockStats
} from './models.js';
import { logInfo, logError, logDebug, logWarn } from '../utils/Logger.js';
import { Migration } from './Migration.js';
import {
  DbVersion, CURRENT_DB_VERSION,
  getUserVersion, setUserVersion, inferVersionFromSchema
} from './DbVersion.js';
import { runFullMigration, resetToCurrent } from './MigrationChain.js';
import { MessageGroupManager } from './MessageGroupManager.js';
import { setSanitizerDebugMode, sanPath, sanError } from '../utils/Sanitizer.js';

const DEFAULT_CONFIG: OverMemConfig = {
  shortThreshold: 20,
  midThreshold: 40,
  longThreshold: 20,
  sessionPassthrough: false,
  globalPassthrough: false,
  personalityMode: 'auto',
  personalityCardId: '',
  personalityCustomText: '',
  personalityName: '',
  injectTopN: 5,
  activeRatio: 0.7,
  recallEnabled: true,
  recallBlankProbability: 0.5,
  recallConfuseProbability: 0.2,
  timeEdgeDecayDays: 30,
  foldEdgeBaseWeight: 1.0,
  recallEdgeDecayDays: 60,
  edgeDeathThreshold: 0.05,
  activationSeedWeight: 1.0,
  activationHopDecay: 0.6,
  activationMinThreshold: 0.05,
  debugMode: false,
  previewEnabled: false,
  initTimestamp: 0,
  version: 4,
  noiseTemperature: 0.3,
  synapticFailureEnabled: true,
  lastReplayAt: 0,
  replayIntervalMs: 6 * 60 * 60 * 1000,
  replayMinBatch: 5,
  replayBatchSize: 10,
};

const REQUIRED_TABLES = [
  'config',
  'session_meta',
  'nodes',
  'edges',
  'chain_meta',
  'injection_log',
  'message_groups'
];

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private dbPath: string;
  private connection: any = null;
  private initialized: boolean = false;
  private dbVersion: DbVersion = DbVersion.UNKNOWN;
  private ready: boolean = false;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  public static getInstance(dbPath: string): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager(dbPath);
    }
    return DatabaseManager.instance;
  }

  // ============================================
  // 会话锁（cleanOnExit，Operit 退出时清理）
  // ============================================

  private getSessionLockFile(): string {
    return OPERIT_CLEAN_ON_EXIT_DIR + '/.overmem.sessionlock';
  }

  private isSessionInitialized(): boolean {
    try {
      return fs.existsSync(this.getSessionLockFile());
    } catch (_) {
      return false;
    }
  }

  /**
   * schema 检查成功后调用。
   * 写入后本次 Operit 会话内后续热重载会跳过重量级检查。
   */
  private markSessionInitialized(): void {
    try {
      const file = this.getSessionLockFile();
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(file, String(Date.now()), 'utf8');
    } catch (e: any) {
    }
  }

  // ============================================
  // 生命周期
  // ============================================

  public reopen(): void {
    if (this.connection) {
      try { this.connection.close(); } catch (_) {}
    }
    this.connection = null;
  }

  public closeConnection(): void {
    // no-op
  }

  public close(): void {
    if (this.connection) {
      try { this.connection.close(); } catch (e) {}
      this.connection = null;
    }
  }

  // ============================================
  // 连接
  // ============================================

  public getConnection(): any {
    if (this.connection) {
      try {
        const c = this.connection.rawQuery("SELECT 1", []);
        c.close();
        return this.connection;
      } catch (_) {
        try { this.connection.close(); } catch (_) {}
        this.connection = null;
      }
    }

    try {
      const SQLiteDatabase = Java.type("android.database.sqlite.SQLiteDatabase");
      const File = Java.type("java.io.File");
      const dbFile = new File(this.dbPath);
      this.connection = SQLiteDatabase.openOrCreateDatabase(dbFile, null);
      return this.connection;
    } catch (error: any) {
      logError("DB", `获取连接失败：${sanError(error)}`);
      throw error;
    }
  }

  // ============================================
  // 初始化（轻量检查每次做，schema 检查会话首次做）
  // ============================================

  public initialize(): boolean {
    if (this.initialized) {
      logDebug("DB", "已初始化，跳过");
      return true;
    }

    const t0 = Date.now();
    logInfo("DB", `健康检查：${sanPath(this.dbPath)}`);

    // ---------- 1. 目录 ----------
    try {
      this.ensureDirectory();
    } catch (e: any) {
      logError("DB", `创建目录失败：${sanError(e)}`);
      return false;
    }

    // ---------- 2. 文件存在性 ----------
    const fileExists = this.dbFileExists();
    if (!fileExists) logWarn("DB", "数据库文件不存在，将新建");

    // ---------- 3. 打开连接（失败则备份重建） ----------
    let conn: any = null;
    try {
      conn = this.getConnection();
    } catch (e: any) {
      logError("DB", `打开连接失败：${sanError(e)}`);
      if (!fileExists) {
        this.ready = false;
        this.dbVersion = DbVersion.UNKNOWN;
        this.initialized = true;
        return false;
      }
      logWarn("DB", "文件存在但无法打开，备份后重建");
      if (!this.backupCorruptedFile()) {
        logError("DB", "备份失败，放弃重建");
        this.ready = false;
        this.dbVersion = DbVersion.UNKNOWN;
        this.initialized = true;
        return false;
      }
      try {
        this.connection = null;
        conn = this.getConnection();
        logInfo("DB", "已重建空数据库");
      } catch (e2: any) {
        logError("DB", `重建失败：${sanError(e2)}`);
        this.ready = false;
        this.dbVersion = DbVersion.UNKNOWN;
        this.initialized = true;
        return false;
      }
    }

    // ---------- 4. 读 user_version + 缺表情况 ----------
    const userVer = getUserVersion(conn);
    const missing = this.checkRequiredTables(conn);
    logInfo("DB",
      `user_version=${userVer}，缺失表 ${missing.length}/${REQUIRED_TABLES.length}`);

    // ============================================
    // 分支 A：全新安装（user_version=0 + 一个表都没有）
    // ============================================
    if (userVer === 0 && missing.length === REQUIRED_TABLES.length) {
      logInfo("DB", "全新安装，建 schema 并写入 user_version");
      try {
        Migration.ensureSchema(conn);
        setUserVersion(conn, CURRENT_DB_VERSION);
        this.initDefaultConfig();
      } catch (e: any) {
        logError("DB", `全新安装失败：${sanError(e)}`);
        this.ready = false;
        this.dbVersion = DbVersion.UNKNOWN;
        this.initialized = true;
        return false;
      }

      this.markSessionInitialized();
      this.dbVersion = CURRENT_DB_VERSION;
      this.ready = true;

      try {
        const cfg = this.getConfig();
        setSanitizerDebugMode(cfg.debugMode === true);
      } catch (_) {
        setSanitizerDebugMode(false);
      }

      this.initialized = true;
      logInfo("DB",
        `健康检查完成：全新库 v${CURRENT_DB_VERSION}，就绪，耗时 ${Date.now() - t0}ms`);
      return true;
    }

    // ============================================
    // 分支 B：历史遗留（user_version=0 但有部分表）
    // 推断一次 → 回写 → 下次不再推断
    // ============================================
    if (userVer === 0 && missing.length < REQUIRED_TABLES.length) {
      logWarn("DB", "user_version=0 但有表，按表结构推断版本");
      try {
        // 1. 先在补建表之前推断版本（基于现有表）
        const inferred = inferVersionFromSchema(conn);
        logInfo("DB", `推断为 v${inferred}（补建前）`);

        // 2. 补建缺失表（不动 user_version）
        Migration.ensureSchema(conn);

        // 3. 写回推断版本（不是补建后的）
        setUserVersion(conn, inferred);
        this.dbVersion = inferred;
        this.ready = (inferred === CURRENT_DB_VERSION);

        if (inferred !== DbVersion.V3) {
          this.initDefaultConfig();
        }

        try {
          const cfg = this.getConfig();
          setSanitizerDebugMode(cfg.debugMode === true);
        } catch (_) {
          setSanitizerDebugMode(false);
        }

        this.markSessionInitialized();
        logInfo("DB",
          `健康检查完成：推断为 v${inferred}，已回写 user_version，耗时 ${Date.now() - t0}ms`);
      } catch (e: any) {
        logError("DB", `历史遗留库处理失败：${sanError(e)}`);
        this.ready = false;
        this.dbVersion = DbVersion.UNKNOWN;
      }
      this.initialized = true;
      return true;
    }

    // ============================================
    // 分支 C：正常版本（user_version ∈ {3,4,5}）
    // ============================================
    this.dbVersion = userVer as DbVersion;
    logInfo("DB", `检测版本 v${userVer}`);

    // C-1：v3 不碰数据
    if (userVer === DbVersion.V3) {
      this.ready = false;
      this.initialized = true;
      try {
        const cfg = this.getConfig();
        setSanitizerDebugMode(cfg.debugMode === true);
      } catch (_) {
        setSanitizerDebugMode(false);
      }
      logInfo("DB",
        `健康检查完成：v3，待迁移，耗时 ${Date.now() - t0}ms`);
      return true;
    }

    // C-2：v4 / v5 —— 需要时补 schema，但绝不写 user_version
    const sessionInitialized = this.isSessionInitialized();
    const needSchemaCheck = !sessionInitialized || missing.length > 0;

    if (needSchemaCheck) {
      logInfo("DB", "补建 schema（不动 user_version）");
      try {
        Migration.ensureSchema(conn);
      } catch (e: any) {
        logError("DB", `schema 修复失败：${sanError(e)}`);
        this.ready = false;
        this.initialized = true;
        return false;
      }
      if (!sessionInitialized) this.markSessionInitialized();
    } else {
      logDebug("DB", "本次会话已检查过 schema，跳过");
    }

    this.initDefaultConfig();

    try {
      const cfg = this.getConfig();
      setSanitizerDebugMode(cfg.debugMode === true);
    } catch (_) {
      setSanitizerDebugMode(false);
    }

    this.ready = (userVer === CURRENT_DB_VERSION);
    this.initialized = true;
    logInfo("DB",
      `健康检查完成：v${userVer}，状态：${this.ready ? '就绪' : '待迁移'}，` +
      `耗时 ${Date.now() - t0}ms`);
    return true;
  }

  // ============================================
  // 自愈辅助
  // ============================================

  private dbFileExists(): boolean {
    try {
      const File = Java.type("java.io.File");
      return new File(this.dbPath).exists();
    } catch (_) {
      return false;
    }
  }

  private checkRequiredTables(conn: any): string[] {
    const missing: string[] = [];
    try {
      const c = conn.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table'", []
      );
      const existing = new Set<string>();
      while (c.moveToNext()) existing.add(c.getString(0));
      c.close();
      for (const t of REQUIRED_TABLES) {
        if (!existing.has(t)) missing.push(t);
      }
    } catch (e: any) {
      logError("DB", `查询表列表失败：${sanError(e)}`);
    }
    return missing;
  }

  private backupCorruptedFile(): boolean {
    try {
      const File = Java.type("java.io.File");
      const src = new File(this.dbPath);
      if (!src.exists()) return false;

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = new File(this.dbPath + '.corrupted.' + stamp);
      const ok = src.renameTo(backup);
      if (ok) {
        logWarn("DB", `损坏文件已备份：${sanPath(backup.getAbsolutePath())}`);
      }
      return ok;
    } catch (e: any) {
      logError("DB", `备份损坏文件失败：${sanError(e)}`);
      return false;
    }
  }

  public isReady(): boolean { return this.ready; }
  public getDbVersion(): DbVersion { return this.dbVersion; }

  /** @deprecated 用 getDbVersion() === DbVersion.V3 替代 */
  public checkLegacyV3(): boolean {
    return this.dbVersion === DbVersion.V3;
  }

  public markReady(): void {
    this.ready = true;
    this.dbVersion = CURRENT_DB_VERSION;
  }

  public runMigration(): void {
    const conn = this.getConnection();
    logInfo("DB", `触发迁移，当前 v${this.dbVersion}`);
    runFullMigration(conn, this.dbVersion);
    this.markReady();
    logInfo("DB", `迁移完成，当前 v${CURRENT_DB_VERSION}`);
  }

  public resetDatabase(): void {
    const conn = this.getConnection();
    logInfo("DB", "触发重置");
    resetToCurrent(conn);
    this.initDefaultConfig();
    this.markReady();
    logInfo("DB", `重置完成，当前 v${CURRENT_DB_VERSION}`);
  }

  /** @deprecated 用 resetDatabase() 替代，仅为 LegacyWarningState 保留 */
  public forceMigrateToV4(): boolean {
    try {
      this.resetDatabase();
      return true;
    } catch (e: any) {
      logError("DB", `forceMigrateToV4 失败：${sanError(e)}`);
      return false;
    }
  }

  private ensureDirectory(): void {
    const File = Java.type("java.io.File");
    const dir = new File(this.dbPath.substring(0, this.dbPath.lastIndexOf('/')));
    if (!dir.exists()) dir.mkdirs();
  }

  private initDefaultConfig(): void {
    try {
      const conn = this.getConnection();
      const cursor = conn.rawQuery("SELECT COUNT(*) FROM config", []);
      let count = 0;
      if (cursor.moveToFirst()) count = cursor.getInt(0);
      cursor.close();

      if (count === 0) {
        const now = Date.now();
        const cfg = { ...DEFAULT_CONFIG, initTimestamp: now };
        conn.execSQL(
          "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)",
          ['overmem_config', JSON.stringify(cfg), now]
        );
        logInfo("DB", "写入默认配置");
      }
    } catch (error: any) {
      logError("DB", `初始化配置失败：${sanError(error)}`);
    }
  }

  // ============================================
  // 配置
  // ============================================

  public getConfig(): OverMemConfig {
    try {
      const conn = this.getConnection();
      const cursor = conn.rawQuery("SELECT value FROM config WHERE key = ?", ['overmem_config']);
      if (cursor.moveToFirst()) {
        const json = cursor.getString(0);
        cursor.close();
        return { ...DEFAULT_CONFIG, ...JSON.parse(json) };
      }
      cursor.close();
      return { ...DEFAULT_CONFIG };
    } catch (error: any) {
      logError("DB", `读取配置失败：${sanError(error)}`);
      return { ...DEFAULT_CONFIG };
    }
  }

  public saveConfig(config: OverMemConfig): boolean {
    try {
      const conn = this.getConnection();
      const now = Date.now();
      conn.execSQL(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ['overmem_config', JSON.stringify(config), now]
      );
      setSanitizerDebugMode(config.debugMode === true);
      return true;
    } catch (error: any) {
      logError("DB", `保存配置失败：${sanError(error)}`);
      return false;
    }
  }

  // ============================================
  // 作用域（消息组策略）
  // ============================================

  public getScope(sessionId: string, roleCardId: string): { type: ScopeType; id: string } {
    if (!this.ready) {
      logDebug("Scope", "未就绪，降级为 session");
      return { type: 'session', id: sessionId };
    }

    const group = MessageGroupManager.getInstance(this).resolve(sessionId, roleCardId);
    if (group) {
      logDebug("Scope", `命中 ${group.groupId}`);
      return { type: 'group', id: group.groupId };
    }
    logDebug("Scope", "未命中，降级为 session");
    return { type: 'session', id: sessionId };
  }

  // ============================================
  // 会话元数据
  // ============================================

  public getOrCreateSessionMeta(
    sessionId: string, title?: string,
    roleCardId?: string, roleCardName?: string
  ): SessionMeta {
    const conn = this.getConnection();
    const cursor = conn.rawQuery("SELECT * FROM session_meta WHERE session_id = ?", [sessionId]);
    if (cursor.moveToFirst()) {
      const meta: SessionMeta = {
        sessionId: cursor.getString(0),
        title: cursor.getString(1) || '',
        roleCardId: cursor.getString(2) || '',
        roleCardName: cursor.getString(3) || '',
        lastMessageAt: cursor.getLong(4),
        createdAt: cursor.getLong(5),
        updatedAt: cursor.getLong(6)
      };
      cursor.close();

      let needUpdate = false;
      if (title && title !== meta.title) { meta.title = title; needUpdate = true; }
      if (roleCardId && roleCardId !== meta.roleCardId) {
        meta.roleCardId = roleCardId;
        meta.roleCardName = roleCardName || meta.roleCardName;
        needUpdate = true;
      }
      if (needUpdate) this.updateSessionMeta(meta);
      return meta;
    }
    cursor.close();

    const now = Date.now();
    const finalTitle = title || '未命名会话';
    const finalCardId = roleCardId || '';
    const finalCardName = roleCardName || '';
    conn.execSQL(
      `INSERT INTO session_meta (session_id, title, role_card_id, role_card_name, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, finalTitle, finalCardId, finalCardName, now, now, now]
    );
    return {
      sessionId, title: finalTitle,
      roleCardId: finalCardId, roleCardName: finalCardName,
      lastMessageAt: now, createdAt: now, updatedAt: now
    };
  }

  public updateSessionMeta(meta: SessionMeta): void {
    try {
      const conn = this.getConnection();
      const now = Date.now();
      conn.execSQL(
        `UPDATE session_meta SET title=?, role_card_id=?, role_card_name=?, last_message_at=?, updated_at=? WHERE session_id=?`,
        [meta.title, meta.roleCardId, meta.roleCardName, meta.lastMessageAt || now, now, meta.sessionId]
      );
    } catch (e: any) {
      logError("DB", `updateSessionMeta 失败：${sanError(e)}`);
    }
  }

  public getSessionMeta(sessionId: string): SessionMeta | null {
    try {
      const conn = this.getConnection();
      const cursor = conn.rawQuery("SELECT * FROM session_meta WHERE session_id = ?", [sessionId]);
      if (cursor.moveToFirst()) {
        const meta: SessionMeta = {
          sessionId: cursor.getString(0),
          title: cursor.getString(1) || '',
          roleCardId: cursor.getString(2) || '',
          roleCardName: cursor.getString(3) || '',
          lastMessageAt: cursor.getLong(4),
          createdAt: cursor.getLong(5),
          updatedAt: cursor.getLong(6)
        };
        cursor.close();
        return meta;
      }
      cursor.close();
      return null;
    } catch (e: any) {
      return null;
    }
  }

  public getAllSessionMeta(): SessionMeta[] {
    try {
      const conn = this.getConnection();
      const cursor = conn.rawQuery(
        "SELECT session_id, title, role_card_id, role_card_name, last_message_at, created_at, updated_at FROM session_meta ORDER BY updated_at DESC",
        []
      );
      const out: SessionMeta[] = [];
      while (cursor.moveToNext()) {
        out.push({
          sessionId: cursor.getString(0),
          title: cursor.getString(1) || '',
          roleCardId: cursor.getString(2) || '',
          roleCardName: cursor.getString(3) || '',
          lastMessageAt: cursor.getLong(4),
          createdAt: cursor.getLong(5),
          updatedAt: cursor.getLong(6)
        });
      }
      cursor.close();
      return out;
    } catch (e: any) {
      return [];
    }
  }

  // ============================================
  // 注入日志（幂等）
  // ============================================

  public logInjection(messageId: string, nodeId: number): boolean {
    if (!messageId) return true;
    try {
      const conn = this.getConnection();
      const cursor = conn.rawQuery(
        `SELECT 1 FROM injection_log WHERE message_id=? AND node_id=? LIMIT 1`,
        [messageId, nodeId]
      );
      const exists = cursor.moveToFirst();
      cursor.close();
      if (exists) return false;

      conn.execSQL(
        `INSERT INTO injection_log (message_id, node_id, injected_at) VALUES (?, ?, ?)`,
        [messageId, nodeId, Date.now()]
      );
      return true;
    } catch (e: any) {
      logError("DB", `logInjection 失败：${sanError(e)}`);
      return false;
    }
  }

  // ============================================
  // 统计
  // ============================================

  public getStats(scopeType: ScopeType, scopeId: string): BlockStats {
    try {
      const conn = this.getConnection();

      const c1 = conn.rawQuery(
        `SELECT COUNT(*) FROM nodes WHERE scope_type=? AND scope_id=? AND node_type='message'`,
        [scopeType, scopeId]
      );
      const totalMessages = c1.moveToFirst() ? c1.getInt(0) : 0;
      c1.close();

      const c2 = conn.rawQuery(
        `SELECT COUNT(*) FROM nodes WHERE scope_type=? AND scope_id=? AND node_type='block' AND trashed_at IS NULL`,
        [scopeType, scopeId]
      );
      const totalBlocks = c2.moveToFirst() ? c2.getInt(0) : 0;
      c2.close();

      const c3 = conn.rawQuery(
        `SELECT COUNT(*) FROM nodes WHERE scope_type=? AND scope_id=? AND node_type='summary' AND level='mid' AND trashed_at IS NULL`,
        [scopeType, scopeId]
      );
      const totalMid = c3.moveToFirst() ? c3.getInt(0) : 0;
      c3.close();

      const c4 = conn.rawQuery(
        `SELECT COUNT(*) FROM nodes WHERE scope_type=? AND scope_id=? AND node_type='summary' AND level='long' AND trashed_at IS NULL`,
        [scopeType, scopeId]
      );
      const totalLong = c4.moveToFirst() ? c4.getInt(0) : 0;
      c4.close();

      const since = Date.now() - 7 * 24 * 3600 * 1000;
      const c5 = conn.rawQuery(
        `SELECT COUNT(DISTINCT n.id) FROM nodes n
         JOIN edges e ON (e.from_node=n.id OR e.to_node=n.id)
         WHERE n.scope_type=? AND n.scope_id=?
           AND n.node_type IN ('block','summary')
           AND e.edge_type IN ('time','recall')
           AND e.last_active_at >= ?`,
        [scopeType, scopeId, since]
      );
      const totalActive = c5.moveToFirst() ? c5.getInt(0) : 0;
      c5.close();

      return {
        totalMessages,
        totalBlocks,
        totalMidBlocks: totalMid,
        totalLongBlocks: totalLong,
        totalActiveNodes: totalActive
      };
    } catch (e: any) {
      return {
        totalMessages: 0, totalBlocks: 0,
        totalMidBlocks: 0, totalLongBlocks: 0, totalActiveNodes: 0
      };
    }
  }
}