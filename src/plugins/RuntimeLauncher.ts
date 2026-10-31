// plugins/RuntimeLauncher.ts
/// <reference path="../../types/index.d.ts" />

import { logInfo, logWarn, logError } from '../utils/Logger.js';
import { PluginRuntimeClient, DEFAULT_RUNTIME_URL } from './PluginRuntimeClient.js';

const RUNTIME_DIR = '/sdcard/Download/Operit/overmem/plugin_runtime';
const PID_FILE = RUNTIME_DIR + '/runtime.pid';
const LOG_FILE = RUNTIME_DIR + '/runtime.log';
const SESSION_NAME = 'overmem_runtime';
const DEFAULT_PORT = 8765;
const POLL_TIMES = 20;
const POLL_INTERVAL_MS = 500;

/**
 * RuntimeLauncher —— 负责在 Ubuntu 环境里拉起 Python 插件运行时。
 * 不自动 pip install（避免意外网络请求），依赖缺失时只提示。
 */
export class RuntimeLauncher {
  private static instance: RuntimeLauncher | null = null;
  private client: PluginRuntimeClient;
  private sessionId: string = '';
  private launching: boolean = false;

  private constructor() {
    this.client = PluginRuntimeClient.getInstance(DEFAULT_RUNTIME_URL);
  }

  static getInstance(): RuntimeLauncher {
    if (!RuntimeLauncher.instance) {
      RuntimeLauncher.instance = new RuntimeLauncher();
    }
    return RuntimeLauncher.instance;
  }

  async ensureRunning(): Promise<boolean> {
    const health = await this.client.health();
    if (health.ok) {
      return true;
    }
    if (this.launching) {
      logWarn('PluginRuntime', '启动中，跳过重复启动');
      return false;
    }
    this.launching = true;
    try {
      return await this.startRuntime();
    } finally {
      this.launching = false;
    }
  }

  private async startRuntime(): Promise<boolean> {
    const ok = await this.checkEnvironment();
    if (!ok) return false;

    const startCmd =
      'cd ' + RUNTIME_DIR + ' && ' +
      'nohup python3 -m overmem_runtime --port ' + DEFAULT_PORT +
      ' > ' + LOG_FILE + ' 2>&1 & echo $! > ' + PID_FILE;

    const r = await this.exec(startCmd, 15000);
    if (r.exitCode !== 0) {
      logError('PluginRuntime', '启动命令失败 exit=' + r.exitCode + ': ' + this.tail(r.output));
      await this.dumpRuntimeLog();
      return false;
    }

    for (let i = 0; i < POLL_TIMES; i++) {
      await this.sleep(POLL_INTERVAL_MS);
      const health = await this.client.health();
      if (health.ok) {
        logInfo('PluginRuntime', '运行时已就绪 version=' + health.version + ' plugins=' + health.plugins_count);
        return true;
      }
    }

    logError('PluginRuntime', '运行时启动超时');
    await this.dumpRuntimeLog();
    return false;
  }

  private async checkEnvironment(): Promise<boolean> {
    const version = await this.exec('cd ' + RUNTIME_DIR + ' && python3 --version', 5000);
    const text = (version.output || '').trim();
    if (version.exitCode !== 0 || text.indexOf('Python 3.') !== 0) {
      logError('PluginRuntime', 'Python 不可用: ' + this.tail(text || version.output));
      return false;
    }
    const parts = text.split(' ')[1].split('.');
    const minor = parseInt(parts[1], 10);
    if (isNaN(minor) || minor < 10) {
      logError('PluginRuntime', 'Python 版本过低: ' + text + '（需要 3.10+）');
      return false;
    }

    const imported = await this.exec('cd ' + RUNTIME_DIR + ' && python3 -c "import overmem_runtime"', 15000);
    if (imported.exitCode !== 0) {
      logError('PluginRuntime', '插件运行时未安装依赖，请手动执行: cd plugin_runtime && pip3 install -e .  (' + this.tail(imported.output) + ')');
      return false;
    }
    return true;
  }

  async stop(): Promise<void> {
    if (!this.sessionId) {
      const session = await Tools.System.terminal.create(SESSION_NAME);
      this.sessionId = session.sessionId;
    }
    const r = await this.exec(
      'if [ -f ' + PID_FILE + ' ]; then kill $(cat ' + PID_FILE + ') 2>/dev/null; fi',
      5000
    );
    if (r.exitCode !== 0) {
      logWarn('PluginRuntime', '停止运行时返回 exit=' + r.exitCode);
    }
    logInfo('PluginRuntime', '已请求停止运行时');
  }

  private async dumpRuntimeLog(): Promise<void> {
    const r = await this.exec('tail -n 20 ' + LOG_FILE + ' 2>/dev/null', 5000);
    if (r.output) {
      logError('PluginRuntime', 'runtime.log: ' + this.tail(r.output));
    }
  }

  private async ensureSession(): Promise<{ sessionId: string }> {
    const session = await Tools.System.terminal.create(SESSION_NAME);
    this.sessionId = session.sessionId;
    return session;
  }

  private async exec(command: string, timeoutMs: number): Promise<{ output: string; exitCode: number }> {
    try {
      const session = await this.ensureSession();
      const res = await Tools.System.terminal.exec(session.sessionId, command, timeoutMs);
      return {
        output: res && res.output !== undefined && res.output !== null ? String(res.output) : '',
        exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 0
      };
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      logError('PluginRuntime', '终端执行失败: ' + msg);
      return { output: msg, exitCode: 1 };
    }
  }

  private tail(text: string, maxLen: number = 300): string {
    const t = (text || '').trim();
    if (t.length <= maxLen) return t;
    return t.substring(t.length - maxLen);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
