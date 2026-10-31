// plugins/PluginRuntimeClient.ts
/// <reference path="../../types/index.d.ts" />

import { logError } from '../utils/Logger.js';

export interface Capability {
  plugin: string;
  capability: string;
  description: string;
}

export interface InvokeResult {
  ok: boolean;
  result?: any;
  error?: { code: string; message: string };
}

export interface HealthResult {
  ok: boolean;
  version: string;
  plugins_count: number;
}

export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:8765';

type HttpMode = 'java' | 'shell';

/**
 * PluginRuntimeClient —— Python 插件运行时的 JS 侧客户端。
 *
 * 主通道用 OkHttp 直连 127.0.0.1；若 proot 网络隔离导致连不上，
 * 退化为 Tools.System.shell + curl。通道选择在第一次 /health 时确定并缓存。
 */
export class PluginRuntimeClient {
  private baseUrl: string;
  private token: string;
  private mode: HttpMode | null = null;
  private static instance: PluginRuntimeClient | null = null;

  private constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  static getInstance(baseUrl: string = DEFAULT_RUNTIME_URL, token: string = ''): PluginRuntimeClient {
    if (!PluginRuntimeClient.instance) {
      PluginRuntimeClient.instance = new PluginRuntimeClient(baseUrl, token);
    } else {
      if (baseUrl) PluginRuntimeClient.instance.baseUrl = baseUrl.replace(/\/+$/, '');
      if (token) PluginRuntimeClient.instance.token = token;
    }
    return PluginRuntimeClient.instance;
  }

  setToken(token: string): void {
    this.token = token || '';
  }

  getMode(): 'java' | 'shell' | 'unknown' {
    return this.mode === null ? 'unknown' : this.mode;
  }

  async health(): Promise<HealthResult> {
    const data = await this.probe('/health');
    if (!data || data.ok !== true) {
      return { ok: false, version: '', plugins_count: 0 };
    }
    return {
      ok: true,
      version: data.version || '',
      plugins_count: typeof data.plugins_count === 'number' ? data.plugins_count : 0
    };
  }

  async capabilities(): Promise<Capability[]> {
    try {
      const data = await this.request('GET', '/v1/capabilities');
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      logError('PluginRuntime', '获取能力列表失败: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  async invoke(plugin: string, capability: string, args: any): Promise<InvokeResult> {
    try {
      const data = await this.request('POST', '/v1/invoke', {
        plugin: plugin,
        capability: capability,
        args: args === undefined || args === null ? {} : args
      });
      if (data && data.ok === true) {
        return { ok: true, result: data.result };
      }
      return {
        ok: false,
        error: data && data.error ? data.error : { code: 'HTTP_ERROR', message: '响应格式异常' }
      };
    } catch (e: any) {
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: e && e.message ? e.message : String(e) }
      };
    }
  }

  async installFromZipBase64(base64: string, filename: string): Promise<{ ok: boolean; plugin?: any; error?: any }> {
    try {
      const data = await this.request('POST', '/v1/plugins/install-base64', {
        filename: filename,
        data_base64: base64
      });
      return { ok: data && data.ok === true, plugin: data ? data.plugin : undefined };
    } catch (e: any) {
      return { ok: false, error: { message: e && e.message ? e.message : String(e) } };
    }
  }

  async enablePlugin(id: string, enabled: boolean): Promise<void> {
    await this.request('POST', '/v1/plugins/' + encodeURIComponent(id) + '/enable', { enabled: enabled });
  }

  async reloadPlugin(id: string): Promise<void> {
    await this.request('POST', '/v1/plugins/' + encodeURIComponent(id) + '/reload');
  }

  async uninstallPlugin(id: string): Promise<void> {
    await this.request('DELETE', '/v1/plugins/' + encodeURIComponent(id));
  }

  async pluginList(): Promise<any[]> {
    const data = await this.request('GET', '/v1/plugins');
    return data && Array.isArray(data.plugins) ? data.plugins : [];
  }

  // ---- HTTP 通道 ----

  private async probe(path: string): Promise<any> {
    const javaText = await this.tryJava('GET', path);
    if (javaText.ok) {
      this.mode = 'java';
      return PluginRuntimeClient.parse(javaText.text);
    }
    const shellText = await this.tryShell('GET', path);
    if (shellText.ok) {
      this.mode = 'shell';
      return PluginRuntimeClient.parse(shellText.text);
    }
    this.mode = null;
    return null;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = this.baseUrl + path;
    if (this.mode === 'shell') {
      const r = await this.tryShell(method, url, body);
      if (!r.ok) { throw new Error(r.error || 'shell 请求失败'); }
      return PluginRuntimeClient.parse(r.text);
    }
    const j = await this.tryJava(method, url, body);
    if (j.ok) {
      this.mode = 'java';
      return PluginRuntimeClient.parse(j.text);
    }
    if (this.mode === 'java') {
      throw new Error(j.error || '请求失败');
    }
    const s = await this.tryShell(method, url, body);
    if (s.ok) {
      this.mode = 'shell';
      return PluginRuntimeClient.parse(s.text);
    }
    throw new Error(j.error || s.error || '请求失败');
  }

  private async tryJava(method: string, target: string, body?: any): Promise<{ ok: boolean; text: string; error?: string }> {
    const url = target.indexOf('http') === 0 ? target : this.baseUrl + target;
    try {
      const OkHttpClient = Java.type('okhttp3.OkHttpClient');
      const Request = Java.type('okhttp3.Request');
      const TimeUnit = Java.type('java.util.concurrent.TimeUnit');

      const client = new OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build();

      const builder = new Request.Builder()
        .url(url)
        .header('Content-Type', 'application/json')
        .header('Accept', 'application/json');
      if (this.token) {
        builder.header('Authorization', 'Bearer ' + this.token);
      }

      if (method === 'GET') {
        builder.get();
      } else if (method === 'DELETE') {
        builder.delete();
      } else {
        const MediaType = Java.type('okhttp3.MediaType');
        const RequestBody = Java.type('okhttp3.RequestBody');
        const mediaType = MediaType.parse('application/json; charset=utf-8');
        const requestBody = RequestBody.create(JSON.stringify(body === undefined ? {} : body), mediaType);
        builder.method(method, requestBody);
      }

      const response = client.newCall(builder.build()).execute();
      const code = response.code();
      const text = response.body().string();
      response.close();

      if (code < 200 || code >= 300) {
        return { ok: false, text: '', error: 'HTTP ' + code + ': ' + text.substring(0, 200) };
      }
      return { ok: true, text: text };
    } catch (e: any) {
      return { ok: false, text: '', error: e && e.message ? e.message : String(e) };
    }
  }

  private async tryShell(method: string, target: string, body?: any): Promise<{ ok: boolean; text: string; error?: string }> {
    const url = target.indexOf('http') === 0 ? target : this.baseUrl + target;
    try {
      let cmd = 'curl -sS --max-time 5 -H ' + PluginRuntimeClient.sq('Content-Type: application/json');
      if (this.token) {
        cmd += ' -H ' + PluginRuntimeClient.sq('Authorization: Bearer ' + this.token);
      }
      if (method === 'GET') {
        cmd += ' ' + PluginRuntimeClient.sq(url);
      } else {
        cmd += ' -X ' + method + ' --data-raw ' + PluginRuntimeClient.sq(JSON.stringify(body === undefined ? {} : body));
        cmd += ' ' + PluginRuntimeClient.sq(url);
      }
      const res = await Tools.System.shell(cmd);
      const out = (res && res.output !== undefined && res.output !== null) ? String(res.output).trim() : '';
      const code = res && typeof res.exitCode === 'number' ? res.exitCode : 0;
      if (code !== 0) {
        return { ok: false, text: '', error: 'curl exit=' + code + ': ' + out.substring(0, 200) };
      }
      return { ok: true, text: out };
    } catch (e: any) {
      return { ok: false, text: '', error: e && e.message ? e.message : String(e) };
    }
  }

  private static parse(text: string): any {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  private static sq(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
}
