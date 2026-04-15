const assert = require('node:assert/strict');
const test = require('node:test');
const { parseLogLine } = require('../dist/eventParser');

test('parseLogLine skips malformed JSONL safely without output noise', () => {
  assert.equal(parseLogLine('{not json'), undefined);
});

test('parseLogLine extracts command from nested function arguments', () => {
  const line = JSON.stringify({
    type: 'response_item',
    item: {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ cmd: 'npm run check' })
    }
  });

  assert.deepEqual(parseLogLine(line), {
    kind: 'command',
    summary: 'RUN  npm run check',
    statusText: 'Codex: running command',
    detail: 'Command: npm run check',
    metadata: [
      { label: 'Event', value: 'response_item' },
      { label: 'Tool', value: 'shell' }
    ]
  });
});

test('parseLogLine extracts patch file summaries conservatively', () => {
  const line = JSON.stringify({
    type: 'apply_patch',
    payload: {
      target_file: 'src/watcher.ts'
    }
  });

  assert.deepEqual(parseLogLine(line), {
    kind: 'patch',
    summary: 'EDIT watcher.ts',
    statusText: 'Codex: applying changes',
    detail: 'Changed file: watcher.ts',
    metadata: [{ label: 'Event', value: 'apply_patch' }]
  });
});

test('parseLogLine keeps repeated npm scripts distinguishable', () => {
  const check = JSON.stringify({
    type: 'exec_command',
    command: 'npm run check'
  });
  const testAll = JSON.stringify({
    type: 'exec_command',
    command: 'npm run test:all'
  });

  assert.equal(parseLogLine(check)?.summary, 'RUN  npm run check');
  assert.equal(parseLogLine(testAll)?.summary, 'RUN  npm run test:all');
});

test('parseLogLine suppresses assistant message events', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'do not show this'
  });

  assert.equal(parseLogLine(line), undefined);
});

test('parseLogLine does not extract command-like fields from assistant message events', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'assistant',
    command: 'rm -rf should-not-show'
  });

  assert.equal(parseLogLine(line), undefined);
});

test('parseLogLine extracts user prompt previews from response items', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please run the tests and tell me what broke.' }]
    }
  });

  assert.deepEqual(parseLogLine(line), {
    kind: 'prompt',
    summary: 'ASK  Please run the tests and tell me what broke.',
    statusText: 'Codex: received prompt',
    detail: 'Prompt: Please run the tests and tell me what broke.',
    metadata: [
      { label: 'Event', value: 'response_item' },
      { label: 'Tool', value: 'user' }
    ]
  });
});

test('parseLogLine extracts user prompt previews from event messages', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '# Context\n\n## My request for Codex:\nAdd the open log button.'
    }
  });

  assert.equal(parseLogLine(line)?.summary, 'ASK  # Context ## My request for Codex: Add the open log button.');
});
