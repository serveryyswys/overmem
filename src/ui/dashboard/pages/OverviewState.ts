// ui/dashboard/pages/OverviewState.ts
/// <reference path="../../../../types/index.d.ts" />

import { DashboardState } from '../DashboardState.js';
import { loadSnapshot } from '../MemorySnapshot.js';
import { DatabaseManager } from '../../../db/DatabaseManager.js';
import { NodeManager } from '../../../db/NodeManager.js';
import { MemoryNode, MemoryLevel, ScopeType } from '../../../db/models.js';
import { logInfo, logError } from '../../../utils/Logger.js';

export interface OverviewUiState {
  loading: boolean;
  dataLoaded: boolean;
  selectedLevel: MemoryLevel | null;
  shortBlocks: MemoryNode[];
  midBlocks: MemoryNode[];
  longBlocks: MemoryNode[];
  shortCount: number;
  midCount: number;
  longCount: number;
}

export class OverviewStateHolder {
  private dashboard: DashboardState;
  private dbPath: string;
  private state: OverviewUiState = {
    loading: false,
    dataLoaded: false,
    selectedLevel: null,
    shortBlocks: [], midBlocks: [], longBlocks: [],
    shortCount: 0, midCount: 0, longCount: 0,
  };

  constructor(dashboard: DashboardState, dbPath: string) {
    this.dashboard = dashboard;
    this.dbPath = dbPath;
  }

  get(): OverviewUiState { return this.state; }

  setSelectedLevel(level: MemoryLevel | null): void {
    this.state = { ...this.state, selectedLevel: level };
    this.dashboard.notify();
  }

  async refresh(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.dashboard.notify();

    try {
      const db = DatabaseManager.getInstance(this.dbPath);
      const nodes = new NodeManager(db);
      const snap = loadSnapshot(db, nodes);

      this.state = {
        ...this.state,
        loading: false,
        dataLoaded: true,
        shortBlocks: snap.shortBlocks,
        midBlocks: snap.midBlocks,
        longBlocks: snap.longBlocks,
        shortCount: snap.shortBlocks.length,
        midCount: snap.midBlocks.length,
        longCount: snap.longBlocks.length,
      };
    } catch (e: any) {
      logError("Overview", "刷新失败: " + e.message);
      this.dashboard.reportError(e.message);
      this.state = { ...this.state, loading: false };
    } finally {
      this.dashboard.notify();
    }
  }
}