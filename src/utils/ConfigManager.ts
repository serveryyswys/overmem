/// <reference path="../../types/index.d.ts" />
const fs = require('fs');
const path = require('path');

import { logInfo, logError, logDebug } from './Logger.js';
import { sanPath, sanError } from './Sanitizer.js';

const BASE_DIR = "/storage/emulated/0/Download/Operit/overmem/";
const SETUP_LOCK_FILE = BASE_DIR + ".setuplock";
const SETTINGS_FILE = BASE_DIR + "settings.json";

export interface OverMemSettings {
  basicUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  encryptVersion: number;
}

const DEFAULT_SETTINGS: OverMemSettings = {
  basicUrl: "",
  apiKey: "",
  model: "",
  models: [],
  encryptVersion: 1
};

function fileExists(p: string): boolean {
  try {
    const exists = fs.existsSync(p);
    logDebug("ConfigFile", `exists ${sanPath(p)} = ${exists}`);
    return exists;
  } catch (e: any) {
    logError("ConfigFile", `exists 检查失败 ${sanPath(p)}: ${sanError(e)}`);
    return false;
  }
}

function readFile(p: string): string | null {
  try {
    if (!fs.existsSync(p)) {
      logDebug("ConfigFile", `readFile ${sanPath(p)}：文件不存在`);
      return null;
    }
    const content = fs.readFileSync(p, 'utf8');
    if (typeof content !== 'string') {
      logError("ConfigFile", `readFile ${sanPath(p)}：返回非字符串 type=${typeof content}`);
      return null;
    }
    const trimmed = content.trim();
    logDebug("ConfigFile", `readFile ${sanPath(p)}：长度=${trimmed.length}`);
    return trimmed;
  } catch (e: any) {
    logError("ConfigFile", `readFile ${sanPath(p)} 失败: ${sanError(e)}`);
    return null;
  }
}

function writeFile(p: string, content: string): boolean {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(p, content, 'utf8');
    logInfo("ConfigFile", `writeFile ${sanPath(p)}：长度=${content.length}`);
    return true;
  } catch (e: any) {
    logError("ConfigFile", `writeFile ${sanPath(p)} 失败: ${sanError(e)}`);
    return false;
  }
}

const XOR_KEY = "OverMem_2024_Secret_Key_v1";

function encryptApiKey(plain: string): string {
  try {
    let result = "";
    for (let i = 0; i < plain.length; i++) {
      const keyChar = XOR_KEY.charCodeAt(i % XOR_KEY.length);
      const charCode = plain.charCodeAt(i) ^ keyChar;
      result += String.fromCharCode(charCode);
    }
    return btoa(result);
  } catch (e: any) {
    logError("Config", `encryptApiKey 失败: ${sanError(e)}`);
    return "";
  }
}

function decryptApiKey(encrypted: string): string {
  try {
    const decoded = atob(encrypted);
    let result = "";
    for (let i = 0; i < decoded.length; i++) {
      const keyChar = XOR_KEY.charCodeAt(i % XOR_KEY.length);
      const charCode = decoded.charCodeAt(i) ^ keyChar;
      result += String.fromCharCode(charCode);
    }
    return result;
  } catch (e: any) {
    logError("Config", `decryptApiKey 失败: ${sanError(e)}`);
    return "";
  }
}

function btoa(str: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let result = '';
  let i = 0;
  while (i < str.length) {
    const a = str.charCodeAt(i++);
    const b = i < str.length ? str.charCodeAt(i++) : 0;
    const c = i < str.length ? str.charCodeAt(i++) : 0;
    const bits = (a << 16) | (b << 8) | c;
    result += chars.charAt((bits >> 18) & 63);
    result += chars.charAt((bits >> 12) & 63);
    result += i - 1 < str.length ? chars.charAt((bits >> 6) & 63) : '=';
    result += i < str.length ? chars.charAt(bits & 63) : '=';
  }
  return result;
}

function atob(str: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let result = '';
  let i = 0;
  while (i < str.length) {
    const a = chars.indexOf(str.charAt(i++));
    const b = chars.indexOf(str.charAt(i++));
    const c = chars.indexOf(str.charAt(i++));
    const d = chars.indexOf(str.charAt(i++));
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    result += String.fromCharCode((bits >> 16) & 255);
    if (c !== 64) result += String.fromCharCode((bits >> 8) & 255);
    if (d !== 64) result += String.fromCharCode(bits & 255);
  }
  return result;
}

export function isSetupComplete(): boolean {
  const complete = fileExists(SETUP_LOCK_FILE);
  logInfo("Config", `isSetupComplete: ${complete}`);
  return complete;
}

export function loadSettings(): OverMemSettings | null {
  try {
    logInfo("Config", `loadSettings 开始`);
    const content = readFile(SETTINGS_FILE);
    if (!content) {
      logInfo("Config", `loadSettings：文件不存在或为空`);
      return null;
    }

    let raw: any;
    try {
      raw = JSON.parse(content);
    } catch (e: any) {
      logError("Config", `loadSettings JSON 解析失败: ${sanError(e)}`);
      return null;
    }

    if (!raw || typeof raw !== 'object') {
      logError("Config", `loadSettings 解析结果非对象 type=${typeof raw}`);
      return null;
    }

    const settings: OverMemSettings = {
      basicUrl: raw.basicUrl || "",
      apiKey: raw.apiKey || "",
      model: raw.model || "",
      models: Array.isArray(raw.models) ? raw.models : [],
      encryptVersion: raw.encryptVersion || 1
    };

    if (settings.apiKey && settings.apiKey.indexOf("enc:") === 0) {
      settings.apiKey = decryptApiKey(settings.apiKey.substring(4));
    }

    logInfo("Config",
      `loadSettings 完成：basicUrl=${settings.basicUrl}, model=${settings.model}, apiKeyLen=${settings.apiKey.length}, models=${settings.models.length}`);
    return settings;
  } catch (e: any) {
    logError("Config", `loadSettings 失败: ${sanError(e)}`);
    return null;
  }
}

export function saveSettings(settings: OverMemSettings): boolean {
  try {
    const toSave = { ...settings };
    if (toSave.apiKey) {
      toSave.apiKey = "enc:" + encryptApiKey(toSave.apiKey);
    }
    const content = JSON.stringify(toSave, null, 2);
    logInfo("Config", `saveSettings：长度=${content.length}`);
    return writeFile(SETTINGS_FILE, content);
  } catch (e: any) {
    logError("Config", `saveSettings 失败: ${sanError(e)}`);
    return false;
  }
}

export function markSetupComplete(): boolean {
  try {
    const dir = path.dirname(SETUP_LOCK_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(SETUP_LOCK_FILE)) {
      fs.writeFileSync(SETUP_LOCK_FILE, '', 'utf8');
    }
    logInfo("Config", `markSetupComplete：成功`);
    return true;
  } catch (e: any) {
    logError("Config", `markSetupComplete 失败: ${sanError(e)}`);
    return false;
  }
}

export function resetConfig(): void {
  logInfo("Config", `resetConfig`);
  if (fileExists(SETUP_LOCK_FILE)) {
    try { fs.unlinkSync(SETUP_LOCK_FILE); } catch (_) {}
  }
  if (fileExists(SETTINGS_FILE)) {
    try { fs.unlinkSync(SETTINGS_FILE); } catch (_) {}
  }
}

export async function fetchModels(basicUrl: string, apiKey: string): Promise<string[]> {
  try {
    let url = basicUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    if (!url.endsWith("/")) url += "/";
    url += "models";

    logInfo("Config", `fetchModels: ${url}`);

    const OkHttpClient = Java.type("okhttp3.OkHttpClient");
    const Request = Java.type("okhttp3.Request");
    const TimeUnit = Java.type("java.util.concurrent.TimeUnit");

    const client = new OkHttpClient.Builder()
      .connectTimeout(30, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .build();

    const request = new Request.Builder()
      .url(url)
      .header("Authorization", "Bearer " + apiKey)
      .header("Content-Type", "application/json")
      .get()
      .build();

    const response = client.newCall(request).execute();
    const body = response.body().string();
    const code = response.code();
    response.close();

    logInfo("Config", `fetchModels 响应码: ${code}`);

    if (code < 200 || code >= 300) {
      throw new Error("HTTP " + code + ": " + body.substring(0, 200));
    }

    const data = JSON.parse(body);
    if (data.data && Array.isArray(data.data)) {
      return data.data.map(function(item: any) { return item.id || item.model || item; });
    }
    if (data.models && Array.isArray(data.models)) {
      return data.models;
    }
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  } catch (e: any) {
    logError("Config", `fetchModels 失败: ${sanError(e)}`);
    throw e;
  }
}

export async function testConnection(basicUrl: string, apiKey: string): Promise<{ success: boolean; message: string }> {
  try {
    let url = basicUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    if (!url.endsWith("/")) url += "/";
    url += "models";

    const OkHttpClient = Java.type("okhttp3.OkHttpClient");
    const Request = Java.type("okhttp3.Request");
    const TimeUnit = Java.type("java.util.concurrent.TimeUnit");

    const client = new OkHttpClient.Builder()
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(10, TimeUnit.SECONDS)
      .writeTimeout(10, TimeUnit.SECONDS)
      .build();

    const request = new Request.Builder()
      .url(url)
      .header("Authorization", "Bearer " + apiKey)
      .get()
      .build();

    const response = client.newCall(request).execute();
    const code = response.code();
    const body = response.body().string();
    response.close();

    logInfo("Config", `testConnection 响应码: ${code}`);

    if (code >= 200 && code < 300) {
      return { success: true, message: "连接成功！" };
    } else {
      return { success: false, message: "HTTP " + code + ": " + body.substring(0, 100) };
    }
  } catch (e: any) {
    logError("Config", `testConnection 失败: ${sanError(e)}`);
    return { success: false, message: e.message || "连接失败" };
  }
}