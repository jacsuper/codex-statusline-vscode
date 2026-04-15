import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface CodexStatuslineConfig {
  enabled: boolean;
  sessionsRoot: string;
  showInStatusBar: boolean;
  showOutputChannel: boolean;
  pollIntervalMs: number;
  idleTimeoutMs: number;
  maxRecentEvents: number;
  initialHistoryLines: number;
  compactMode: boolean;
  debug: boolean;
}

export function getConfig(): CodexStatuslineConfig {
  const config = vscode.workspace.getConfiguration('codexStatusline');

  return {
    enabled: config.get<boolean>('enabled', true),
    sessionsRoot: expandHome(config.get<string>('sessionsRoot', defaultSessionsRoot())),
    showInStatusBar: config.get<boolean>('showInStatusBar', true),
    showOutputChannel: config.get<boolean>('showOutputChannel', false),
    pollIntervalMs: Math.max(1000, config.get<number>('pollIntervalMs', 3000)),
    idleTimeoutMs: Math.max(5000, config.get<number>('idleTimeoutMs', 30000)),
    maxRecentEvents: Math.max(1, config.get<number>('maxRecentEvents', 50)),
    initialHistoryLines: clamp(config.get<number>('initialHistoryLines', 25), 0, 200),
    compactMode: config.get<boolean>('compactMode', true),
    debug: config.get<boolean>('debug', false)
  };
}

export function defaultSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function clamp(value: number | undefined, min: number, max: number): number {
  const numberValue = value ?? min;
  return Math.min(max, Math.max(min, numberValue));
}
