// ui/dashboard/pages/MessageGroupsPage.ui.ts
/// <reference path="../../../../types/index.d.ts" />

import {
  GroupWithReason, MessageGroupsUiState
} from './MessageGroupsState.js';
import { MessageGroup, MessageGroupPersonality } from '../../../db/models.js';
import { IconTextButton } from '../components/Common.ui.js';

export interface MessageGroupsPageEvents {
  onBack: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (groupId: string) => void;
  onDelete: (group: MessageGroup) => void;
  onToggleEnabled: (groupId: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

export function MessageGroupsPage(
  ctx: ComposeDslContext,
  state: MessageGroupsUiState,
  events: MessageGroupsPageEvents
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const items: ComposeNode[] = [];

  items.push(ctx.UI.Row({
    horizontalArrangement: 'start',
    fillMaxWidth: true,
    verticalAlignment: 'center'
  }, [
    ctx.UI.IconButton({ icon: 'arrow_back', onClick: events.onBack }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Icon({ name: 'link', size: 20, tint: cs.primary }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Text({
      text: '消息组策略', fontSize: 18, fontWeight: 'bold',
      modifier: ctx.Modifier.weight(1)
    }),
    ctx.UI.IconButton({ icon: 'refresh', onClick: events.onRefresh })
  ]));
  items.push(ctx.UI.Spacer({ height: 12 }));

  items.push(ctx.UI.Card({
    elevation: 0,
    containerColor: cs.surfaceVariant,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 12 }, [
      ctx.UI.Text({
        text: '组策略决定哪些会话的记忆共享。按顺序匹配，先命中先生效。',
        fontSize: 12, color: cs.onSurfaceVariant
      }),
      ctx.UI.Spacer({ height: 4 }),
      ctx.UI.Text({
        text: '未命中任何策略的会话使用独立会话模式。',
        fontSize: 12, color: cs.onSurfaceVariant
      })
    ])
  ]));

  items.push(IconTextButton(ctx, {
    text: '新建组',
    icon: 'add',
    onClick: events.onCreate,
    containerColor: cs.primary,
    contentColor: cs.onPrimary,
    modifier: ctx.Modifier.fillMaxWidth().padding({ top: 4, bottom: 10 })
  }));

  if (state.loading) {
    items.push(ctx.UI.Box({
      fillMaxWidth: true, height: 160, contentAlignment: 'center'
    }, [
      ctx.UI.CircularProgressIndicator()
    ]));
  } else if (state.error) {
    items.push(ctx.UI.Card({
      elevation: 0,
      containerColor: cs.errorContainer,
      modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
    }, [
      ctx.UI.Column({ padding: 12 }, [
        ctx.UI.Row({ verticalAlignment: 'center' }, [
          ctx.UI.Icon({ name: 'warning', size: 16, tint: cs.onErrorContainer }),
          ctx.UI.Spacer({ width: 6 }),
          ctx.UI.Text({
            text: '加载失败', fontSize: 13, fontWeight: 'bold', color: cs.onErrorContainer
          })
        ]),
        ctx.UI.Spacer({ height: 4 }),
        ctx.UI.Text({ text: state.error, fontSize: 12, color: cs.onErrorContainer })
      ])
    ]));
  } else if (state.groups.length === 0) {
    items.push(ctx.UI.Box({
      fillMaxWidth: true, height: 200, contentAlignment: 'center'
    }, [
      ctx.UI.Column({ horizontalAlignment: 'center' }, [
        ctx.UI.Text({ text: '当前无组策略', fontSize: 14, color: cs.onSurfaceVariant }),
        ctx.UI.Spacer({ height: 4 }),
        ctx.UI.Text({ text: '所有会话使用独立会话模式', fontSize: 12, color: cs.onSurfaceVariant })
      ])
    ]));
  } else {
    for (let i = 0; i < state.groups.length; i++) {
      items.push(renderGroupCard(ctx, state.groups[i], i, state.groups.length, events));
    }
  }

  return ctx.UI.LazyColumn({ fillMaxSize: true, padding: 16 }, items);
}

function renderGroupCard(
  ctx: ComposeDslContext,
  item: GroupWithReason,
  index: number,
  total: number,
  events: MessageGroupsPageEvents
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const g = item.group;
  const valid = item.invalidReason === '';
  const children: ComposeNode[] = [];

  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceBetween',
    fillMaxWidth: true,
    verticalAlignment: 'center'
  }, [
    ctx.UI.Row({ verticalAlignment: 'center', modifier: ctx.Modifier.weight(1) }, [
      ctx.UI.Box({
        width: 24,
        height: 24,
        contentAlignment: 'center',
        modifier: ctx.Modifier.background(
          valid ? cs.primaryContainer : cs.errorContainer,
          { type: 'rounded', cornerRadius: 12 }
        )
      }, [
        ctx.UI.Text({
          text: String(index + 1),
          fontSize: 12,
          fontWeight: 'bold',
          color: valid ? cs.onPrimaryContainer : cs.onErrorContainer
        })
      ]),
      ctx.UI.Spacer({ width: 8 }),
      ctx.UI.Text({
        text: groupTitle(g, index),
        fontSize: 15,
        fontWeight: 'bold',
        maxLines: 1
      })
    ]),
    ctx.UI.IconButton({
      icon: 'arrow_upward',
      enabled: index > 0,
      onClick: () => events.onMoveUp(index)
    }),
    ctx.UI.IconButton({
      icon: 'arrow_downward',
      enabled: index < total - 1,
      onClick: () => events.onMoveDown(index)
    })
  ]));

  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceBetween',
    fillMaxWidth: true,
    verticalAlignment: 'center',
    modifier: ctx.Modifier.padding({ top: 6 })
  }, [
    ctx.UI.Row({ verticalAlignment: 'center' }, [
      ctx.UI.Switch({
        checked: g.enabled,
        onCheckedChange: () => events.onToggleEnabled(g.groupId)
      }),
      ctx.UI.Spacer({ width: 4 }),
      ctx.UI.Text({
        text: g.enabled ? '已启用' : '已禁用',
        fontSize: 12,
        color: cs.onSurfaceVariant
      })
    ]),
    valid
      ? ctx.UI.Row({ verticalAlignment: 'center' }, [
        ctx.UI.Icon({ name: 'check_circle', size: 14, tint: cs.primary }),
        ctx.UI.Spacer({ width: 4 }),
        ctx.UI.Text({ text: '有效', fontSize: 12, color: cs.primary })
      ])
      : ctx.UI.Row({
        verticalAlignment: 'center',
        modifier: ctx.Modifier.weight(1)
      }, [
        ctx.UI.Icon({ name: 'warning', size: 14, tint: cs.error }),
        ctx.UI.Spacer({ width: 4 }),
        ctx.UI.Text({
          text: item.invalidReason || '无效',
          fontSize: 11,
          color: cs.error,
          maxLines: 2,
          modifier: ctx.Modifier.weight(1)
        })
      ])
  ]));

  children.push(renderSummaryRow(
    ctx, '包含：',
    g.isGlobal ? '全局（所有会话）' : summarize(g.inclusions.roleCards, g.inclusions.sessions)
  ));

  if (g.exclusions.roleCards.length > 0 || g.exclusions.sessions.length > 0) {
    children.push(renderSummaryRow(
      ctx, '排除：', summarize(g.exclusions.roleCards, g.exclusions.sessions)
    ));
  }

  children.push(renderSummaryRow(
    ctx, '人格：', personalitySummary(g.personality)
  ));

  children.push(ctx.UI.Row({
    horizontalArrangement: 'spaceEvenly',
    fillMaxWidth: true,
    modifier: ctx.Modifier.padding({ top: 10 })
  }, [
    IconTextButton(ctx, {
      text: '编辑',
      icon: 'edit',
      onClick: () => events.onEdit(g.groupId),
      iconSize: 16,
      containerColor: cs.secondaryContainer,
      contentColor: cs.onSecondaryContainer,
      modifier: ctx.Modifier.weight(1).padding(4)
    }),
    IconTextButton(ctx, {
      text: '删除',
      icon: 'delete',
      onClick: () => events.onDelete(g),
      iconSize: 16,
      containerColor: cs.errorContainer,
      contentColor: cs.onErrorContainer,
      modifier: ctx.Modifier.weight(1).padding(4)
    })
  ]));

  return ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 14 }, children)
  ]);
}

function renderSummaryRow(
  ctx: ComposeDslContext,
  label: string,
  value: string
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  return ctx.UI.Row({
    horizontalArrangement: 'start',
    fillMaxWidth: true,
    verticalAlignment: 'start',
    modifier: ctx.Modifier.padding({ top: 4 })
  }, [
    ctx.UI.Text({ text: label, fontSize: 12, color: cs.onSurfaceVariant }),
    ctx.UI.Text({
      text: value, fontSize: 12, color: cs.onSurface,
      modifier: ctx.Modifier.weight(1)
    })
  ]);
}

function groupTitle(g: MessageGroup, index: number): string {
  if (g.name) return g.name;
  return g.isGlobal ? '全局' : '组 ' + (index + 1);
}

function summarize(roleCards: string[], sessions: string[]): string {
  if (roleCards.length === 0 && sessions.length === 0) return '（空）';
  return `角色卡 ${roleCards.length} 个，会话 ${sessions.length} 个`;
}

function personalitySummary(p: MessageGroupPersonality): string {
  if (p.mode === 'auto') return '自动匹配（会话绑定的角色卡）';
  if (p.cardId) return '手动：' + (p.name || p.cardId);
  if (p.customText) return '手动：自定义文本';
  return '手动（未指定）';
}
