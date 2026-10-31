// main.ts
/// <reference path="../types/index.d.ts" />

// SPDX-FileCopyrightText: 2026 yyswys-yjyj
// SPDX-License-Identifier: GPL-3.0-or-later

import { DatabaseManager } from './db/DatabaseManager.js';
import { ShortTermMemory } from './memory/ShortTerm.js';
import { MemoryInjector } from './memory/MemoryInjector.js';
import { SessionHelper } from './utils/SessionHelper.js';
import { makeMsgId } from './utils/MsgId.js';
import { logInfo, logError, logDebug, logWarn } from './utils/Logger.js';
import { sanError } from './utils/Sanitizer.js';
import DashboardScreen from './ui/dashboard/index.ui.js';
import { ChainWalker } from './memory/ChainWalker.js';
const fs = require("fs");


const DB_PATH = "/storage/emulated/0/Download/Operit/overmem/mem.db";
const sessionHelper = SessionHelper.getInstance();

const db = DatabaseManager.getInstance(DB_PATH);

const shortTerm = new ShortTermMemory();
const injector = new MemoryInjector();
const SESSION_LOCK_FILE = OPERIT_CLEAN_ON_EXIT_DIR + '/.overmem.sessionlock';

const art = String.raw`
  ____                     __  ___            
 / __ \ _  __ ___   ____  /  |/  / ___   __ _ 
/ /_/ /| |/ // -_) / __/ / /|_/ / / -_) /  ' \
\____/ |___/ \__/ /_/   /_/  /_/  \__/ /_/_/_/
                                              
 Overmem v0.3.0 - Beta
 Powered by Serveryyswys Copyright (c) 2026 Serveryyswys.


`;

// ============================================
// XML 剥离
// ============================================

function stripOperitXml(content: string): string {
  if (!content) return '';
  let s = String(content);

  s = s.replace(
    /<tool_result_[\w]+\b([^>]*)>[\s\S]*?<\/tool_result_[\w]+>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具返回：${name}]\n`;
    }
  );
  s = s.replace(
    /<tool_(?!result_)[\w]+\b([^>]*)>[\s\S]*?<\/tool_(?!result_)[\w]+>/g,
    (_m, attrs) => {
      const name = extractAttr(attrs, 'name') || 'unknown';
      return `\n[工具调用：${name}]\n`;
    }
  );
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
  s = s.replace(/<[a-zA-Z][\w:-]*\b[^>]*>[\s\S]*?<\/[a-zA-Z][\w:-]*>/g, '');
  s = s.replace(/<[a-zA-Z][\w:-]*\b[^>]*\/>/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

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
// Prompt 注入
// ============================================

export async function onPromptBeforeProcess(event: any): Promise<any> {
  // hook 上下文可能是独立的 sandbox engine，db 实例需要自己初始化
  if (!db.isReady()) {
    try {
      db.initialize();
    } catch (e: any) {
      logError("Main", `prompt hook 内 initialize 失败: ${sanError(e)}`);
    }
  }
  db.reopen();
  if (!db.isReady()) {
    logInfo("Main", "prompt before_process：数据库未就绪，跳过");
    return null;
  }
  try {
    const payload = event.eventPayload || event;
    const chatId = payload.chatId || event.chatId || '';
    const processedInput = payload.processedInput || '';
    const rawInput = payload.rawInput || processedInput;

    if (!processedInput || processedInput.length === 0) return null;

    if (processedInput.indexOf('<attachment id="overmem_memory_') >= 0) {
      logInfo("Main", "prompt before_process：已注入，跳过");
      return null;
    }

    const meta = chatId ? db.getSessionMeta(chatId) : null;
    const roleCardId = meta?.roleCardId || '';
    const scope = db.getScope(chatId, roleCardId);

    const pendingUser = shortTerm.getPendingUser(scope.type, scope.id);
    const msgId = pendingUser?.msgId || '';

    const result = injector.buildQueue(scope.type, scope.id, rawInput);

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
  // hook 上下文可能是独立的 sandbox engine，db 实例需要自己初始化
  if (!db.isReady()) {
    try {
      db.initialize();
    } catch (e: any) {
      logError("Main", `message_processing hook 内 initialize 失败: ${sanError(e)}`);
    }
  }
  db.reopen();
  if (!db.isReady()) {
    logInfo("Main", "message_processing：数据库未就绪，跳过");
    return null;
  }

  const payload = event.eventPayload || event;
  const rawInput = payload.rawInput || payload.messageContent || '';
  const chatId = payload.chatId || payload.chat_id;
  if (!rawInput || !chatId) return null;

  try {
    let title = '';
    let roleCardName = '';
    let roleCardId = '';
    const existingMeta = db.getSessionMeta(chatId);

    if (existingMeta) {
      title = existingMeta.title || '';
      roleCardName = existingMeta.roleCardName || '';
      roleCardId = existingMeta.roleCardId || '';
    }

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
  // hook 上下文可能是独立的 sandbox engine，db 实例需要自己初始化
  if (!db.isReady()) {
    try {
      db.initialize();
    } catch (e: any) {
      logError("Main", `message_persisted hook 内 initialize 失败: ${sanError(e)}`);
    }
  }
  if (!db.isReady()) {
    logInfo("Main", "message_persisted：数据库未就绪，跳过");
    return { handled: false };
  }

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


// ================= 工具函数 =================

const SLOGANS = [
  // ---- 记忆 · 温情 ----
  '我会记得的',
  '你忘的，我替你记着',
  '记忆不会消失，只是换了个地方',
  '我们记住的，才是我们拥有的',
  '每一句话，都值得被收好',
  '回忆不占地方',
  '有些事，值得记很久',
  '时间会走，记忆会留下',
  '我记得你说过',
  '把今天存起来',

  // ---- 记忆 · 幽默 ----
  '我记得，但我选择不说',
  '删除键在这儿，请三思',
  '我的记性比你好',
  '别问我为什么记得，问就是缘分',
  '记忆库快满了，要不要整理一下',
  '这条我不会忘的，真的',
  '记住你是我的工作',
  '我不是健忘，我是在选择性遗忘',

  // ---- 猫 ----
  '喵',
  '喵喵',
  '喵喵喵',
  '别摸我，我在记东西',
  '猫的记忆力是七秒，我是七天',
  '困了，但还在记',
  '这条记下来，回头抓鱼用',
  '本喵在值班',

  // ---- 开发者自嘲 ----
  '一个 bug 都没改，但记忆全在',
  '代码是临时的，记忆是永久的',
  '重写第三遍了，这次真的没问题',
  '测试环境跑通了，线上不一定',
  '没崩，就是胜利',

  // ---- Meta / 日志梗 ----
  '当你看到了日志时，你看到了日志！',
  '这条日志没有意义，但很有存在感',
  '日志是写给未来的自己看的',
  '你居然真的翻到了这里',
  '这条是彩蛋，别告诉别人',
  '日志之下，皆是无常',

  // ---- 问候 ----
  '今天过得怎么样',
  '吃了吗',
  '忙完了吗，聊两句',
  '天气不错，适合回忆',
  '好久不见',
  '又见面了',
  '晚安',
  '早安，今天也要好好的',

  // ---- 空 ----
  '',
  '',
  '',
] as const;

function pickSlogan(): string {
  return SLOGANS[Math.floor(Math.random() * SLOGANS.length)];
}

function BannerGeneral(text: string): string {
  const lines = [
    '  /\\_/\\',
    ' ( o.o )',
    '  > ^ <',
  ];
  lines[lines.length - 1] += text ? `  ${text}` : '  z z Z';
  return lines.join('\n');
}

/**
 * 本次 Operit 会话是否是首次（用于 banner）。
 * 只读，不创建锁文件——锁文件由 DatabaseManager 在 schema 检查成功后写入。
 */
function isFirstLaunchInSession(): boolean {
  try {
    if (fs.existsSync(SESSION_LOCK_FILE)) {
      return false;
    }
    return true;
  } catch (e: any) {
    return true;
  }
}

// ============================================
// 注册
// ============================================

export function registerToolPkg(): boolean {
  if (isFirstLaunchInSession()) logInfo("Main", art + BannerGeneral(pickSlogan()) + "\n");

  try {
    if (!db.initialize()) {
      logError("Main", "数据库初始化失败");
      return false;
    }
  } catch (e: any) {
    logError("Main", `数据库初始化异常: ${sanError(e)}`);
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