// ui/dashboard/pages/MessageGroupEditPage.ui.ts
/// <reference path="../../../../types/index.d.ts" />

import { MessageGroupEditUiState } from './MessageGroupsState.js';
import {
  MessageGroup, MessageGroupInclusions, MessageGroupExclusions,
  MessageGroupPersonality, SessionMeta
} from '../../../db/models.js';
import { IconTextButton } from '../components/Common.ui.js';

export interface MessageGroupEditPageEvents {
  onBack: () => void;
  onPatch: (p: Partial<MessageGroup>) => void;
  onPatchInclusions: (p: Partial<MessageGroupInclusions>) => void;
  onPatchExclusions: (p: Partial<MessageGroupExclusions>) => void;
  onPatchPersonality: (p: Partial<MessageGroupPersonality>) => void;
  onSessionSearchChange: (v: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

export function MessageGroupEditPage(
  ctx: ComposeDslContext,
  state: MessageGroupEditUiState,
  events: MessageGroupEditPageEvents
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const d = state.draft;
  const items: ComposeNode[] = [];

  // 顶部栏
  items.push(ctx.UI.Row({
    horizontalArrangement: 'start',
    fillMaxWidth: true,
    verticalAlignment: 'center'
  }, [
    ctx.UI.IconButton({ icon: 'arrow_back', onClick: events.onBack }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Icon({
      name: state.isNew ? 'add' : 'edit',
      size: 20,
      tint: cs.primary
    }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Text({
      text: state.isNew ? '新建消息组' : '编辑消息组',
      fontSize: 18,
      fontWeight: 'bold',
      modifier: ctx.Modifier.weight(1)
    })
  ]));
  items.push(ctx.UI.Spacer({ height: 12 }));

  // 名称
  items.push(ctx.UI.Text({ text: '名称', fontSize: 13, fontWeight: 'bold' }));
  items.push(ctx.UI.Spacer({ height: 4 }));
  items.push(ctx.UI.TextField({
    value: d.name,
    onValueChange: (v: string) => events.onPatch({ name: v }),
    placeholder: '例如：角色卡A+会话X',
    singleLine: true,
    modifier: ctx.Modifier.fillMaxWidth()
  }));
  items.push(ctx.UI.Spacer({ height: 10 }));

  // 全局开关
  items.push(ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 14 }, [
      ctx.UI.Row({
        horizontalArrangement: 'spaceBetween',
        fillMaxWidth: true,
        verticalAlignment: 'center'
      }, [
        ctx.UI.Row({ verticalAlignment: 'center' }, [
          ctx.UI.Icon({ name: 'public', size: 16, tint: cs.primary }),
          ctx.UI.Spacer({ width: 6 }),
          ctx.UI.Text({ text: '全局组', fontSize: 14, fontWeight: 'bold' })
        ]),
        ctx.UI.Switch({
          checked: d.isGlobal,
          onCheckedChange: (v: boolean) => events.onPatch({ isGlobal: v })
        })
      ]),
      ctx.UI.Spacer({ height: 4 }),
      ctx.UI.Text({
        text: d.isGlobal
          ? '包含所有会话（下面的包含项忽略）'
          : '使用下方指定的包含项',
        fontSize: 11,
        color: cs.onSurfaceVariant
      })
    ])
  ]));

  // 包含项
  if (!d.isGlobal) {
    items.push(renderChipSection(ctx, {
      title: '包含项 · 角色卡',
      options: state.cards,
      selected: d.inclusions.roleCards,
      onToggle: (id) => events.onPatchInclusions({
        roleCards: toggleId(d.inclusions.roleCards, id)
      }),
      emptyText: '未获取到角色卡'
    }));
    items.push(renderSessionPicker(ctx, {
      title: '包含项 · 会话',
      sessions: state.sessions,
      selected: d.inclusions.sessions,
      search: state.sessionSearch,
      onSearchChange: events.onSessionSearchChange,
      onToggle: (id) => events.onPatchInclusions({
        sessions: toggleId(d.inclusions.sessions, id)
      })
    }));
  }

  // 排除项
  items.push(renderChipSection(ctx, {
    title: '排除项 · 角色卡',
    options: state.cards,
    selected: d.exclusions.roleCards,
    onToggle: (id) => events.onPatchExclusions({
      roleCards: toggleId(d.exclusions.roleCards, id)
    }),
    emptyText: '未获取到角色卡'
  }));
  items.push(renderSessionPicker(ctx, {
    title: '排除项 · 会话',
    sessions: state.sessions,
    selected: d.exclusions.sessions,
    search: state.sessionSearch,
    onSearchChange: events.onSessionSearchChange,
    onToggle: (id) => events.onPatchExclusions({
      sessions: toggleId(d.exclusions.sessions, id)
    })
  }));

  // 人格设定
  items.push(renderPersonalityCard(ctx, state, events));

  // 启用开关
  items.push(ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 14 }, [
      ctx.UI.Row({
        horizontalArrangement: 'spaceBetween',
        fillMaxWidth: true,
        verticalAlignment: 'center'
      }, [
        ctx.UI.Row({ verticalAlignment: 'center' }, [
          ctx.UI.Icon({ name: 'toggle_on', size: 16, tint: cs.primary }),
          ctx.UI.Spacer({ width: 6 }),
          ctx.UI.Text({ text: '启用此组', fontSize: 14, fontWeight: 'bold' })
        ]),
        ctx.UI.Switch({
          checked: d.enabled,
          onCheckedChange: (v: boolean) => events.onPatch({ enabled: v })
        })
      ])
    ])
  ]));

  // 有效性
  const valid = state.invalidReason === '';
  items.push(ctx.UI.Card({
    elevation: 0,
    containerColor: valid ? cs.primaryContainer : cs.errorContainer,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Row({
      verticalAlignment: 'center',
      modifier: ctx.Modifier.padding(12)
    }, [
      ctx.UI.Icon({
        name: valid ? 'check_circle' : 'warning',
        size: 16,
        tint: valid ? cs.onPrimaryContainer : cs.onErrorContainer
      }),
      ctx.UI.Spacer({ width: 6 }),
      ctx.UI.Text({
        text: valid ? '有效，会参与匹配' : '无效：' + state.invalidReason,
        fontSize: 12,
        color: valid ? cs.onPrimaryContainer : cs.onErrorContainer
      })
    ])
  ]));

  // 命中预览
  if (!state.invalidReason) {
    items.push(ctx.UI.Card({
      elevation: 1,
      modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 12 })
    }, [
      ctx.UI.Column({ padding: 12 }, [
        ctx.UI.Row({ verticalAlignment: 'center' }, [
          ctx.UI.Icon({ name: 'visibility', size: 16, tint: cs.primary }),
          ctx.UI.Spacer({ width: 6 }),
          ctx.UI.Text({
            text: '命中预览', fontSize: 13, fontWeight: 'bold'
          })
        ]),
        ctx.UI.Spacer({ height: 6 }),
        ctx.UI.Text({
          text: state.hitCount === 0
            ? '当前没有会话会命中此策略'
            : `当前有 ${state.hitCount} 个会话会命中此策略`,
          fontSize: 12,
          color: state.hitCount === 0 ? cs.onSurfaceVariant : cs.primary
        }),
        state.hitSessionPreviews.length > 0
          ? ctx.UI.Column({ modifier: ctx.Modifier.padding({ top: 4 }) },
              state.hitSessionPreviews.map(p =>
                ctx.UI.Text({
                  text: '· ' + p,
                  fontSize: 11,
                  color: cs.onSurfaceVariant
                })
              )
            )
          : ctx.UI.Spacer({ height: 0 })
      ])
    ]));
  }

  // 底部按钮
  const buttons: ComposeNode[] = [
    IconTextButton(ctx, {
      text: '保存',
      icon: 'save',
      onClick: events.onSave,
      containerColor: cs.primary,
      contentColor: cs.onPrimary,
      modifier: ctx.Modifier.weight(1).padding(4)
    })
  ];
  if (!state.isNew) {
    buttons.push(IconTextButton(ctx, {
      text: '删除',
      icon: 'delete',
      onClick: events.onDelete,
      iconSize: 16,
      containerColor: cs.errorContainer,
      contentColor: cs.onErrorContainer,
      modifier: ctx.Modifier.width(110).padding(4)
    }));
  }
  items.push(ctx.UI.Row({
    horizontalArrangement: 'spaceEvenly',
    fillMaxWidth: true,
    modifier: ctx.Modifier.padding({ top: 4, bottom: 16 })
  }, buttons));

  return ctx.UI.LazyColumn({ fillMaxSize: true, padding: 16 }, items);
}

interface ChipOption {
  id: string;
  name: string;
}

function renderChipSection(
  ctx: ComposeDslContext,
  opts: {
    title: string;
    options: ChipOption[];
    selected: string[];
    onToggle: (id: string) => void;
    emptyText: string;
  }
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const children: ComposeNode[] = [];

  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceBetween',
    fillMaxWidth: true,
    verticalAlignment: 'center'
  }, [
    ctx.UI.Text({ text: opts.title, fontSize: 13, fontWeight: 'bold' }),
    ctx.UI.Text({
      text: '已选 ' + opts.selected.length,
      fontSize: 11,
      color: cs.onSurfaceVariant
    })
  ]));
  children.push(ctx.UI.Spacer({ height: 6 }));

  if (opts.options.length === 0) {
    children.push(ctx.UI.Text({
      text: opts.emptyText,
      fontSize: 11,
      color: cs.onSurfaceVariant
    }));
  } else {
    const chips = opts.options.map((opt) => {
      const sel = opts.selected.indexOf(opt.id) >= 0;
      return ctx.UI.Surface({
        containerColor: sel ? cs.primary : cs.surfaceVariant,
        shape: { type: 'rounded', cornerRadius: 16 },
        modifier: ctx.Modifier.padding(4).clickable(() => opts.onToggle(opt.id)),
        shadowElevation: sel ? 2 : 0
      }, [
        ctx.UI.Text({
          text: opt.name,
          fontSize: 11,
          color: sel ? cs.onPrimary : cs.onSurfaceVariant,
          modifier: ctx.Modifier.padding({ horizontal: 10, vertical: 4 })
        })
      ]);
    });
    children.push(ctx.UI.LazyRow({
      horizontalArrangement: 'start',
      fillMaxWidth: true,
      spacing: 4
    }, chips));
  }

  return ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 14 }, children)
  ]);
}

function renderSessionPicker(
  ctx: ComposeDslContext,
  opts: {
    title: string;
    sessions: SessionMeta[];
    selected: string[];
    search: string;
    onSearchChange: (v: string) => void;
    onToggle: (id: string) => void;
  }
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;

  // 已选中的会话（常驻显示）
  const selectedSet = new Set(opts.selected);
  const selectedSessions = opts.sessions.filter((s) => selectedSet.has(s.sessionId));

  // 过滤后的会话（未选中的 + 匹配搜索的）
  const query = opts.search.toLowerCase().trim();
  const available = opts.sessions.filter((s) => {
    if (selectedSet.has(s.sessionId)) return false;   // 已选中不重复显示
    if (query === '') return true;
    const title = (s.title || '').toLowerCase();
    return title.indexOf(query) >= 0;
  });
  const displayLimit = 20;
  const displaySessions = available.slice(0, displayLimit);

  const children: ComposeNode[] = [];

  // 标题 + 已选数量
  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceBetween',
    fillMaxWidth: true,
    verticalAlignment: 'center'
  }, [
    ctx.UI.Text({ text: opts.title, fontSize: 13, fontWeight: 'bold' }),
    ctx.UI.Text({
      text: `已选 ${opts.selected.length}`,
      fontSize: 11, color: cs.onSurfaceVariant
    })
  ]));
  children.push(ctx.UI.Spacer({ height: 6 }));

  // 搜索框
  children.push(ctx.UI.TextField({
    value: opts.search,
    onValueChange: opts.onSearchChange,
    placeholder: '搜索会话标题...',
    singleLine: true,
    modifier: ctx.Modifier.fillMaxWidth()
  }));
  children.push(ctx.UI.Spacer({ height: 8 }));

  // 已选中的会话 chips（常驻）
  if (selectedSessions.length > 0) {
    children.push(ctx.UI.Text({
      text: '已选中',
      fontSize: 11, color: cs.onSurfaceVariant
    }));
    children.push(ctx.UI.Spacer({ height: 4 }));
    const selectedChips: ComposeNode[] = selectedSessions.map((s) => {
      const label = s.title || s.sessionId.substring(0, 8);
      return ctx.UI.Surface({
        containerColor: cs.primary,
        shape: { type: 'rounded', cornerRadius: 16 },
        modifier: ctx.Modifier.padding(2).clickable(() => opts.onToggle(s.sessionId))
      }, [
        ctx.UI.Row({
          verticalAlignment: 'center',
          modifier: ctx.Modifier.padding({ horizontal: 10, vertical: 4 })
        }, [
          ctx.UI.Text({ text: label, fontSize: 11, color: cs.onPrimary }),
          ctx.UI.Spacer({ width: 4 }),
          ctx.UI.Icon({ name: 'close', size: 12, tint: cs.onPrimary })
        ])
      ]);
    });
    children.push(ctx.UI.LazyRow({
      horizontalArrangement: 'start',
      fillMaxWidth: true,
      spacing: 4
    }, selectedChips));
    children.push(ctx.UI.Spacer({ height: 8 }));
  }

  // 可选项（过滤后的，最多 20 个）
  if (opts.sessions.length === 0) {
    children.push(ctx.UI.Text({
      text: '（暂无会话）',
      fontSize: 11, color: cs.onSurfaceVariant
    }));
  } else if (available.length === 0) {
    children.push(ctx.UI.Text({
      text: query === '' ? '（所有会话已选中）' : '（无匹配会话）',
      fontSize: 11, color: cs.onSurfaceVariant
    }));
  } else {
    if (available.length > displayLimit) {
      children.push(ctx.UI.Text({
        text: `匹配 ${available.length} 个，显示前 ${displayLimit} 个`,
        fontSize: 11, color: cs.onSurfaceVariant
      }));
      children.push(ctx.UI.Spacer({ height: 4 }));
    }

    for (const s of displaySessions) {
      const label = s.title || s.sessionId.substring(0, 8);
      children.push(ctx.UI.Row({
        verticalAlignment: 'center',
        modifier: ctx.Modifier
          .fillMaxWidth()
          .padding({ vertical: 4 })
          .clickable(() => opts.onToggle(s.sessionId))
      }, [
        ctx.UI.Checkbox({
          checked: false,
          onCheckedChange: () => opts.onToggle(s.sessionId)
        }),
        ctx.UI.Spacer({ width: 6 }),
        ctx.UI.Column({ modifier: ctx.Modifier.weight(1) }, [
          ctx.UI.Text({
            text: label, fontSize: 13, color: cs.onSurface,
            maxLines: 1, overflow: 'ellipsis'
          }),
          s.roleCardName
            ? ctx.UI.Text({
                text: s.roleCardName, fontSize: 11, color: cs.onSurfaceVariant,
                maxLines: 1, overflow: 'ellipsis'
              })
            : ctx.UI.Spacer({ height: 0 })
        ])
      ]));
    }
  }

  return ctx.UI.Card({
    elevation: 1,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 12 })
  }, [
    ctx.UI.Column({ padding: 12 }, children)
  ]);
}

function renderPersonalityCard(
  ctx: ComposeDslContext,
  state: MessageGroupEditUiState,
  events: MessageGroupEditPageEvents
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const p = state.draft.personality;
  const children: ComposeNode[] = [];

  children.push(ctx.UI.Text({ text: '人格设定', fontSize: 14, fontWeight: 'bold' }));
  children.push(ctx.UI.Spacer({ height: 2 }));
  children.push(ctx.UI.Text({
    text: '折叠时以该人格视角整理记忆',
    fontSize: 11,
    color: cs.onSurfaceVariant
  }));
  children.push(ctx.UI.Spacer({ height: 8 }));

  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceEvenly',
    fillMaxWidth: true
  }, [
    IconTextButton(ctx, {
      text: '自动匹配',
      icon: 'auto_awesome',
      onClick: () => events.onPatchPersonality({ mode: 'auto' }),
      iconSize: 16,
      containerColor: p.mode === 'auto' ? cs.primary : cs.surfaceVariant,
      contentColor: p.mode === 'auto' ? cs.onPrimary : cs.onSurfaceVariant,
      modifier: ctx.Modifier.weight(1).padding(4)
    }),
    IconTextButton(ctx, {
      text: '手动指定',
      icon: 'touch_app',
      onClick: () => events.onPatchPersonality({ mode: 'manual' }),
      iconSize: 16,
      containerColor: p.mode === 'manual' ? cs.primary : cs.surfaceVariant,
      contentColor: p.mode === 'manual' ? cs.onPrimary : cs.onSurfaceVariant,
      modifier: ctx.Modifier.weight(1).padding(4)
    })
  ]));

  if (p.mode === 'manual') {
    children.push(ctx.UI.Spacer({ height: 6 }));

    if (state.cards.length === 0) {
      children.push(ctx.UI.Text({
        text: '未获取到角色卡',
        fontSize: 11,
        color: cs.onSurfaceVariant
      }));
    } else {
      const chips = state.cards.map((card) => {
        const sel = p.cardId === card.id;
        return ctx.UI.Surface({
          containerColor: sel ? cs.primary : cs.surfaceVariant,
          shape: { type: 'rounded', cornerRadius: 16 },
          modifier: ctx.Modifier.padding(4).clickable(() => {
            events.onPatchPersonality({
              cardId: sel ? '' : card.id,
              name: sel ? '' : card.name
            });
          }),
          shadowElevation: sel ? 2 : 0
        }, [
          ctx.UI.Text({
            text: card.name,
            fontSize: 11,
            color: sel ? cs.onPrimary : cs.onSurfaceVariant,
            modifier: ctx.Modifier.padding({ horizontal: 10, vertical: 4 })
          })
        ]);
      });
      children.push(ctx.UI.LazyRow({
        horizontalArrangement: 'start',
        fillMaxWidth: true,
        spacing: 4
      }, chips));
    }

    children.push(ctx.UI.Spacer({ height: 6 }));
    children.push(ctx.UI.Text({
      text: '或 自定义人格文本',
      fontSize: 11,
      color: cs.onSurfaceVariant
    }));
    children.push(ctx.UI.Spacer({ height: 4 }));
    children.push(ctx.UI.TextField({
      value: p.customText,
      onValueChange: (v: string) => events.onPatchPersonality({ customText: v }),
      placeholder: '描述该人格的记忆整理视角',
      minLines: 3,
      maxLines: 8,
      modifier: ctx.Modifier.fillMaxWidth()
    }));
  }

  return ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 14 }, children)
  ]);
}

function toggleId(arr: string[], id: string): string[] {
  const next = arr.slice();
  const i = next.indexOf(id);
  if (i >= 0) next.splice(i, 1);
  else next.push(id);
  return next;
}
