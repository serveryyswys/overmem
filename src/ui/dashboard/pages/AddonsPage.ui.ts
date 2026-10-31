// ui/dashboard/pages/AddonsPage.ui.ts
/// <reference path="../../../../types/index.d.ts" />

import { AddonsUiState, AddonsDeployMode, DeployStepView } from './AddonsState.js';
import { IconTextButton } from '../components/Common.ui.js';

export interface AddonsPageEvents {
  onBack: () => void;
  onSelectMode: (mode: AddonsDeployMode) => void;
  onStartDeploy: () => void;
  onRemoteUrlChange: (url: string) => void;
  onConnectRemote: () => void;
}

export function AddonsPage(
  ctx: ComposeDslContext,
  state: AddonsUiState,
  events: AddonsPageEvents
): ComposeNode {
  return renderAddonsContent(ctx, state, events, true, 16);
}

export function AddonsTab(
  ctx: ComposeDslContext,
  state: AddonsUiState,
  events: AddonsPageEvents
): ComposeNode {
  return renderAddonsContent(ctx, state, events, false, 0);
}

function renderAddonsContent(
  ctx: ComposeDslContext,
  state: AddonsUiState,
  events: AddonsPageEvents,
  showHeader: boolean,
  padding: number
): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const items: ComposeNode[] = [];

  if (showHeader) {
    items.push(ctx.UI.Row({
      horizontalArrangement: 'start',
      fillMaxWidth: true,
      verticalAlignment: 'center'
    }, [
      ctx.UI.IconButton({ icon: 'arrow_back', onClick: events.onBack }),
      ctx.UI.Spacer({ width: 8 }),
      ctx.UI.Icon({ name: 'extension', size: 20, tint: cs.primary }),
      ctx.UI.Spacer({ width: 8 }),
      ctx.UI.Text({
        text: '加载项', fontSize: 18, fontWeight: 'bold',
        modifier: ctx.Modifier.weight(1)
      })
    ]));
    items.push(ctx.UI.Spacer({ height: 12 }));
  }

  items.push(ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 16 }, renderRuntimeCard(ctx, state, events))
  ]));

  items.push(ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 16 }, [
      ctx.UI.Row({ verticalAlignment: 'center' }, [
        ctx.UI.Icon({ name: 'info', size: 18, tint: cs.onSurfaceVariant }),
        ctx.UI.Spacer({ width: 8 }),
        ctx.UI.Text({ text: '当前状态', fontSize: 14, fontWeight: 'bold' })
      ]),
      ctx.UI.Spacer({ height: 8 }),
      ctx.UI.Row({ verticalAlignment: 'center' }, [
        ctx.UI.Icon({
          name: state.runtimeAvailable ? 'check_circle' : 'hourglass_empty',
          size: 16,
          tint: state.runtimeAvailable ? cs.primary : cs.onSurfaceVariant
        }),
        ctx.UI.Spacer({ width: 6 }),
        ctx.UI.Text({
          text: state.runtimeAvailable
            ? ('运行时已启用' + (state.runtimeVersion ? ' v' + state.runtimeVersion : ''))
            : '运行时未启用',
          fontSize: 13,
          color: state.runtimeAvailable ? cs.primary : cs.onSurfaceVariant
        })
      ]),
      ctx.UI.Spacer({ height: 4 }),
      ctx.UI.Text({
        text: '已安装加载项：' + state.addonCount + ' 个',
        fontSize: 12, color: cs.onSurfaceVariant
      })
    ])
  ]));

  items.push(ctx.UI.Card({
    elevation: 2,
    modifier: ctx.Modifier.fillMaxWidth().padding({ bottom: 10 })
  }, [
    ctx.UI.Column({ padding: 16 }, [
      ctx.UI.Row({ verticalAlignment: 'center' }, [
        ctx.UI.Icon({ name: 'construction', size: 18, tint: cs.primary }),
        ctx.UI.Spacer({ width: 8 }),
        ctx.UI.Text({ text: '计划功能', fontSize: 14, fontWeight: 'bold' })
      ]),
      ctx.UI.Spacer({ height: 10 }),
      renderPlanRow(ctx, '加载并执行 Python 脚本'),
      renderPlanRow(ctx, '记忆处理钩子（注入前 / 整理前）'),
      renderPlanRow(ctx, '自定义 AI 调用策略'),
      renderPlanRow(ctx, '脚本市场与版本管理')
    ])
  ]));

  if (state.addonList.length === 0) {
    items.push(ctx.UI.Box({
      fillMaxWidth: true, height: 200, contentAlignment: 'center'
    }, [
      ctx.UI.Column({ horizontalAlignment: 'center' }, [
        ctx.UI.Icon({ name: 'extension_off', size: 56, tint: cs.onSurfaceVariant }),
        ctx.UI.Spacer({ height: 10 }),
        ctx.UI.Text({ text: '暂无加载项', fontSize: 14, color: cs.onSurfaceVariant }),
        ctx.UI.Spacer({ height: 4 }),
        ctx.UI.Text({ text: '功能开发中，敬请期待', fontSize: 12, color: cs.onSurfaceVariant })
      ])
    ]));
  }

  return ctx.UI.LazyColumn({ fillMaxSize: true, padding }, items);
}

function renderRuntimeCard(
  ctx: ComposeDslContext,
  state: AddonsUiState,
  events: AddonsPageEvents
): ComposeNode[] {
  const cs = ctx.MaterialTheme.colorScheme;
  const children: ComposeNode[] = [];

  children.push(ctx.UI.Row({ verticalAlignment: 'center' }, [
    ctx.UI.Icon({ name: 'science', size: 20, tint: cs.primary }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Text({ text: 'Python 插件运行时', fontSize: 15, fontWeight: 'bold' })
  ]));
  children.push(ctx.UI.Spacer({ height: 8 }));
  children.push(ctx.UI.Text({
    text: '加载项用于扩展 OverMem 的能力，允许用户编写 Python 脚本自定义记忆处理、注入策略、AI 调用等逻辑。',
    fontSize: 13, color: cs.onSurface
  }));

  // ---- 部署方式 ----
  children.push(ctx.UI.Spacer({ height: 12 }));
  children.push(ctx.UI.Text({ text: '部署方式', fontSize: 13, fontWeight: 'bold', color: cs.onSurface }));
  children.push(ctx.UI.Spacer({ height: 6 }));
  children.push(ctx.UI.Row({ fillMaxWidth: true }, [
    IconTextButton(ctx, {
      text: '本地部署',
      icon: 'download',
      onClick: () => events.onSelectMode('local'),
      enabled: !state.deploying,
      iconSize: 16,
      containerColor: state.deployMode === 'local' ? cs.primary : cs.surfaceVariant,
      contentColor: state.deployMode === 'local' ? cs.onPrimary : cs.onSurfaceVariant,
      modifier: ctx.Modifier.weight(1).padding(4)
    }),
    IconTextButton(ctx, {
      text: '远程连接',
      icon: 'link',
      onClick: () => events.onSelectMode('remote'),
      enabled: !state.deploying,
      iconSize: 16,
      containerColor: state.deployMode === 'remote' ? cs.primary : cs.surfaceVariant,
      contentColor: state.deployMode === 'remote' ? cs.onPrimary : cs.onSurfaceVariant,
      modifier: ctx.Modifier.weight(1).padding(4)
    })
  ]));

  if (state.deployMode === 'local') {
    children.push(ctx.UI.Spacer({ height: 10 }));
    children.push(renderDeploySteps(ctx, state));
    children.push(ctx.UI.Spacer({ height: 8 }));

    // 下载进度
    if (state.deploying && state.deployProgress >= 0) {
      children.push(ctx.UI.Card({
        elevation: 0,
        containerColor: cs.surfaceVariant,
        modifier: ctx.Modifier.fillMaxWidth().padding({ vertical: 8 }),
        shape: { type: 'rounded', cornerRadius: 8 }
      }, [
        ctx.UI.Column({ padding: 12 }, [
          ctx.UI.Row({
            horizontalArrangement: 'spaceBetween',
            fillMaxWidth: true,
            verticalAlignment: 'center'
          }, [
            ctx.UI.Text({ text: '下载运行时包', fontSize: 13, fontWeight: 'bold' }),
            ctx.UI.Text({
              text: Math.round(state.deployProgress * 100) + '%',
              fontSize: 13, fontWeight: 'bold', color: cs.primary
            })
          ]),
          ctx.UI.Spacer({ height: 6 }),
          ctx.UI.LinearProgressIndicator({
            progress: state.deployProgress,
            modifier: ctx.Modifier.fillMaxWidth().height(6)
          }),
          ctx.UI.Spacer({ height: 6 }),
          ctx.UI.Row({ horizontalArrangement: 'spaceBetween', fillMaxWidth: true }, [
            ctx.UI.Text({ text: state.deployReceivedText, fontSize: 11, color: cs.onSurfaceVariant }),
            ctx.UI.Text({
              text: [state.deploySpeedText, state.deployEtaText].filter((t) => t).join(' · '),
              fontSize: 11, color: cs.onSurfaceVariant
            })
          ])
        ])
      ]));
      children.push(ctx.UI.Spacer({ height: 8 }));
    }

    children.push(IconTextButton(ctx, {
      text: state.deploying ? '部署中…' : (state.runtimeAvailable ? '重新部署' : '开始部署'),
      icon: state.deploying ? 'sync' : 'rocket_launch',
      onClick: events.onStartDeploy,
      enabled: !state.deploying,
      iconSize: 16,
      containerColor: cs.primary,
      contentColor: cs.onPrimary,
      modifier: ctx.Modifier.fillMaxWidth()
    }));
  } else if (state.deployMode === 'remote') {
    children.push(ctx.UI.Spacer({ height: 10 }));
    children.push(ctx.UI.TextField({
      value: state.remoteUrl,
      onValueChange: events.onRemoteUrlChange,
      placeholder: 'http://127.0.0.1:8765',
      modifier: ctx.Modifier.fillMaxWidth()
    }));
    children.push(ctx.UI.Spacer({ height: 8 }));
    children.push(IconTextButton(ctx, {
      text: '连接',
      icon: 'link',
      onClick: events.onConnectRemote,
      iconSize: 16,
      containerColor: cs.primary,
      contentColor: cs.onPrimary,
      modifier: ctx.Modifier.fillMaxWidth()
    }));
  } else {
    children.push(ctx.UI.Spacer({ height: 8 }));
    children.push(ctx.UI.Text({
      text: '请选择部署方式',
      fontSize: 12, color: cs.onSurfaceVariant
    }));
  }

  // 部署状态
  if (state.deployStatus) {
    children.push(ctx.UI.Spacer({ height: 8 }));
    children.push(ctx.UI.Text({
      text: state.deployStatus,
      fontSize: 11,
      color: state.deployStatus.indexOf('失败') >= 0 ? cs.error : cs.onSurfaceVariant
    }));
  }

  return children;
}

function renderDeploySteps(ctx: ComposeDslContext, state: AddonsUiState): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  const rows: ComposeNode[] = [];

  state.deploySteps.forEach((step: DeployStepView) => {
    const done = step.status === 'done';
    const failed = step.status === 'failed';
    const running = step.status === 'running';
    const color = failed ? cs.error : (done || running ? cs.primary : cs.onSurfaceVariant);

    rows.push(ctx.UI.Row({
      verticalAlignment: 'center',
      modifier: ctx.Modifier.padding({ bottom: 6 })
    }, [
      running
        ? ctx.UI.CircularProgressIndicator({ color: cs.primary, modifier: ctx.Modifier.width(14).height(14) })
        : ctx.UI.Icon({
            name: done ? 'check_circle' : (failed ? 'error' : 'radio_button_unchecked'),
            size: 16,
            tint: color
          }),
      ctx.UI.Spacer({ width: 8 }),
      ctx.UI.Column({ modifier: ctx.Modifier.weight(1) }, [
        ctx.UI.Text({ text: step.label, fontSize: 13, color: color }),
        ...(step.detail
          ? [ctx.UI.Text({ text: step.detail, fontSize: 11, color: cs.onSurfaceVariant, maxLines: 2 })]
          : [])
      ])
    ]));
  });

  return ctx.UI.Column({ fillMaxWidth: true }, rows);
}

function renderPlanRow(ctx: ComposeDslContext, text: string): ComposeNode {
  const cs = ctx.MaterialTheme.colorScheme;
  return ctx.UI.Row({
    verticalAlignment: 'center',
    modifier: ctx.Modifier.padding({ bottom: 6 })
  }, [
    ctx.UI.Icon({ name: 'check_box_outline_blank', size: 16, tint: cs.onSurfaceVariant }),
    ctx.UI.Spacer({ width: 6 }),
    ctx.UI.Text({ text, fontSize: 13, color: cs.onSurface })
  ]);
}
