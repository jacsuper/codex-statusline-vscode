const assert = require('node:assert/strict');
const test = require('node:test');
const { FollowTargetResolver } = require('../dist/followTarget');

test('FollowTargetResolver pins first latest log by default', () => {
  const resolver = new FollowTargetResolver();
  const first = { path: '/sessions/rollout-first.jsonl', mtimeMs: 1 };
  const second = { path: '/sessions/rollout-second.jsonl', mtimeMs: 2 };

  assert.deepEqual(resolver.resolve(first), first);
  assert.equal(resolver.snapshot().mode, 'pinned');
  assert.equal(resolver.snapshot().pinnedLogPath, first.path);
  assert.deepEqual(resolver.resolve(second), { path: first.path, mtimeMs: 0 });
});

test('FollowTargetResolver can switch to follow-latest mode', () => {
  const resolver = new FollowTargetResolver();
  const first = { path: '/sessions/rollout-first.jsonl', mtimeMs: 1 };
  const second = { path: '/sessions/rollout-second.jsonl', mtimeMs: 2 };

  resolver.resolve(first);
  resolver.followLatest();

  assert.equal(resolver.snapshot().mode, 'latest');
  assert.equal(resolver.snapshot().pinnedLogPath, undefined);
  assert.deepEqual(resolver.resolve(second), second);
});

test('FollowTargetResolver can pin an explicit log', () => {
  const resolver = new FollowTargetResolver();
  const latest = { path: '/sessions/rollout-latest.jsonl', mtimeMs: 2 };

  resolver.pin('/sessions/rollout-manual.jsonl');

  assert.equal(resolver.snapshot().mode, 'pinned');
  assert.deepEqual(resolver.resolve(latest), { path: '/sessions/rollout-manual.jsonl', mtimeMs: 0 });
});

test('FollowTargetResolver restores an initial pinned log', () => {
  const resolver = new FollowTargetResolver({
    mode: 'pinned',
    pinnedLogPath: '/sessions/restored.jsonl'
  });

  assert.deepEqual(resolver.resolve({ path: '/sessions/latest.jsonl', mtimeMs: 2 }), {
    path: '/sessions/restored.jsonl',
    mtimeMs: 0
  });
});
