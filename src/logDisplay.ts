const rolloutPattern = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-([^.]+))?\.jsonl$/;

export interface RolloutLogDisplay {
  label: string;
  detail: string;
  shortId?: string;
  timestamp?: Date;
}

export function formatRolloutLogDisplay(logPathOrName: string, now = new Date()): RolloutLogDisplay {
  const fileName = getPortableBaseName(logPathOrName);
  const match = fileName.match(rolloutPattern);

  if (!match) {
    return {
      label: fileName.replace(/\.jsonl$/, '').replace(/^rollout-/, ''),
      detail: fileName
    };
  }

  const [, year, month, day, hour, minute, second, id] = match;
  const timestamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const shortId = id?.slice(0, 8);
  const time = formatClockTime(timestamp, false);
  const timeWithSeconds = formatClockTime(timestamp, true);
  const dateLabel = formatDateLabel(timestamp, now);

  return {
    label: `${dateLabel} ${time}`,
    detail: shortId ? `${timeWithSeconds} · ${shortId}` : timeWithSeconds,
    shortId,
    timestamp
  };
}

export function formatRolloutLogQuickPickDescription(logPath: string, mtimeMs: number, now = new Date()): string {
  const display = formatRolloutLogDisplay(logPath, now);
  const updated = formatClockTime(new Date(mtimeMs), false);

  return `updated ${updated}`;
}

export function formatRolloutLogQuickPickDetail(logPath: string, now = new Date()): string {
  const display = formatRolloutLogDisplay(logPath, now);
  const folder = formatSessionsFolder(logPath);
  const pieces = [folder, display.detail].filter(Boolean);

  return pieces.join(' · ');
}

function formatDateLabel(date: Date, now: Date): string {
  if (isSameDay(date, now)) {
    return 'Today';
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (isSameDay(date, yesterday)) {
    return 'Yesterday';
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatClockTime(date: Date, includeSeconds: boolean): string {
  const parts = [date.getHours(), date.getMinutes(), ...(includeSeconds ? [date.getSeconds()] : [])];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function formatSessionsFolder(logPath: string): string | undefined {
  const parts = splitPortablePath(logPath);
  const sessionsIndex = parts.lastIndexOf('sessions');

  if (sessionsIndex < 0) {
    return undefined;
  }

  const folderParts = parts.slice(sessionsIndex, -1);
  return folderParts.length > 0 ? folderParts.join('/') : undefined;
}

function getPortableBaseName(filePath: string): string {
  return splitPortablePath(filePath).at(-1) ?? filePath;
}

function splitPortablePath(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}
