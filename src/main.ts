// main.ts
/// <reference path="../types/index.d.ts" />

// SPDX-FileCopyrightText: 2026 yyswys-yjyj
// SPDX-License-Identifier: GPL-3.0-or-later

import { DatabaseManager } from './db/DatabaseManager.js';
import { ShortTermMemory } from './memory/ShortTerm.js';
import { MemoryInjector } from './memory/MemoryInjector.js';
import { GarbageCollector } from './memory/GarbageCollector.js';
import { SessionHelper } from './utils/SessionHelper.js';
import { makeMsgId } from './utils/MsgId.js';
import { logInfo, logError, logDebug } from './utils/Logger.js';
import DashboardScreen from './ui/dashboard/index.ui.js';
import { ChainWalker } from './memory/ChainWalker.js';
import { LongTermMemory } from './memory/LongTerm.js';

const DB_PATH = "/storage/emulated/0/Download/Operit/overmem/mem.db";
const sessionHelper = SessionHelper.getInstance();

const db = DatabaseManager.getInstance(DB_PATH);
db.initialize();

const shortTerm = new ShortTermMemory();
const injector = new MemoryInjector();

// ============================================
// XML 剥离
// ============================================

/**
 * 剥离 Operit 的 XML 标签，替换成提示语。
 *
 * - <tool_result_XXXX name="xxx" ...>...</tool_result_XXXX> → \n[工具返回：xxx]\n
 * - <tool_XXXX name="xxx" ...>...</tool_XXXX>               → \n[工具调用：xxx]\n
 * - 其余 XML（连内容）→ 丢弃
 *
 * 先剥 result 再剥 call：两者标签名都以 tool_ 开头，
 * 用负向前瞻 (?!result_) 排除 tool_result_* 被 call 的正则误匹配。
 */
function stripOperitXml(content: string): string {
  if (!content) return '';

  let s = String(content);

  // 1. 工具返回
  s = s.replace(
    /<tool_result_[\w]+\b([^>]*)>[\s\S]*?<\/tool_result_[\w]+>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具返回：${name}]\n`;
    }
  );

  // 2. 工具调用
  s = s.replace(
    /<tool_(?!result_)[\w]+\b([^>]*)>[\s\S]*?<\/tool_(?!result_)[\w]+>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具调用：${name}]\n`;
    }
  );

  // 3. 自闭合的工具标签（防御性）
  s = s.replace(
    /<tool_result_[\w]+\b([^>]*)\/>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具返回：${name}]\n`;
    }
  );
  s = s.replace(
    /<tool_(?!result_)[\w]+\b([^>]*)\/>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具调用：${name}]\n`;
    }
  );

  // 4. 其余 XML：连内容一起丢弃
  s = s.replace(/<[a-zA-Z][\w:-]*\b[^>]*>[\s\S]*?<\/[a-zA-Z][\w:-]*>/g, '');
  s = s.replace(/<[a-zA-Z][\w:-]*\b[^>]*\/>/g, '');

  // 5. 合并多余空行、去掉首尾空白
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

/** 从属性字符串里提取某个属性的值，支持双引号和单引号 */
function extractAttr(attrs: string, key: string): string {
  if (!attrs) return '';
  const dq = new RegExp('(?:^|\\s)' + key + '\\s*=\\s*"([^"]*)"').exec(attrs);
  if (dq) return dq[1];
  const sq = new RegExp("(?:^|\\s)" + key + "\\s*=\\s*'([^']*)'").exec(attrs);
  if (sq) return sq[1];
  return '';
}


function stripMemoryAttachment(content: string): string {
  return stripOperitXml(content);
}

// ============================================
// Prompt 注入（MSG_ID + 记忆）
// ============================================

export async function onPromptBeforeProcess(event: any): Promise<any> {
  db.reopen();
  try {
    const payload = event.eventPayload || event;
    const chatId = payload.chatId || event.chatId || '';
    const processedInput = payload.processedInput || '';
    const rawInput = payload.rawInput || processedInput;

    if (!processedInput || processedInput.length === 0) return null;

    // 已注入过则跳过（attachment 已固定在 prompt 里）
    if (processedInput.indexOf('<attachment id="overmem_memory_') >= 0) {
      logInfo("Main", "prompt before_process: 已注入，跳过");
      return null;
    }

    const meta = chatId ? db.getSessionMeta(chatId) : null;
    const roleCardId = meta?.roleCardId || '';
    const scope = db.getScope(chatId, roleCardId);

    // 从 pending user 读 msgId
    const pendingUser = shortTerm.getPendingUser(scope.type, scope.id);
    const msgId = pendingUser?.msgId || '';

    // 记忆队列
    const result = injector.buildQueue(scope.type, scope.id, rawInput);

    // 无论有没有记忆，都注入 attachment（至少带 MSG_ID）
    const injectionText = injector.buildInjectionText(result.queue, msgId);
    const attachmentTag = injector.buildMemoryAttachment(injectionText);

    const messageId = payload.messageId || payload.message_id || '';
    if (result.queue.length > 0) {
      injector.recordInjection(messageId, result.queue, scope.type, scope.id);
      try {
        const walker = new ChainWalker();
        walker.strengthenPath(result.activated, scope.type, scope.id);
      } catch (e: any) {
        logDebug("Main", "strengthenPath 失败: " + e.message);
      }
    }

    logInfo("Main", `注入 msgId=${msgId}, 记忆 ${result.queue.length} 条`);

    const finalInput = (processedInput.replace(/\s+$/, '') + attachmentTag).trim();
    return { processedInput: finalInput };
  } catch (e: any) {
    logError("Main", "prompt before_process 失败: " + e.message);
    return null;
  }
}

// ============================================
// User 消息
// ============================================

export async function onMessageProcessing(event: any): Promise<any> {
  db.reopen();

  const payload = event.eventPayload || event;
  const rawInput = payload.rawInput || payload.messageContent || '';
  const chatId = payload.chatId || payload.chat_id;
  if (!rawInput || !chatId) return null;

  try {
    // 会话信息
    let title = '';
    let roleCardName = '';
    let roleCardId = '';
    const existingMeta = db.getSessionMeta(chatId);

    if (existingMeta) {
      title = existingMeta.title || '';
      roleCardName = existingMeta.roleCardName || '';
      roleCardId = existingMeta.roleCardId || '';
    }

    // roleCardId 为空 → 从 Operit 拉一次并写入
    if (!roleCardId) {
      const info = await sessionHelper.getSessionInfo(chatId);
      title = title || info.title;
      roleCardName = roleCardName || info.characterCardName;
      roleCardId = info.characterCardId || '';

      if (title || roleCardId || roleCardName) {
        db.getOrCreateSessionMeta(chatId, title, roleCardId, roleCardName);
        logInfo("Main", `会话同步: title=${title}, cardId=${roleCardId}, cardName=${roleCardName}`);
      }
    } else {
      // 已有 roleCardId：只更新 title（可能改了）
      if (existingMeta && existingMeta.title !== '未命名会话') {
        title = existingMeta.title;
      } else {
        const info = await sessionHelper.getSessionInfo(chatId);
        title = info.title || title;
        if (title) db.getOrCreateSessionMeta(chatId, title, roleCardId, roleCardName);
      }
    }

    const scope = db.getScope(chatId, roleCardId);

    const cleanInput = stripMemoryAttachment(rawInput);
    if (!cleanInput) return null;

    // 生成 msgId（新消息）或让 ShortTerm 决定复用
    const msgId = makeMsgId();

    const r = await shortTerm.processUserMessage(
      chatId, cleanInput, Date.now(),
      title, roleCardId, roleCardName,
      msgId
    );
    logInfo("Main", `onMessageProcessing 完成, 使用 msgId=${r.msgId}, folded=${r.folded}`);

    return null;
  } catch (error: any) {
    logError("Main", "message_processing 处理失败: " + error.message);
    return null;
  }
}

// ============================================
// AI 消息
// ============================================

export async function onMessagePersisted(event: any): Promise<any> {
  if (event.eventName !== 'message_persisted') return { handled: false };

  const payload = event.eventPayload || event;
  const sender = payload.sender;
  if (sender !== 'assistant' && sender !== 'Assistant' && sender !== 'ai' && sender !== 'AI') {
    return { handled: false };
  }

  const content = payload.content || '';
  const timestamp = payload.timestamp || Date.now();
  const sessionId = payload.chatId || payload.chat_id;
  if (!sessionId || !content) return { handled: false };

  try {
    const sessionInfo = await sessionHelper.getSessionInfo(sessionId);
    const meta = db.getSessionMeta(sessionId);
    const roleCardId = meta?.roleCardId || '';

    const cleanContent = stripMemoryAttachment(content);
    if (!cleanContent) return { handled: false };

    shortTerm.processAssistantToken(
      sessionId, cleanContent, timestamp,
      sessionInfo.title, roleCardId, sessionInfo.characterCardName, ''
    );
  } catch (e: any) {
    // 静默
  }

  return { handled: false };
}

// ============================================
// 注册
// ============================================

export function registerToolPkg(): boolean {
  logInfo("Main", "开始注册 OverMem v4（链式）");

  try {
    if (!db.initialize()) {
      logError("Main", "数据库初始化失败");
      return false;
    }
  } catch (e: any) {
    logError("Main", "数据库初始化异常: " + e.message);
    return false;
  }

  ToolPkg.registerPromptInputHook({
    id: "overmem_prompt_inject",
    function: onPromptBeforeProcess
  });
  ToolPkg.registerMessageProcessingPlugin({
    id: "overmem_pre_process",
    function: onMessageProcessing
  });
  ToolPkg.registerChatMessageHook({
    id: "overmem_message_cache",
    function: onMessagePersisted
  });
  ToolPkg.registerUiRoute({
    id: "overmem_dashboard",
    runtime: "compose_dsl",
    screen: DashboardScreen,
    title: { zh: "OverMem 记忆库", en: "OverMem Memory Vault" }
  });
  ToolPkg.registerNavigationEntry({
    id: "overmem_nav",
    route: "toolpkg:com.operit.overmem:ui:overmem_dashboard",
    surface: "main_sidebar_plugins",
    title: { zh: "OverMem 记忆库", en: "OverMem Memory" },
    icon: "memory",
    order: 10
  });

  return true;
}