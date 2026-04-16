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

test('parseLogLine suppresses assistant response item messages and reasoning', () => {
  const assistantMessage = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hide me' }]
    }
  });
  const reasoning = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'reasoning',
      encrypted_content: 'opaque'
    }
  });

  assert.equal(parseLogLine(assistantMessage), undefined);
  assert.equal(parseLogLine(reasoning), undefined);
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

  assert.equal(parseLogLine(line)?.summary, 'ASK  Add the open log button.');
  assert.equal(parseLogLine(line)?.detail, 'Prompt: # Context\n\n## My request for Codex:\nAdd the open log button.');
});

test('parseLogLine extracts token usage summaries from nested event messages', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 64125860,
          cached_input_tokens: 60100608,
          output_tokens: 193997,
          reasoning_output_tokens: 28751,
          total_tokens: 64319857
        },
        last_token_usage: {
          input_tokens: 172648,
          cached_input_tokens: 14720,
          output_tokens: 425,
          reasoning_output_tokens: 117,
          total_tokens: 173073
        },
        model_context_window: 258400
      },
      rate_limits: {
        primary: { used_percent: 31.0 },
        secondary: { used_percent: 83.0 }
      }
    }
  });

  const parsed = parseLogLine(line);
  assert.equal(parsed?.kind, 'token');
  assert.equal(parsed?.summary, 'TOKEN 31% 5h · 83% weekly · last 173.1k');
  assert.match(parsed?.detail ?? '', /Context window: 67%/);
  assert.deepEqual(
    parsed?.metadata?.filter((entry) => ['Total', 'Last', 'Context', '5h limit', 'Weekly limit'].includes(entry.label)),
    [
      { label: 'Total', value: '64.3M' },
      { label: 'Last', value: '173.1k' },
      { label: 'Context', value: '67%' },
      { label: '5h limit', value: '31%' },
      { label: 'Weekly limit', value: '83%' }
    ]
  );
});

test('parseLogLine extracts token rate limit summaries even without usage totals', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        primary: { used_percent: 9.0 },
        secondary: { used_percent: 1.0 }
      }
    }
  });

  assert.equal(parseLogLine(line)?.summary, 'TOKEN 9% 5h · 1% weekly');
});

test('parseLogLine extracts agent message first line and detail', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '**AFTER Summary**\n\nWhat changed:\n- [secret.ts](/Users/example/project/secret.ts)'
    }
  });

  const parsed = parseLogLine(line);
  assert.equal(parsed?.kind, 'message');
  assert.equal(parsed?.summary, 'MSG  **AFTER Summary**');
  assert.equal(parsed?.detail, '**AFTER Summary**\n\nWhat changed:\n- secret.ts');
});

test('parseLogLine extracts tool output first line and detail', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      output: 'Chunk ID: abc123\nOutput:\nTests passed'
    }
  });

  const parsed = parseLogLine(line);
  assert.equal(parsed?.summary, 'OUT  Chunk ID: abc123');
  assert.equal(parsed?.detail, 'Chunk ID: abc123\nOutput:\nTests passed');
});
