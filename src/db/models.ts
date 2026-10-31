// db/models.ts
/// <reference path="../../types/index.d.ts" />

// ============================================
// 基础枚举
// ============================================

export type ScopeType = 'session' | 'group' | 'role_card' | 'global';

export type MemoryLevel = 'short' | 'mid' | 'long';

export type MemoryState = 'normal' | 'active' | 'trash';

export type NodeType = 'message' | 'block' | 'summary';

export type EdgeType = 'time' | 'fold' | 'recall';

// ============================================
// 节点
// ============================================

export interface MemoryNode {
  id: number;
  nodeType: NodeType;
  scopeType: ScopeType;
  scopeId: string;
  sessionId: string;
  role: string;
  level: string;
  content: string;
  timestamp: number;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  msgId: string;
  seq: number;
  isPending: boolean;
  arousal: number;
  recalledCount: number;
  lastRecalledAt: number;
  meta: NodeMeta | null;
}

// ============================================
// 边
// ============================================

export interface MemoryEdge {
  id: number;
  fromNode: number;
  toNode: number;
  edgeType: EdgeType;
  weight: number;
  lastActiveAt: number;
  createdAt: number;
}

// ============================================
// 链元数据
// ============================================

export interface ChainMeta {
  scopeType: ScopeType;
  scopeId: string;
  headId: number;
  tailId: number;
  headSeq: number;
  messageCount: number;
  updatedAt: number;
}

// ============================================
// 配置
// ============================================

export interface OverMemConfig {
  // 阈值
  shortThreshold: number;
  midThreshold: number;
  longThreshold: number;

  // 透传（迁移前使用；迁移后不再读取）
  sessionPassthrough: boolean;
  globalPassthrough: boolean;

  // 人格（迁移前使用；迁移后不再读取）
  personalityMode: 'auto' | 'manual';
  personalityCardId: string;
  personalityCustomText: string;
  personalityName: string;

  // 注入
  injectTopN: number;
  activeRatio: number;
  recallEnabled: boolean;
  recallBlankProbability: number;
  recallConfuseProbability: number;

  // 衰减
  timeEdgeDecayDays: number;
  foldEdgeBaseWeight: number;
  recallEdgeDecayDays: number;
  edgeDeathThreshold: number;

  // 激活
  activationSeedWeight: number;
  activationHopDecay: number;
  activationMinThreshold: number;

  // 调试
  debugMode: boolean;
  previewEnabled: boolean;

  // 系统
  initTimestamp: number;
  version: number;

  // 噪音
  noiseTemperature: number;
  synapticFailureEnabled: boolean;

  lastReplayAt: number;
  replayIntervalMs: number;
  replayMinBatch: number;
  replayBatchSize: number;
}

// ============================================
// 结构化元数据
// ============================================

export interface ThemeMeta {
  type: 'theme';
  title: string;
  keywords: string[];
  timeStart: number;
  timeEnd: number;
  emotionalArc: string;
  recurringPatterns: string[];
}

export interface NarrativeMeta {
  type: 'narrative';
  title: string;
  chapters: Array<{ period: string; theme: string; summary: string }>;
  characterArc: string;
  relationshipEvolution: string;
  longTermPatterns: string[];
}

export type NodeMeta = ThemeMeta | NarrativeMeta;

// ============================================
// 会话元数据
// ============================================

export interface SessionMeta {
  sessionId: string;
  title: string;
  roleCardId: string;
  roleCardName: string;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================
// 消息组策略
// ============================================

export interface MessageGroupInclusions {
  roleCards: string[];
  sessions: string[];
}

export interface MessageGroupExclusions {
  roleCards: string[];
  sessions: string[];
}

export interface MessageGroupPersonality {
  mode: 'auto' | 'manual';
  cardId: string;
  name: string;
  customText: string;
}

export interface MessageGroup {
  groupId: string;
  orderIndex: number;
  name: string;
  isGlobal: boolean;
  inclusions: MessageGroupInclusions;
  exclusions: MessageGroupExclusions;
  personality: MessageGroupPersonality;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ============================================
// 激活结果
// ============================================

export interface ActivatedNode {
  node: MemoryNode;
  activation: number;
  via: 'seed' | 'time' | 'fold' | 'recall';
  distance: number;
  parentId: number;
}

// ============================================
// 注入队列项
// ============================================

export interface QueueItem {
  level: MemoryLevel;
  nodeId: number;
  content: string;
  originalContent: string;
  activation: number;
  isActive: boolean;
  order: number;
  recallAction: 'none' | 'blank' | 'confuse';
}

// ============================================
// 统计
// ============================================

export interface BlockStats {
  totalMessages: number;
  totalBlocks: number;
  totalMidBlocks: number;
  totalLongBlocks: number;
  totalActiveNodes: number;
}