// ui/theme/Palette.ts
/// <reference path="../../../types/index.d.ts" />

// 数据语义色：不随主题变化，用于区分数据类别
// UI 主题色（文本、背景、边框、图标）一律走 ctx.MaterialTheme.colorScheme

// ---- 记忆层级 ----
export const LEVEL_EVENT_COLOR = '#4CAF50';       // 事件（short）
export const LEVEL_THEME_COLOR = '#FF9800';       // 主题（mid）
export const LEVEL_NARRATIVE_COLOR = '#9C27B0';   // 叙事（long）

// ---- 节点状态 ----
export const STATE_ACTIVE_COLOR = '#F44336';      // 活跃
export const STATE_TRASH_COLOR = '#9E9E9E';       // 已废弃

// ---- 情绪强度 ----
export const AROUSAL_COLOR = '#F44336';

// ---- 版本类型 ----
export const VERSION_ALPHA_COLOR = '#FF6640';
export const VERSION_BETA_COLOR = '#D400FF';
export const VERSION_RC_COLOR = '#0E0470';
export const VERSION_RELEASE_COLOR = '#0B9FF0';
export const VERSION_DEFAULT_COLOR = '#666666';

// ---- 许可证类型 ----
export const LICENSE_APACHE_COLOR = '#2196F3';
export const LICENSE_GPL_COLOR = '#0B9FF0';
export const LICENSE_MIT_COLOR = '#4CAF50';