import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface RolloutLogFile {
  path: string;
  mtimeMs: number;
}

export async function findLatestRolloutLog(sessionsRoot: string): Promise<RolloutLogFile | undefined> {
  return (await findRolloutLogs(sessionsRoot))[0];
}

export async function findRolloutLogs(sessionsRoot: string): Promise<RolloutLogFile[]> {
  const candidates: RolloutLogFile[] = [];

  await collectRolloutLogs(sessionsRoot, candidates);

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function collectRolloutLogs(dir: string, candidates: RolloutLogFile[]): Promise<void> {
  let entries: import('node:fs').Dirent[];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await collectRolloutLogs(entryPath, candidates);
        return;
      }

      if (!entry.isFile() || !isRolloutLog(entry.name)) {
        return;
      }

      let stat: import('node:fs').Stats;

      try {
        stat = await fs.stat(entryPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          return;
        }

        throw error;
      }

      candidates.push({ path: entryPath, mtimeMs: stat.mtimeMs });
    })
  );
}

function isRolloutLog(fileName: string): boolean {
  return fileName.startsWith('rollout-') && fileName.endsWith('.jsonl');
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
