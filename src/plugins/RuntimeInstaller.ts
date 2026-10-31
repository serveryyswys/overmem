// plugins/RuntimeInstaller.ts
/// <reference path="../../types/index.d.ts" />

import { logInfo, logError } from '../utils/Logger.js';
import { httpGetWithTimeout } from '../utils/HttpHelper.js';
import { downloadFile } from '../utils/Downloader.js';
import { buildApkUrl, formatBytes } from '../utils/Formatter.js';
import { RuntimeLauncher } from './RuntimeLauncher.js';
import { PluginRuntimeClient } from './PluginRuntimeClient.js';

/** 云端目录 API（与独立客户端同一套下载服务） */
export const RUNTIME_API_URL = 'https://www.serveryyswys.top/download/api/OperitToolpkgOvermem';
const RUNTIME_DOWNLOAD_HOST = 'https://www.serveryyswys.top';

/** 运行时安装目录（终端 / proot 视角），与 RuntimeLauncher 保持一致 */
export const RUNTIME_ROOT = '/sdcard/Download/Operit/overmem/plugin_runtime';

/** 运行时安装目录（宿主文件 API 视角），与上面是同一个物理目录 */
const RUNTIME_FS_ROOT = '/storage/emulated/0/Download/Operit/overmem/plugin_runtime';

const INSTALL_SESSION = 'overmem_runtime_install';
const STEP_TIMEOUT_MS = 60000;
const PIP_TIMEOUT_MS = 480000;

/** 运行时依赖（与 plugin_runtime/pyproject.toml 对齐） */
const PIP_PACKAGES = [
  'fastapi',
  'uvicorn[standard]',
  'pyyaml',
  'bcrypt',
  'pyjwt',
  'pydantic',
  'python-multipart'
];

export type DeployStepKey = 'probe' | 'download' | 'extract' | 'deps' | 'start' | 'health';
export type DeployStepStatus = 'running' | 'done' | 'failed';

export interface DeployStepDef {
  key: DeployStepKey;
  label: string;
}

/** 本地部署的固定步骤 */
export const DEPLOY_STEPS: DeployStepDef[] = [
  { key: 'probe', label: '获取运行时信息' },
  { key: 'download', label: '下载运行时包' },
  { key: 'extract', label: '解压到运行时目录' },
  { key: 'deps', label: '安装 Python 依赖' },
  { key: 'start', label: '启动运行时服务' },
  { key: 'health', label: '健康检查' }
];

export interface RuntimePackageInfo {
  version: string;
  fileName: string;
  sizeBytes: number;
  url: string;
}

export interface DeployProgress {
  percent: number;
  received: number;
  total: number;
  speed: number;
  eta: number;
}

export interface DeployResult {
  ok: boolean;
  version: string;
  error: string;
}

/**
 * 读云端目录 API + 文件 API，拿到运行时包的版本、大小与下载地址。
 */
export async function probeRuntime(): Promise<RuntimePackageInfo> {
  logInfo('RuntimeInstaller', '请求目录 API: ' + RUNTIME_API_URL);
  const dirJson = await httpGetWithTimeout(RUNTIME_API_URL, 15);
  const dirApi = JSON.parse(dirJson);
  if (!dirApi || dirApi.code !== 0) {
    throw new Error('目录 API 返回错误: code=' + (dirApi && dirApi.code !== undefined ? dirApi.code : '??'));
  }

  const metaPath = (dirApi.metadata && dirApi.metadata.meta && dirApi.metadata.meta.runtime) || '';
  const latestFile = (dirApi.metadata && dirApi.metadata.latest && dirApi.metadata.latest.runtime) || '';
  const version = (dirApi.metadata && dirApi.metadata.latest_version) || '';
  if (!latestFile) throw new Error('API 未返回运行时文件名');

  const fileApiUrl = buildApkUrl(RUNTIME_API_URL, metaPath, latestFile);
  logInfo('RuntimeInstaller', '请求文件 API: ' + fileApiUrl);

  const fileJson = await httpGetWithTimeout(fileApiUrl, 20);
  const fileMeta = JSON.parse(fileJson);
  if (!fileMeta || fileMeta.code !== 0) {
    throw new Error('文件 API 返回错误: code=' + (fileMeta && fileMeta.code !== undefined ? fileMeta.code : '??'));
  }

  const downloadPath = (fileMeta.file && fileMeta.file.download_url) || '';
  if (!downloadPath) throw new Error('文件 API 未返回 download_url');

  const url = downloadPath.indexOf('http') === 0 ? downloadPath : RUNTIME_DOWNLOAD_HOST + downloadPath;
  const sizeBytes = Number((fileMeta.file && fileMeta.file.size_bytes) || 0);

  return { version, fileName: latestFile, sizeBytes, url };
}

/**
 * 本地部署：下载 → 解压 → 装依赖 → 启动 → 健康检查。
 * onStep 每次步骤状态变化回调，onProgress 只在下载阶段回调。
 */
export async function deployRuntimeLocal(
  onStep: (key: DeployStepKey, status: DeployStepStatus, detail: string) => void,
  onProgress?: (p: DeployProgress) => void
): Promise<DeployResult> {
  let current: DeployStepKey = 'probe';

  try {
    // ---- 1. 获取运行时信息 ----
    onStep('probe', 'running', '');
    const info = await probeRuntime();
    onStep('probe', 'done', 'v' + info.version + ' · ' + info.fileName);
    logInfo('RuntimeInstaller', '运行时包: ' + info.fileName + ', ' + info.sizeBytes + ' bytes');

    // ---- 2. 下载 ----
    current = 'download';
    onStep('download', 'running', formatBytes(info.sizeBytes));
    const zipPath = RUNTIME_FS_ROOT + '/dist/' + info.fileName;
    await downloadFile(info.url, zipPath, (p) => {
      if (!onProgress) return;
      onProgress({
        percent: p.percent,
        received: p.bytesReceived,
        total: p.totalBytes > 0 ? p.totalBytes : info.sizeBytes,
        speed: p.speedBytesPerSec,
        eta: p.etaSeconds
      });
    }, info.sizeBytes);
    onStep('download', 'done', formatBytes(info.sizeBytes));

    // ---- 3. 解压并整理目录 ----
    current = 'extract';
    onStep('extract', 'running', '');
    await Tools.Files.mkdir(RUNTIME_FS_ROOT, true, 'android');
    const unzipRes: any = await Tools.Files.unzip(zipPath, RUNTIME_FS_ROOT, 'android');
    if (unzipRes && unzipRes.success === false) {
      throw new Error('解压失败: ' + (unzipRes.message || '未知原因'));
    }
    const topDir = info.fileName.replace(/\.zip$/i, '');
    const moved = await shell(
      "cd '" + RUNTIME_ROOT + "' && rm -rf overmem_runtime && " +
      "cp -a '" + topDir + "'/. . && rm -rf '" + topDir + "' && " +
      'test -f overmem_runtime/__init__.py',
      STEP_TIMEOUT_MS
    );
    if (moved.exitCode !== 0) {
      throw new Error('解压后整理失败: ' + tail(moved.output));
    }
    onStep('extract', 'done', RUNTIME_ROOT);

    // ---- 4. 安装依赖 ----
    current = 'deps';
    onStep('deps', 'running', 'pip3 install');
    const depCmd = "cd '" + RUNTIME_ROOT + "' && pip3 install --no-cache-dir " +
      PIP_PACKAGES.map((p) => "'" + p + "'").join(' ');
    logInfo('RuntimeInstaller', '安装依赖: ' + depCmd);
    const dep = await shell(depCmd, PIP_TIMEOUT_MS);
    if (dep.exitCode !== 0) {
      throw new Error('依赖安装失败: ' + tail(dep.output, 400));
    }
    onStep('deps', 'done', '');

    // ---- 5. 启动 ----
    current = 'start';
    onStep('start', 'running', '');
    const started = await RuntimeLauncher.getInstance().ensureRunning();
    if (!started) {
      throw new Error('运行时启动失败，请查看 runtime.log');
    }
    onStep('start', 'done', '');

    // ---- 6. 健康检查 ----
    current = 'health';
    onStep('health', 'running', '');
    const health = await PluginRuntimeClient.getInstance().health();
    if (!health.ok) {
      throw new Error('健康检查失败，运行时未响应 /health');
    }
    onStep('health', 'done', 'v' + (health.version || '?') + ' · ' + health.plugins_count + ' 插件');
    logInfo('RuntimeInstaller', '部署完成: version=' + health.version + ', plugins=' + health.plugins_count);

    return { ok: true, version: health.version || info.version, error: '' };
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    logError('RuntimeInstaller', '部署失败（' + current + '）: ' + msg);
    onStep(current, 'failed', msg);
    return { ok: false, version: '', error: msg };
  }
}

/**
 * 连接已在别处运行的运行时（远程连接）。
 */
export async function connectRuntimeRemote(url: string): Promise<DeployResult> {
  const target = (url || '').trim();
  if (!target) return { ok: false, version: '', error: '运行时地址为空' };

  try {
    logInfo('RuntimeInstaller', '连接远程运行时: ' + target);
    const client = PluginRuntimeClient.getInstance(target);
    const health = await client.health();
    if (!health.ok) {
      return { ok: false, version: '', error: '无法连接 ' + target };
    }
    logInfo('RuntimeInstaller', '远程运行时可用: version=' + health.version);
    return { ok: true, version: health.version, error: '' };
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    logError('RuntimeInstaller', '远程连接失败: ' + msg);
    return { ok: false, version: '', error: msg };
  }
}

async function shell(command: string, timeoutMs: number): Promise<{ output: string; exitCode: number }> {
  try {
    const session = await Tools.System.terminal.create(INSTALL_SESSION);
    const res = await Tools.System.terminal.exec(session.sessionId, command, timeoutMs);
    const output = res && res.output !== undefined && res.output !== null ? String(res.output) : '';
    const exitCode = res && typeof res.exitCode === 'number' ? res.exitCode : 0;
    return { output, exitCode };
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    logError('RuntimeInstaller', '终端执行失败: ' + msg);
    return { output: msg, exitCode: 1 };
  }
}

function tail(text: string, maxLen: number = 300): string {
  const t = (text || '').trim();
  if (t.length <= maxLen) return t;
  return t.substring(t.length - maxLen);
}

