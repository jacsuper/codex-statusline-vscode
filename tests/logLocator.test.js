const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findLatestRolloutLog, findRolloutLogs } = require('../dist/logLocator');

test('findRolloutLogs returns rollout logs sorted newest first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-locator-'));
  const oldDir = path.join(root, '2026', '04', '10');
  const newDir = path.join(root, '2026', '04', '11');
  await fs.mkdir(oldDir, { recursive: true });
  await fs.mkdir(newDir, { recursive: true });

  const oldLog = path.join(oldDir, 'rollout-2026-04-10T23-59-00-old.jsonl');
  const newLog = path.join(newDir, 'rollout-2026-04-11T00-01-00-new.jsonl');
  const ignored = path.join(newDir, 'notes.jsonl');

  await fs.writeFile(oldLog, '{}\n', 'utf8');
  await fs.writeFile(newLog, '{}\n', 'utf8');
  await fs.writeFile(ignored, '{}\n', 'utf8');
  await fs.utimes(oldLog, new Date(2026, 3, 10, 23, 59), new Date(2026, 3, 10, 23, 59));
  await fs.utimes(newLog, new Date(2026, 3, 11, 0, 1), new Date(2026, 3, 11, 0, 1));

  const logs = await findRolloutLogs(root);

  assert.deepEqual(logs.map((log) => path.basename(log.path)), [
    'rollout-2026-04-11T00-01-00-new.jsonl',
    'rollout-2026-04-10T23-59-00-old.jsonl'
  ]);
  assert.equal((await findLatestRolloutLog(root))?.path, newLog);
});

test('findRolloutLogs tolerates a missing sessions root', async () => {
  const root = path.join(os.tmpdir(), `codex-statusline-missing-${Date.now()}`);

  assert.deepEqual(await findRolloutLogs(root), []);
});
