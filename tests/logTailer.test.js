const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LogTailer } = require('../dist/logTailer');

test('LogTailer starts at EOF and reads appended complete lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  await fs.writeFile(filePath, '{"type":"existing"}\n', 'utf8');

  const tailer = new LogTailer();
  await tailer.switchTo(filePath);

  await fs.appendFile(filePath, '{"type":"one"}\n{"type":"partial"', 'utf8');

  assert.deepEqual(await tailer.readAppendedLines(filePath), [{ text: '{"type":"one"}', lineNumber: 2 }]);

  await fs.appendFile(filePath, '}\n', 'utf8');

  assert.deepEqual(await tailer.readAppendedLines(filePath), [{ text: '{"type":"partial"}', lineNumber: 3 }]);
});

test('LogTailer resets offset when active file is truncated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  await fs.writeFile(filePath, '{"type":"existing"}\n', 'utf8');

  const tailer = new LogTailer();
  await tailer.switchTo(filePath);

  await fs.writeFile(filePath, '{"type":"new"}\n', 'utf8');

  assert.deepEqual(await tailer.readAppendedLines(filePath), [{ text: '{"type":"new"}', lineNumber: 1 }]);
});

test('LogTailer can read bounded recent history before tailing new lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  await fs.writeFile(filePath, '{"type":"one"}\n{"type":"two"}\n{"type":"three"}\n', 'utf8');

  const tailer = new LogTailer();

  assert.deepEqual(await tailer.readRecentCompleteLines(filePath, 2), [
    { text: '{"type":"two"}', lineNumber: 2 },
    { text: '{"type":"three"}', lineNumber: 3 }
  ]);

  await fs.appendFile(filePath, '{"type":"four"}\n', 'utf8');

  assert.deepEqual(await tailer.readAppendedLines(filePath), [{ text: '{"type":"four"}', lineNumber: 4 }]);
});

test('LogTailer can read recent history from logs larger than one read chunk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  const longPayload = 'x'.repeat(1024 * 1024 + 128);

  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ type: 'large', payload: longPayload }),
      JSON.stringify({ type: 'two' }),
      JSON.stringify({ type: 'three' }),
      ''
    ].join('\n'),
    'utf8'
  );

  const tailer = new LogTailer();

  assert.deepEqual(await tailer.readRecentCompleteLines(filePath, 2), [
    { text: '{"type":"two"}', lineNumber: 2 },
    { text: '{"type":"three"}', lineNumber: 3 }
  ]);
});

test('LogTailer ignores partial trailing lines when reading recent history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  await fs.writeFile(filePath, '{"type":"one"}\n{"type":"partial"', 'utf8');

  const tailer = new LogTailer();

  assert.deepEqual(await tailer.readRecentCompleteLines(filePath, 10), [{ text: '{"type":"one"}', lineNumber: 1 }]);

  await fs.appendFile(filePath, '}\n', 'utf8');

  assert.deepEqual(await tailer.readAppendedLines(filePath), [{ text: '{"type":"partial"}', lineNumber: 2 }]);
});
