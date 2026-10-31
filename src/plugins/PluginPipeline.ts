// plugins/PluginPipeline.ts
/// <reference path="../../types/index.d.ts" />

import { logInfo, logDebug, logError } from '../utils/Logger.js';
import { QueueItem } from '../db/models.js';
import { PluginRuntimeClient, DEFAULT_RUNTIME_URL, Capability } from './PluginRuntimeClient.js';

/**
 * PluginPipeline —— 插件运行时与记忆链路之间的桥。
 *
 * 0.4.0 只提供接口，不接入 MemoryInjector（见 MemoryInjector.buildQueue 里的注释点）。
 * 运行时不可用或插件失败时一律回退为原始数据，不影响主链路。
 */
export class PluginPipeline {
  private static instance: PluginPipeline | null = null;
  private client: PluginRuntimeClient;

  private constructor(client?: PluginRuntimeClient) {
    this.client = client || PluginRuntimeClient.getInstance(DEFAULT_RUNTIME_URL);
  }

  static getInstance(): PluginPipeline {
    if (!PluginPipeline.instance) {
      PluginPipeline.instance = new PluginPipeline();
    }
    return PluginPipeline.instance;
  }

  async isAvailable(): Promise<boolean> {
    const health = await this.client.health();
    return health.ok;
  }

  async transform(blocks: QueueItem[]): Promise<QueueItem[]> {
    const caps = await this.client.capabilities();
    const selected = caps.filter((c: Capability) => c.capability.indexOf('transform.') === 0);
    if (selected.length === 0) {
      logDebug('PluginPipeline', '没有 transform.* 能力，跳过');
      return blocks;
    }

    let result = blocks;
    for (const c of selected) {
      const r = await this.client.invoke(c.plugin, c.capability, { blocks: result });
      if (r.ok && Array.isArray(r.result)) {
        result = r.result as QueueItem[];
      } else {
        const reason = r.error && r.error.message ? r.error.message : '未知错误';
        logError('PluginPipeline', '插件 ' + c.plugin + ':' + c.capability + ' 失败: ' + reason);
      }
    }
    if (result !== blocks) {
      logInfo('PluginPipeline', 'transform 插件处理完成: ' + blocks.length + ' → ' + result.length + ' 块');
    }
    return result;
  }
}
