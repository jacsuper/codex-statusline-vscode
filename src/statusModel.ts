export type StatusKind = 'no_log' | 'watching' | 'working' | 'error' | 'stopped';

export interface CodexStatus {
  kind: StatusKind;
  text: string;
  followedLogPath?: string;
  followMode?: 'pinned' | 'latest';
  lastUpdate: Date;
  lastEventSummary?: string;
}

export function createStatus(
  kind: StatusKind,
  followedLogPath?: string,
  detail?: string,
  text?: string,
  followMode?: CodexStatus['followMode']
): CodexStatus {
  return {
    kind,
    text: text ?? toStatusText(kind),
    followedLogPath,
    followMode,
    lastUpdate: new Date(),
    lastEventSummary: detail
  };
}

function toStatusText(kind: StatusKind): string {
  switch (kind) {
    case 'watching':
      return 'Codex: watching';
    case 'working':
      return 'Codex: working';
    case 'error':
      return 'Codex: error';
    case 'stopped':
      return 'Codex: stopped';
    case 'no_log':
      return 'Codex: no log found';
  }
}
