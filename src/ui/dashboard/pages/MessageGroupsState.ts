// ui/dashboard/pages/MessageGroupsState.ts
/// <reference path="../../../../types/index.d.ts" />

import { DashboardState } from '../DashboardState.js';
import { DatabaseManager } from '../../../db/DatabaseManager.js';
import { MessageGroupManager } from '../../../db/MessageGroupManager.js';
import {
  MessageGroup, MessageGroupInclusions, MessageGroupExclusions,
  MessageGroupPersonality, SessionMeta
} from '../../../db/models.js';
import { PersonalityHelper } from '../../../utils/PersonalityHelper.js';
import { logInfo, logError, logDebug } from '../../../utils/Logger.js';
import { sanError } from '../../../utils/Sanitizer.js';

declare function toolCall(name: string, params?: any): Promise<any>;

export interface GroupWithReason {
  group: MessageGroup;
  invalidReason: string;
}

export interface MessageGroupsUiState {
  loading: boolean;
  groups: GroupWithReason[];
  cards: { id: string; name: string }[];
  sessions: SessionMeta[];
  error: string;
}

export interface MessageGroupEditUiState {
  isNew: boolean;
  draft: MessageGroup;
  cards: { id: string; name: string }[];
  sessions: SessionMeta[];
  invalidReason: string;
  hitCount: number;
  hitSessionPreviews: string[];
  sessionSearch: string;
}

export function cloneGroup(g: MessageGroup): MessageGroup {
  return {
    groupId: g.groupId,
    orderIndex: g.orderIndex,
    name: g.name,
    isGlobal: g.isGlobal,
    inclusions: {
      roleCards: g.inclusions.roleCards.slice(),
      sessions: g.inclusions.sessions.slice()
    },
    exclusions: {
      roleCards: g.exclusions.roleCards.slice(),
      sessions: g.exclusions.sessions.slice()
    },
    personality: {
      mode: g.personality.mode,
      cardId: g.personality.cardId,
      name: g.personality.name,
      customText: g.personality.customText
    },
    enabled: g.enabled,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt
  };
}

export class MessageGroupsStateHolder {
  private dashboard: DashboardState;
  private dbPath: string;

  private listState: MessageGroupsUiState = {
    loading: false,
    groups: [],
    cards: [],
    sessions: [],
    error: ''
  };

  private editState: MessageGroupEditUiState | null = null;

  private loading: boolean = false;

  constructor(dashboard: DashboardState, dbPath: string) {
    this.dashboard = dashboard;
    this.dbPath = dbPath;
  }

  get(): MessageGroupsUiState { return this.listState; }

  getEdit(): MessageGroupEditUiState | null { return this.editState; }

  private db(): DatabaseManager {
    return DatabaseManager.getInstance(this.dbPath);
  }

  private manager(): MessageGroupManager {
    return MessageGroupManager.getInstance(this.db());
  }

  private patchList(p: Partial<MessageGroupsUiState>): void {
    this.listState = { ...this.listState, ...p };
    this.dashboard.notify();
  }

  // ============================================
  // 列表
  // ============================================

  /**
   * 同步加载：组与会话同步读取后立即 notify，角色卡异步补齐后再 notify 一次。
   * notify() 必须在同步路径触发，await 之后的 notify 在宿主里不生效。
   */
  load(): void {
    if (this.loading) {
      logDebug("MessageGroups", "已在加载中，跳过");
      return;
    }
    this.loading = true;

    // ---- 1. 同步加载本地已有数据 ----
    try {
      const db = this.db();
      const mgr = this.manager();
      const groups: GroupWithReason[] = mgr.listAll().map((g) => ({
        group: g,
        invalidReason: mgr.describeInvalid(g)
      }));
      const dbSessions = db.getAllSessionMeta();

      this.listState = {
        ...this.listState,
        loading: false,
        groups,
        sessions: dbSessions,
        error: ''
      };
      logInfo("MessageGroups",
        `同步加载完成：${groups.length} 组，${dbSessions.length} 本地会话`);
    } catch (e: any) {
      this.listState = {
        ...this.listState,
        loading: false,
        error: sanError(e)
      };
      logError("MessageGroups", `同步加载失败: ${sanError(e)}`);
      this.loading = false;
      this.dashboard.notify();
      return;
    }

    // 立即 notify，界面在导航回调的同步路径里重绘
    this.dashboard.notify();

    // ---- 2. 异步加载角色卡 + 全量会话 ----
    const helper = PersonalityHelper.getInstance();
    const cardsPromise = this.listState.cards.length === 0
      ? helper.getCharacterCardBriefs().catch((e: any) => {
          logError("MessageGroups", `角色卡加载失败: ${sanError(e)}`);
          return null;
        })
      : Promise.resolve(null);

    const chatsPromise = (async () => {
      try {
        const result: any = await toolCall('list_chats', {});
        let chats: any[] = [];
        if (result && result.chats && Array.isArray(result.chats)) chats = result.chats;
        else if (result && result.data && result.data.chats && Array.isArray(result.data.chats)) chats = result.data.chats;
        else if (Array.isArray(result)) chats = result;
        return chats;
      } catch (e: any) {
        logError("MessageGroups", `list_chats 失败: ${sanError(e)}`);
        return [];
      }
    })();

    Promise.all([cardsPromise, chatsPromise])
      .then(([briefs, chats]) => {
        // 合并会话：list_chats 为准，session_meta 覆盖（后者 roleCardId 更准）
        const map = new Map<string, SessionMeta>();
        for (const c of chats) {
          const id = c.id || c.chatId || c.chat_id || '';
          if (!id) continue;
          map.set(id, {
            sessionId: id,
            title: c.title || '未命名会话',
            roleCardId: c.characterCardId || c.character_card_id || '',
            roleCardName: c.characterCardName || c.character_card_name || '',
            lastMessageAt: 0,
            createdAt: 0,
            updatedAt: 0
          });
        }
        for (const s of this.listState.sessions) {
          map.set(s.sessionId, s);
        }
        const mergedSessions = Array.from(map.values());
        // 按 title 排序，方便搜索
        mergedSessions.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        const cards = briefs
          ? briefs.map((b) => ({ id: b.id, name: b.name || b.id }))
          : this.listState.cards;

        this.listState = {
          ...this.listState,
          cards,
          sessions: mergedSessions
        };

        // 如果用户已经在编辑页，同步更新
        if (this.editState) {
          this.editState = {
            ...this.editState,
            cards,
            sessions: mergedSessions,
          };
          this.refreshHits();
        }

        logInfo("MessageGroups",
          `异步加载完成：${cards.length} 卡，${mergedSessions.length} 会话`);
        this.dashboard.notify();
      })
      .catch((e: any) => {
        logError("MessageGroups", `异步加载失败: ${sanError(e)}`);
      })
      .finally(() => {
        this.loading = false;
      });
  }

  // ============================================
  // 编辑草稿
  // ============================================

  /** 同步绑定编辑草稿：返回前 editState 已就绪，同一帧即可渲染。 */
  bindEdit(groupId: string | null): void {
    const cards = this.listState.cards;
    const sessions = this.listState.sessions;
    const mgr = this.manager();

    if (groupId === null) {
      let maxOrder = -1;
      for (const g of mgr.listAll()) {
        if (g.orderIndex > maxOrder) maxOrder = g.orderIndex;
      }
      const now = Date.now();
      const draft: MessageGroup = {
        groupId: this.newGroupId(),
        orderIndex: maxOrder + 1,
        name: '',
        isGlobal: false,
        inclusions: { roleCards: [], sessions: [] },
        exclusions: { roleCards: [], sessions: [] },
        personality: { mode: 'auto', cardId: '', name: '', customText: '' },
        enabled: true,
        createdAt: now,
        updatedAt: now
      };
      this.editState = {
        isNew: true,
        draft,
        cards,
        sessions,
        sessionSearch: '',
        invalidReason: mgr.describeInvalid(draft),
        hitCount: 0,
        hitSessionPreviews: []
      };
      this.refreshHits();
      this.dashboard.notify();
      return;
    }

    const g = mgr.getById(groupId);
    if (!g) {
      this.editState = null;
      this.dashboard.showBanner('组不存在', 'error');
      this.dashboard.notify();
      return;
    }

    this.editState = {
      isNew: false,
      draft: cloneGroup(g),
      cards,
      sessions,
      sessionSearch: '',
      invalidReason: mgr.describeInvalid(g),
      hitCount: 0,
      hitSessionPreviews: []
    };
    this.refreshHits();
    this.dashboard.notify();
  }

  patchEdit(p: Partial<MessageGroup>): void {
    if (!this.editState) return;
    this.editState.draft = { ...this.editState.draft, ...p };
    this.recomputeInvalid();
  }

  patchInclusions(p: Partial<MessageGroupInclusions>): void {
    if (!this.editState) return;
    this.editState.draft = {
      ...this.editState.draft,
      inclusions: { ...this.editState.draft.inclusions, ...p }
    };
    this.recomputeInvalid();
  }

  patchExclusions(p: Partial<MessageGroupExclusions>): void {
    if (!this.editState) return;
    this.editState.draft = {
      ...this.editState.draft,
      exclusions: { ...this.editState.draft.exclusions, ...p }
    };
    this.recomputeInvalid();
  }

  patchPersonality(p: Partial<MessageGroupPersonality>): void {
    if (!this.editState) return;
    this.editState.draft = {
      ...this.editState.draft,
      personality: { ...this.editState.draft.personality, ...p }
    };
    this.recomputeInvalid();
  }

  patchSessionSearch(v: string): void {
    if (!this.editState) return;
    this.editState = { ...this.editState, sessionSearch: v };
    this.dashboard.notify();
  }

  private recomputeInvalid(): void {
    if (!this.editState) return;
    const invalidReason = this.manager().describeInvalid(this.editState.draft);
    const hits = this.computeHits(this.editState.draft, this.editState.sessions);
    this.editState = {
      ...this.editState,
      invalidReason,
      hitCount: hits.count,
      hitSessionPreviews: hits.previews
    };
    this.dashboard.notify();
  }

  /** 按当前草稿重算命中数，供 bindEdit 使用（不触发 notify） */
  private refreshHits(): void {
    if (!this.editState) return;
    const hits = this.computeHits(this.editState.draft, this.editState.sessions);
    this.editState.hitCount = hits.count;
    this.editState.hitSessionPreviews = hits.previews;
  }

  private computeHits(
    draft: MessageGroup,
    sessions: SessionMeta[]
  ): { count: number; previews: string[] } {
    if (this.manager().describeInvalid(draft) !== '') {
      return { count: 0, previews: [] };
    }

    const previews: string[] = [];
    let count = 0;
    for (const s of sessions) {
      const r = s.roleCardId || '';
      const sid = s.sessionId;

      const excluded =
        (r !== '' && draft.exclusions.roleCards.indexOf(r) >= 0) ||
        draft.exclusions.sessions.indexOf(sid) >= 0;
      if (excluded) continue;

      const included =
        draft.isGlobal ||
        (r !== '' && draft.inclusions.roleCards.indexOf(r) >= 0) ||
        draft.inclusions.sessions.indexOf(sid) >= 0;
      if (included) {
        count++;
        if (previews.length < 3) previews.push(s.title || sid.substring(0, 8));
      }
    }
    return { count, previews };
  }

  async saveEdit(onDone: () => void): Promise<void> {
    const edit = this.editState;
    if (!edit) return;
    const ok = this.manager().upsert(edit.draft);
    if (!ok) {
      this.dashboard.showBanner('保存失败', 'error');
      return;
    }
    const isNew = edit.isNew;
    this.editState = null;
    this.dashboard.showBanner(isNew ? '已创建' : '已保存', 'success');
    onDone();
  }

  clearEdit(): void {
    this.editState = null;
  }

  // ============================================
  // 增删改与排序
  // ============================================

  deleteGroup(groupId: string, onDone: () => void): void {
    const ok = this.manager().delete(groupId);
    if (!ok) {
      this.dashboard.showBanner('删除失败', 'error');
      return;
    }
    this.editState = null;
    onDone();
  }

  toggleEnabled(groupId: string): void {
    const mgr = this.manager();
    const g = mgr.getById(groupId);
    if (!g) return;
    const next = cloneGroup(g);
    next.enabled = !g.enabled;
    if (!mgr.upsert(next)) {
      this.dashboard.showBanner('保存失败', 'error');
      return;
    }
    const groups = this.listState.groups.map((item) =>
      item.group.groupId === groupId
        ? { group: next, invalidReason: mgr.describeInvalid(next) }
        : item
    );
    this.patchList({ groups });
  }

  moveUp(index: number): void {
    if (index <= 0 || index >= this.listState.groups.length) return;
    const ordered = this.listState.groups.slice();
    const tmp = ordered[index - 1];
    ordered[index - 1] = ordered[index];
    ordered[index] = tmp;
    this.applyOrder(ordered);
  }

  moveDown(index: number): void {
    if (index < 0 || index >= this.listState.groups.length - 1) return;
    const ordered = this.listState.groups.slice();
    const tmp = ordered[index + 1];
    ordered[index + 1] = ordered[index];
    ordered[index] = tmp;
    this.applyOrder(ordered);
  }

  private applyOrder(ordered: GroupWithReason[]): void {
    const groups: GroupWithReason[] = ordered.map((item, i) => ({
      group: { ...item.group, orderIndex: i },
      invalidReason: item.invalidReason
    }));
    this.manager().reorder(groups.map((g) => g.group.groupId));
    this.patchList({ groups });
  }

  private newGroupId(): string {
    let rand = Math.random().toString(36).slice(2, 8);
    while (rand.length < 6) rand += Math.floor(Math.random() * 36).toString(36);
    return 'grp_' + Date.now().toString(36) + '_' + rand;
  }
}
