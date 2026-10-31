// ui/dashboard/pages/AddonsState.ts
/// <reference path="../../../../types/index.d.ts" />

import { DashboardState } from '../DashboardState.js';
import { logInfo, logDebug, logError } from '../../../utils/Logger.js';
import { sanError } from '../../../utils/Sanitizer.js';
import { formatBytes, formatSpeed, formatEta } from '../../../utils/Formatter.js';
import {
  DEPLOY_STEPS,
  DeployStepKey,
  deployRuntimeLocal,
  connectRuntimeRemote
} from '../../../plugins/RuntimeInstaller.js';
import { PluginRuntimeClient, DEFAULT_RUNTIME_URL } from '../../../plugins/PluginRuntimeClient.js';

export type AddonsDeployMode = 'undecided' | 'local' | 'remote';
export type DeployStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface DeployStepView {
  key: string;
  label: string;
  status: DeployStepStatus;
  detail: string;
}

export interface AddonsUiState {
  runtimeAvailable: boolean;
  runtimeVersion: string;
  addonCount: number;
  addonList: any[];
  deployMode: AddonsDeployMode;
  deploying: boolean;
  deploySteps: DeployStepView[];
  deployProgress: number;
  deployReceivedText: string;
  deploySpeedText: string;
  deployEtaText: string;
  deployStatus: string;
  remoteUrl: string;
}

function initialSteps(): DeployStepView[] {
  return DEPLOY_STEPS.map((s) => ({ key: s.key, label: s.label, status: 'pending', detail: '' }));
}

export class AddonsStateHolder {
  private dashboard: DashboardState;
  private state: AddonsUiState = {
    runtimeAvailable: false,
    runtimeVersion: '',
    addonCount: 0,
    addonList: [],
    deployMode: 'undecided',
    deploying: false,
    deploySteps: initialSteps(),
    deployProgress: -1,
    deployReceivedText: '',
    deploySpeedText: '',
    deployEtaText: '',
    deployStatus: '',
    remoteUrl: DEFAULT_RUNTIME_URL
  };

  constructor(dashboard: DashboardState) {
    this.dashboard = dashboard;
  }

  get(): AddonsUiState { return this.state; }

  refresh(): void {
    this.state = {
      ...this.state,
      addonCount: 0,
      addonList: []
    };
    this.dashboard.notify();
    this.detectRuntime();
  }

  /** 选择部署方式：本地部署 / 远程连接 */
  selectMode(mode: AddonsDeployMode): void {
    if (this.state.deploying) return;
    logInfo('Addons', '部署方式: ' + mode);
    this.state = {
      ...this.state,
      deployMode: mode,
      deployStatus: '',
      deployProgress: -1
    };
    this.dashboard.notify();
  }

  setRemoteUrl(url: string): void {
    this.state = { ...this.state, remoteUrl: url };
    this.dashboard.notify();
  }

  /** 本地部署：下载 → 解压 → 装依赖 → 启动 → 健康检查 */
  async startDeploy(): Promise<void> {
    if (this.state.deploying) return;

    logInfo('Addons', '开始本地部署');
    this.state = {
      ...this.state,
      deploying: true,
      deploySteps: initialSteps(),
      deployProgress: -1,
      deployReceivedText: '',
      deploySpeedText: '',
      deployEtaText: '',
      deployStatus: '正在部署…'
    };
    this.dashboard.notify();

    const result = await deployRuntimeLocal(
      (key: DeployStepKey, status: 'running' | 'done' | 'failed', detail: string) => {
        this.updateStep(key, status, detail);
      },
      (p) => {
        this.patchProgress(p.percent, p.received, p.total, p.speed, p.eta);
      }
    );

    if (result.ok) {
      this.state = {
        ...this.state,
        deploying: false,
        runtimeAvailable: true,
        runtimeVersion: result.version,
        deployProgress: 1,
        deployStatus: '部署完成，运行时 v' + result.version + ' 已就绪'
      };
      logInfo('Addons', '运行时部署完成: v' + result.version);
    } else {
      this.state = {
        ...this.state,
        deploying: false,
        deployStatus: '部署失败: ' + result.error
      };
      logError('Addons', '部署失败: ' + sanError(result.error));
    }
    this.dashboard.notify();
  }

  /** 远程连接：连接已有运行时 */
  async connectRemote(): Promise<void> {
    const url = (this.state.remoteUrl || '').trim();
    this.state = { ...this.state, deployStatus: '正在连接 ' + url + '…' };
    this.dashboard.notify();

    logInfo('Addons', '连接远程运行时: ' + url);
    const result = await connectRuntimeRemote(url);
    if (result.ok) {
      this.state = {
        ...this.state,
        runtimeAvailable: true,
        runtimeVersion: result.version,
        deployStatus: '已连接运行时 v' + result.version
      };
      logInfo('Addons', '远程连接成功: v' + result.version);
    } else {
      this.state = { ...this.state, deployStatus: '连接失败: ' + result.error };
      logError('Addons', '远程连接失败: ' + sanError(result.error));
    }
    this.dashboard.notify();
  }

  private updateStep(key: DeployStepKey, status: DeployStepStatus, detail: string): void {
    const steps = this.state.deploySteps.map((s) =>
      s.key === key ? { key: s.key, label: s.label, status, detail } : s
    );
    this.state = { ...this.state, deploySteps: steps };
    this.dashboard.notify();
  }

  private patchProgress(percent: number, received: number, total: number, speed: number, eta: number): void {
    this.state = {
      ...this.state,
      deployProgress: percent >= 0 ? percent : 0,
      deployReceivedText: total > 0
        ? formatBytes(received) + ' / ' + formatBytes(total)
        : formatBytes(received),
      deploySpeedText: formatSpeed(speed),
      deployEtaText: eta > 0 ? '剩余 ' + formatEta(eta) : ''
    };
    this.dashboard.notify();
  }

  /** 进入页面时探测本地运行时是否已在运行（远程模式不改写客户端地址） */
  private async detectRuntime(): Promise<void> {
    if (this.state.deploying || this.state.deployMode === 'remote') return;
    try {
      const health = await PluginRuntimeClient.getInstance().health();
      if (health.ok) {
        this.state = {
          ...this.state,
          runtimeAvailable: true,
          runtimeVersion: health.version
        };
        logDebug('Addons', '运行时在线: v' + health.version);
        this.dashboard.notify();
      }
    } catch (e: any) {
      logDebug('Addons', '运行时探测失败: ' + sanError(e));
    }
  }
}
