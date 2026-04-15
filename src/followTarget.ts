import { RolloutLogFile } from './logLocator';

export type FollowMode = 'pinned' | 'latest';

export interface FollowTargetSnapshot {
  mode: FollowMode;
  pinnedLogPath?: string;
}

export class FollowTargetResolver {
  private mode: FollowMode;
  private pinnedLogPath: string | undefined;

  constructor(initialSnapshot: FollowTargetSnapshot = { mode: 'pinned' }) {
    this.mode = initialSnapshot.mode;
    this.pinnedLogPath = initialSnapshot.pinnedLogPath;
  }

  snapshot(): FollowTargetSnapshot {
    return {
      mode: this.mode,
      pinnedLogPath: this.pinnedLogPath
    };
  }

  pin(logPath: string): void {
    this.mode = 'pinned';
    this.pinnedLogPath = logPath;
  }

  followLatest(): void {
    this.mode = 'latest';
    this.pinnedLogPath = undefined;
  }

  resolve(latestLog: RolloutLogFile | undefined): RolloutLogFile | undefined {
    if (this.mode === 'pinned' && this.pinnedLogPath) {
      return {
        path: this.pinnedLogPath,
        mtimeMs: 0
      };
    }

    if (this.mode === 'pinned' && latestLog && !this.pinnedLogPath) {
      this.pinnedLogPath = latestLog.path;
    }

    return latestLog;
  }
}
