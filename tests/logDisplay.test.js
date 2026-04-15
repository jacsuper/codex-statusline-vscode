const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatRolloutLogDisplay,
  formatRolloutLogQuickPickDescription,
  formatRolloutLogQuickPickDetail
} = require('../dist/logDisplay');

test('formatRolloutLogDisplay handles rollout names with session ids', () => {
  const now = new Date(2026, 3, 11, 22, 0, 0);
  const display = formatRolloutLogDisplay(
    '/Users/example/.codex/sessions/2026/04/11/rollout-2026-04-11T19-16-25-019d7dc2-6567-7f62-be13-fcbf7e22f29.jsonl',
    now
  );

  assert.equal(display.label, 'Today 19:16');
  assert.equal(display.detail, '19:16:25 · 019d7dc2');
});

test('formatRolloutLogQuickPickDescription is compact', () => {
  const now = new Date(2026, 3, 11, 22, 0, 0);
  const description = formatRolloutLogQuickPickDescription(
    '/Users/example/.codex/sessions/2026/04/07/rollout-2026-04-07T23-07-52-019d69fc-dc9d-72c1.jsonl',
    new Date(2026, 3, 11, 21, 30, 0).getTime(),
    now
  );

  assert.equal(description, 'updated 21:30');
});

test('formatRolloutLogQuickPickDetail avoids absolute paths', () => {
  const now = new Date(2026, 3, 11, 22, 0, 0);
  const detail = formatRolloutLogQuickPickDetail(
    '/Users/example/.codex/sessions/2026/04/11/rollout-2026-04-11T19-16-25-019d7dc2-6567-7f62-be13-fcbf7e22f29.jsonl',
    now
  );

  assert.equal(detail, 'sessions/2026/04/11 · 19:16:25 · 019d7dc2');
});

test('formatRolloutLogDisplay handles Windows-style paths on any host OS', () => {
  const now = new Date(2026, 3, 11, 22, 0, 0);
  const logPath =
    'C:\\Users\\example\\.codex\\sessions\\2026\\04\\11\\rollout-2026-04-11T19-16-25-019d7dc2-6567-7f62-be13-fcbf7e22f29.jsonl';

  assert.equal(formatRolloutLogDisplay(logPath, now).label, 'Today 19:16');
  assert.equal(formatRolloutLogQuickPickDetail(logPath, now), 'sessions/2026/04/11 · 19:16:25 · 019d7dc2');
});
