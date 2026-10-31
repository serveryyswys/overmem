// ui/dashboard/index.ui.ts
/// <reference path="../../../types/index.d.ts" />

import { isSetupComplete, loadSettings } from '../../utils/ConfigManager.js';
import { DatabaseManager } from '../../db/DatabaseManager.js';
import { DbVersion, CURRENT_DB_VERSION } from '../../db/DbVersion.js';
import { DashboardState } from './DashboardState.js';
import { NavEntry } from './Navigation.js';
import { logInfo, logDebug, logError } from '../../utils/Logger.js';
import { sanContent, sanError } from '../../utils/Sanitizer.js';

import { WelcomeStateHolder } from './pages/WelcomeState.js';
import { ConfigStateHolder } from './pages/ConfigState.js';
import { OverviewStateHolder } from './pages/OverviewState.js';
import { SessionsListStateHolder } from './pages/SessionsListState.js';
import { SettingsStateHolder } from './pages/SettingsState.js';
import { SessionBlocksStateHolder } from './pages/SessionBlocksState.js';
import { DetailStateHolder } from './pages/DetailState.js';
import { EditStateHolder } from './pages/EditState.js';
import { ConfirmStateHolder, ConfirmPageData } from './pages/ConfirmState.js';
import { AboutStateHolder } from './pages/AboutState.js';
import { AddonsStateHolder } from './pages/AddonsState.js';
import { LegacyWarningStateHolder } from './pages/LegacyWarningState.js';
import { MessageGroupsStateHolder } from './pages/MessageGroupsState.js';

import { ConfigPage } from './pages/ConfigPage.ui.js';
import { HomePage } from './pages/HomePage.ui.js';
import { SessionBlocksPage } from './pages/SessionBlocksPage.ui.js';
import { DetailPage } from './pages/DetailPage.ui.js';
import { EditPage } from './pages/EditPage.ui.js';
import { ConfirmPage } from './pages/ConfirmPage.ui.js';
import { AboutPage } from './pages/AboutPage.ui.js';
import { OpenSourcePage } from './pages/OpenSourcePage.ui.js';
import { AddonsPage } from './pages/AddonsPage.ui.js';
import { LegacyWarningPage } from './pages/LegacyWarningPage.ui.js';
import { MessageGroupsPage } from './pages/MessageGroupsPage.ui.js';
import { MessageGroupEditPage } from './pages/MessageGroupEditPage.ui.js';
import { Banner } from './components/Banner.ui.js';

const DB_PATH = "/storage/emulated/0/Download/Operit/overmem/mem.db";

export default function DashboardScreen(ctx: any): any {
  const cs = ctx.MaterialTheme.colorScheme;

  const dashboard = ctx.useMemo('dash_state', () => {
    try {
      const db = DatabaseManager.getInstance(DB_PATH);
      db.initialize();
      const version = db.getDbVersion();
      const ready = db.isReady();
      logInfo("UI", `Dashboard 初始化：dbVersion=v${version}, ready=${ready}`);

      let initialPage: NavEntry;

      if (version !== CURRENT_DB_VERSION) {
        // v3 / v4 / UNKNOWN：都需要迁移
        initialPage = { page: 'legacy_warning', data: null };
        logInfo("UI", `Dashboard 初始页: legacy_warning (v${version} 待迁移)`);
      } else {
        const complete = isSetupComplete();
        const settings = loadSettings();
        const valid = complete && settings !== null;
        logInfo("UI",
          `配置检查: setupComplete=${complete}, settingsLoaded=${settings !== null}, valid=${valid}`);
        initialPage = { page: valid ? 'home' : 'config', data: null };
        logInfo("UI", `Dashboard 初始页: ${initialPage.page}`);
      }

      return new DashboardState(initialPage);
    } catch (e: any) {
      logError("UI", `Dashboard 初始化失败: ${sanError(e)}`);
      return new DashboardState({ page: 'config', data: null });
    }
  }, []);

  const welcomeH = ctx.useMemo('welcome_h', () => new WelcomeStateHolder(dashboard, DB_PATH), []);
  const configH = ctx.useMemo('config_h', () => new ConfigStateHolder(dashboard), []);
  const overviewH = ctx.useMemo('overview_h', () => new OverviewStateHolder(dashboard, DB_PATH), []);
  const sessionsH = ctx.useMemo('sessions_h', () => new SessionsListStateHolder(dashboard, DB_PATH), []);
  const settingsH = ctx.useMemo('settings_h', () => new SettingsStateHolder(dashboard), []);
  const sessionBlocksH = ctx.useMemo('session_blocks_h', () => new SessionBlocksStateHolder(dashboard, DB_PATH), []);
  const detailH = ctx.useMemo('detail_h', () => new DetailStateHolder(dashboard, DB_PATH), []);
  const editH = ctx.useMemo('edit_h', () => new EditStateHolder(dashboard, DB_PATH), []);
  const confirmH = ctx.useMemo('confirm_h', () => new ConfirmStateHolder(dashboard), []);
  const aboutH = ctx.useMemo('about_h', () => new AboutStateHolder(dashboard), []);
  const addonsH = ctx.useMemo('addons_h', () => new AddonsStateHolder(dashboard), []);
  const legacyWarningH = ctx.useMemo('legacy_warning_h', () => new LegacyWarningStateHolder(dashboard), []);
  const messageGroupsH = ctx.useMemo('message_groups_h',
    () => new MessageGroupsStateHolder(dashboard, DB_PATH), []);

  const [tick, setTick] = ctx.useState('dashboard_tick', 0);

  ctx.useMemo('dash_subscribe', () => {
    const off1 = dashboard.onChange(() => setTick((t: number) => t + 1));

    const off2 = dashboard.nav.onChange(() => {
      setTick((t: number) => t + 1);

      const entry = dashboard.nav.current();
      logInfo("UI",
        `导航: ${entry.page}` +
        (entry.data ? `, data=${sanContent(JSON.stringify(entry.data))}` : ''));

      if (entry.page === 'home') {
        welcomeH.refresh();
        overviewH.refresh();
      } else if (entry.page === 'config') {
        configH.reload();
      } else if (entry.page === 'session_blocks') {
        sessionsH.refresh();
      } else if (entry.page === 'about') {
        aboutH.refresh();
      } else if (entry.page === 'addons') {
        addonsH.refresh();
      } else if (entry.page === 'message_groups') {
        messageGroupsH.load();
      }
    });

    const entry = dashboard.nav.current();
    if (entry.page === 'home') {
      welcomeH.refresh();
      overviewH.refresh();
    } else if (entry.page === 'config') {
      configH.reload();
    }

    return () => { off1(); off2(); };
  }, []);

  const entry = dashboard.nav.current();
  const content = renderRoute(ctx, entry, {
    dashboard, welcomeH, configH, overviewH, sessionsH, settingsH,
    sessionBlocksH, detailH, editH, confirmH, aboutH, addonsH,
    legacyWarningH, messageGroupsH
  });

  const banner = dashboard.getBanner();

  return ctx.UI.Box({ fillMaxSize: true }, [
    ctx.UI.Surface({
      fillMaxSize: true,
      containerColor: cs.background
    }, [content]),
    banner.visible ? Banner(ctx, banner, () => dashboard.dismissBanner()) : ctx.UI.Spacer({ height: 0 })
  ]);
}

interface Holders {
  dashboard: DashboardState;
  welcomeH: WelcomeStateHolder;
  configH: ConfigStateHolder;
  overviewH: OverviewStateHolder;
  sessionsH: SessionsListStateHolder;
  settingsH: SettingsStateHolder;
  sessionBlocksH: SessionBlocksStateHolder;
  detailH: DetailStateHolder;
  editH: EditStateHolder;
  confirmH: ConfirmStateHolder;
  aboutH: AboutStateHolder;
  addonsH: AddonsStateHolder;
  legacyWarningH: LegacyWarningStateHolder;
  messageGroupsH: MessageGroupsStateHolder;
}

function renderRoute(ctx: any, entry: NavEntry, h: Holders): any {
  switch (entry.page) {
    case 'legacy_warning':
      return LegacyWarningPage(ctx, h.legacyWarningH.get(), {
        onRollback: () => h.legacyWarningH.openRollback(),
        onExport: () => h.legacyWarningH.exportToJson(),
        onMigrate: () => h.legacyWarningH.migrateData(),
        onForceMigrate: () => h.legacyWarningH.forceMigrate()
      });

    case 'message_groups':
      return MessageGroupsPage(ctx, h.messageGroupsH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onRefresh: () => h.messageGroupsH.load(),
        onCreate: () => {
          h.messageGroupsH.clearEdit();
          h.messageGroupsH.bindEdit(null);
          h.dashboard.nav.navigate('message_group_edit', { groupId: null });
        },
        onEdit: (groupId) => {
          h.messageGroupsH.clearEdit();
          h.messageGroupsH.bindEdit(groupId);
          h.dashboard.nav.navigate('message_group_edit', { groupId });
        },
        onDelete: (group) => {
          const data: ConfirmPageData = {
            title: '删除消息组',
            message: `确定删除「${group.name || group.groupId}」吗？此操作不可恢复。`,
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              h.messageGroupsH.deleteGroup(group.groupId, () => {
                h.dashboard.nav.pop();
              });
            }
          };
          h.confirmH.bind(data);
          h.dashboard.nav.navigate('confirm');
        },
        onToggleEnabled: (groupId) => h.messageGroupsH.toggleEnabled(groupId),
        onMoveUp: (index) => h.messageGroupsH.moveUp(index),
        onMoveDown: (index) => h.messageGroupsH.moveDown(index)
      });

    case 'message_group_edit': {
      // bindEdit 是同步方法，调用后 editState 立即就绪，同一次渲染即可出画面
      if (!h.messageGroupsH.getEdit()) {
        h.messageGroupsH.bindEdit(entry.data?.groupId ?? null);
      }
      const editState = h.messageGroupsH.getEdit();
      if (!editState) {
        return ctx.UI.Box({ fillMaxSize: true, contentAlignment: 'center' }, [
          ctx.UI.Text({ text: '加载编辑页失败' })
        ]);
      }
      const draft = editState.draft;
      return MessageGroupEditPage(ctx, editState, {
        onBack: () => {
          h.messageGroupsH.clearEdit();
          h.dashboard.nav.pop();
        },
        onPatch: (p) => h.messageGroupsH.patchEdit(p),
        onPatchInclusions: (p) => h.messageGroupsH.patchInclusions(p),
        onPatchExclusions: (p) => h.messageGroupsH.patchExclusions(p),
        onPatchPersonality: (p) => h.messageGroupsH.patchPersonality(p),
        onSessionSearchChange: (v) => h.messageGroupsH.patchSessionSearch(v),
        onSave: () => {
          h.messageGroupsH.saveEdit(() => {
            h.dashboard.nav.pop();
          });
        },
        onDelete: () => {
          const data: ConfirmPageData = {
            title: '删除消息组',
            message: `确定删除「${draft.name || draft.groupId}」吗？此操作不可恢复。`,
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              h.messageGroupsH.deleteGroup(draft.groupId, () => {
                h.dashboard.nav.pop(2);
              });
            }
          };
          h.confirmH.bind(data);
          h.dashboard.nav.navigate('confirm');
        }
      });
    }

    case 'config':
      return ConfigPage(ctx, h.configH.get(), {
        onPatch: (p) => h.configH.patch(p),
        onFetchModels: () => h.configH.fetchModels(),
        onTest: () => h.configH.test(),
        onComplete: () => h.configH.complete()
      });

    case 'home':
      return HomePage(
        ctx,
        h.welcomeH.get(),
        h.overviewH.get(),
        h.sessionsH.get(),
        h.settingsH.get(),
        h.addonsH.get(),
        {
          onTabChange: (tab) => {
            h.welcomeH.setHomeTab(tab);
            if (tab === 'sessions') h.sessionsH.refresh();
            if (tab === 'settings') {
              h.settingsH.loadConfig();
              h.settingsH.refreshLogSize();
              h.settingsH.refreshPendingStatus();
              h.settingsH.refreshClientStatus();
            }
          },
          onSubTabChange: (sub) => h.welcomeH.setSessionsSubTab(sub),
          onRefreshWelcome: () => h.welcomeH.refresh(),
          onRefreshOverview: () => h.overviewH.refresh(),
          onSelectLevel: (lv) => h.overviewH.setSelectedLevel(lv),
          onOpenBlock: (block, level) => h.dashboard.nav.navigate('detail', { block, level }),
          onRefreshSessions: () => h.sessionsH.refresh(),
          onOpenSession: (sessionId, title) => h.dashboard.nav.navigate('session_blocks', { sessionId, title }),
          onRefreshAddons: () => h.addonsH.refresh(),
          addons: {
            onBack: () => {},
            onSelectMode: (m) => h.addonsH.selectMode(m),
            onStartDeploy: () => h.addonsH.startDeploy(),
            onRemoteUrlChange: (v) => h.addonsH.setRemoteUrl(v),
            onConnectRemote: () => h.addonsH.connectRemote()
          },
          settings: {
            onPatch: (p) => h.settingsH.patchSetting(p),
            onSave: () => h.settingsH.save(),
            onSyncPending: () => h.settingsH.syncPending(),
            onRefreshPendingStatus: () => h.settingsH.refreshPendingStatus(),
            onRefreshLogSize: () => h.settingsH.refreshLogSize(),
            onDeleteLog: () => h.settingsH.deleteLog(),
            onResetAiConfig: () => h.settingsH.openConfigPage(),
            onOpenMessageGroups: () => h.settingsH.manageMessageGroups(),
            onRefreshMessageGroups: () => h.settingsH.refreshMessageGroups(),
            onInstallClient: () => h.settingsH.installClient(),
            onRefreshClientStatus: () => h.settingsH.refreshClientStatus(),
            onOpenAddons: () => h.dashboard.nav.navigate('addons'),
            onOpenAbout: () => h.dashboard.nav.navigate('about'),
            clientHasUpdate: () => h.settingsH.clientHasUpdate()
          }
        }
      );

    case 'detail': {
      h.detailH.bind(entry.data);
      return DetailPage(ctx, h.detailH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onEdit: () => h.dashboard.nav.navigate('edit', entry.data),
        onDelete: (level, id) => {
          const data: ConfirmPageData = {
            title: '确认删除',
            message: '确定要删除此' + (level === 'short' ? '短期' : level === 'mid' ? '中期' : '长期') + '记忆块吗？此操作不可恢复。',
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              await h.detailH.performDelete(level, id);
              h.dashboard.nav.pop(2);
              h.overviewH.refresh();
              h.welcomeH.refresh();
            }
          };
          h.confirmH.bind(data);
          h.dashboard.nav.navigate('confirm');
        }
      });
    }

    case 'edit': {
      h.editH.bind(entry.data);
      return EditPage(ctx, h.editH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onPatch: (p) => h.editH.patch(p),
        onSave: () => h.editH.save()
      });
    }

    case 'session_blocks': {
      h.sessionBlocksH.bind(entry.data);
      return SessionBlocksPage(ctx, h.sessionBlocksH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onOpenBlock: (block, level) => h.dashboard.nav.navigate('detail', { block, level }),
        onForceMid: (sessionId) => h.sessionBlocksH.forceMid(sessionId),
        onForceLong: (sessionId) => h.sessionBlocksH.forceLong(sessionId)
      });
    }

    case 'confirm': {
      return ConfirmPage(ctx, h.confirmH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onConfirm: () => h.confirmH.confirm()
      });
    }

    case 'about': {
      return AboutPage(ctx, h.aboutH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onCheckUpdate: () => h.aboutH.checkUpdate(),
        onTogglePreview: (v) => h.aboutH.setPreviewEnabled(v),
        onOpenRepo: () => h.aboutH.openRepo(),
        onOpenSource: () => h.dashboard.nav.navigate('open_source')
      });
    }

    case 'open_source':
      return OpenSourcePage(ctx, {
        onBack: () => h.dashboard.nav.pop(),
        onOpenUrl: (url) => h.aboutH.openBrowser(url)
      });

    case 'addons': {
      return AddonsPage(ctx, h.addonsH.get(), {
        onBack: () => h.dashboard.nav.pop(),
        onSelectMode: (m) => h.addonsH.selectMode(m),
        onStartDeploy: () => h.addonsH.startDeploy(),
        onRemoteUrlChange: (v) => h.addonsH.setRemoteUrl(v),
        onConnectRemote: () => h.addonsH.connectRemote()
      });
    }

    default:
      logDebug("UI", `未知页面: ${entry.page}`);
      return ctx.UI.Text({ text: '未知页面' });
  }
}