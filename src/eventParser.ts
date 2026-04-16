export type ParsedEventKind = 'prompt' | 'message' | 'command' | 'edit' | 'patch' | 'status' | 'token';

export interface ParsedLogEvent {
  kind: ParsedEventKind;
  summary: string;
  statusText?: string;
  detail?: string;
  metadata?: EventMetadata[];
}

export interface EventMetadata {
  label: string;
  value: string;
}

type JsonRecord = Record<string, unknown>;

export function parseLogLine(line: string, options?: { showFullPayload?: boolean }): ParsedLogEvent | undefined {
  let value: unknown;

  try {
    value = JSON.parse(line.trim());
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const prompt = parseUserPromptEvent(value);

  if (prompt) {
    return prompt;
  }

  if (isSuppressedMessageEvent(value)) {
    return undefined;
  }

  return parseKnownEvent(value) ?? parseGenericEvent(value, options?.showFullPayload);
}

function parseKnownEvent(event: JsonRecord): ParsedLogEvent | undefined {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item') ?? getRecord(event, 'data');
  const type = getString(event, 'type') ?? getString(payload, 'type') ?? getString(event, 'event');
  const name = getString(event, 'name') ?? getString(payload, 'name') ?? getString(payload, 'method');
  const payloadType = getString(payload, 'type');
  const combinedType = [type, payloadType, name].filter(Boolean).join(' ').toLowerCase();

  if (type === 'session_meta') {
    return parseSessionMetaEvent(event);
  }

  if (type === 'turn_context') {
    return parseTurnContextEvent(event);
  }

  if (type === 'compacted' || payloadType === 'context_compacted') {
    return {
      kind: 'status',
      summary: 'CTX  compacted',
      statusText: 'Codex: compacted context',
      detail: 'Context compacted',
      metadata: eventMetadata(event)
    };
  }

  if (payload && payloadType === 'token_count') {
    return parseTokenCountEvent(event, payload);
  }

  if (payload && payloadType === 'agent_message') {
    return parseAgentMessageEvent(event, payload);
  }

  if (payload && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
    return parseToolOutputEvent(event, payload);
  }

  if (payload && payloadType === 'patch_apply_end') {
    return parsePatchApplyEndEvent(event, payload);
  }

  if (payloadType === 'task_started') {
    return {
      kind: 'status',
      summary: 'TASK started',
      statusText: 'Codex: working',
      detail: 'Task started',
      metadata: eventMetadata(event)
    };
  }

  if (payload && payloadType === 'task_complete') {
    return {
      kind: 'status',
      summary: 'TASK complete',
      statusText: 'Codex: watching',
      detail: summarizeTaskComplete(payload),
      metadata: eventMetadata(event)
    };
  }

  if (payload && payloadType === 'error') {
    return {
      kind: 'status',
      summary: `ERR  ${sanitizeMessagePreview(getString(payload, 'message') ?? 'error', 80)}`,
      statusText: 'Codex: error',
      detail: sanitizeMessageDetail(getString(payload, 'message') ?? JSON.stringify(payload), 900),
      metadata: eventMetadata(event)
    };
  }

  if (combinedType.includes('function_call') || combinedType.includes('tool_call') || combinedType.includes('tool')) {
    const toolName = name ?? getString(payload, 'tool') ?? getString(payload, 'tool_name');

    if (toolName) {
      const command = extractCommand(event);

      if (command) {
        return commandEvent(command, event, toolName);
      }

      return {
        kind: 'status',
        summary: `TOOL ${sanitizeToolName(toolName)}`,
        statusText: 'Codex: working',
        detail: `Tool call: ${sanitizeToolName(toolName)}`,
        metadata: eventMetadata(event, toolName)
      };
    }
  }

  if (combinedType.includes('exec') || combinedType.includes('shell') || combinedType.includes('command')) {
    const command = extractCommand(event);

    if (command) {
      return commandEvent(command, event, name);
    }
  }

  if (combinedType.includes('patch')) {
    const filePath = extractFilePath(event);
    return {
      kind: 'patch',
      summary: filePath ? `EDIT ${filePath}` : 'EDIT changes',
      statusText: 'Codex: applying changes',
      detail: filePath ? `Changed file: ${filePath}` : 'Applied changes',
      metadata: eventMetadata(event, name)
    };
  }

  if (combinedType.includes('edit') || combinedType.includes('file')) {
    const filePath = extractFilePath(event);

    if (filePath) {
      return {
        kind: 'edit',
        summary: `EDIT ${filePath}`,
        statusText: 'Codex: editing file',
        detail: `Changed file: ${filePath}`,
        metadata: eventMetadata(event, name)
      };
    }
  }

  return undefined;
}

function parseSessionMetaEvent(event: JsonRecord): ParsedLogEvent {
  const payload = getRecord(event, 'payload');
  const id = getString(payload, 'id') ?? getString(payload, 'session_id');
  const cwd = getString(payload, 'cwd');

  return {
    kind: 'status',
    summary: `SESSION ${id ? sanitizeSessionId(id) : 'started'}`,
    detail: [id ? `Session: ${sanitizeSessionId(id)}` : undefined, cwd ? `Workspace: ${sanitizePath(cwd)}` : undefined].filter(Boolean).join('\n') || 'Session started',
    metadata: eventMetadata(event)
  };
}

function parseTurnContextEvent(event: JsonRecord): ParsedLogEvent {
  const payload = getRecord(event, 'payload');
  const cwd = getString(payload, 'cwd');
  const model = getString(payload, 'model');
  const effort = getString(payload, 'effort');
  const approval = getString(payload, 'approval_policy');
  const sandbox = getRecord(payload, 'sandbox_policy');
  const sandboxType = getString(sandbox, 'type');
  const detail = [
    model ? `Model: ${sanitizeMetadataValue(model)}` : undefined,
    effort ? `Effort: ${sanitizeMetadataValue(effort)}` : undefined,
    cwd ? `Workspace: ${sanitizePath(cwd)}` : undefined,
    approval ? `Approval: ${sanitizeMetadataValue(approval)}` : undefined,
    sandboxType ? `Sandbox: ${sanitizeMetadataValue(sandboxType)}` : undefined
  ].filter(Boolean).join('\n');

  const label = [model, effort, sandboxType]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => sanitizeMetadataValue(item))
    .join(' · ');

  return {
    kind: 'status',
    summary: `CTX  ${label || 'turn context'}`,
    detail: detail || 'Turn context updated',
    metadata: eventMetadata(event)
  };
}

function parseToolOutputEvent(event: JsonRecord, payload: JsonRecord): ParsedLogEvent | undefined {
  const output = payload.output;
  const text = extractOutputText(output);

  if (!text) {
    return undefined;
  }

  const firstLine = firstUsefulLine(text);

  return {
    kind: 'status',
    summary: `OUT  ${sanitizeMessagePreview(firstLine, 96)}`,
    statusText: 'Codex: received tool output',
    detail: sanitizeMessageDetail(text, 1400),
    metadata: eventMetadata(event)
  };
}

function parsePatchApplyEndEvent(event: JsonRecord, payload: JsonRecord): ParsedLogEvent {
  const changes = getRecord(payload, 'changes');
  const changedFiles = changes ? Object.keys(changes).map(sanitizePath) : [];
  const success = payload.success === true;
  const label = changedFiles.length === 1 ? changedFiles[0] : `${changedFiles.length || 'some'} files`;

  return {
    kind: 'patch',
    summary: success ? `EDIT applied ${label}` : `EDIT failed ${label}`,
    statusText: success ? 'Codex: applied changes' : 'Codex: edit failed',
    detail: changedFiles.length > 0 ? `Changed files: ${changedFiles.join(', ')}` : sanitizeMessageDetail(getString(payload, 'stderr') ?? getString(payload, 'stdout') ?? 'Patch apply completed', 900),
    metadata: eventMetadata(event)
  };
}

function parseTokenCountEvent(event: JsonRecord, payload: JsonRecord): ParsedLogEvent | undefined {
  const info = getRecord(payload, 'info');
  const totalUsage = getRecord(info, 'total_token_usage');
  const lastUsage = getRecord(info, 'last_token_usage');

  const primaryPercent = getNumber(getRecord(getRecord(payload, 'rate_limits'), 'primary'), 'used_percent');
  const secondaryPercent = getNumber(getRecord(getRecord(payload, 'rate_limits'), 'secondary'), 'used_percent');

  if (!totalUsage && !lastUsage && primaryPercent === undefined && secondaryPercent === undefined) {
    return undefined;
  }

  const totalTokens = getNumber(totalUsage, 'total_tokens');
  const lastTokens = getNumber(lastUsage, 'total_tokens');
  const contextWindow = getNumber(info, 'model_context_window');
  const contextPercent = lastTokens !== undefined && contextWindow ? Math.round((lastTokens / contextWindow) * 100) : undefined;

  const summaryParts = [
    primaryPercent !== undefined ? `${formatPercent(primaryPercent)} 5h` : undefined,
    secondaryPercent !== undefined ? `${formatPercent(secondaryPercent)} weekly` : undefined,
    lastTokens !== undefined ? `last ${formatCompactNumber(lastTokens)}` : undefined
  ].filter((item): item is string => item !== undefined);

  return {
    kind: 'token',
    summary: `TOKEN ${summaryParts.join(' · ') || 'usage update'}`,
    statusText: 'Codex: watching token usage',
    detail: [
      totalTokens !== undefined ? `Total tokens: ${formatCompactNumber(totalTokens)}` : undefined,
      lastTokens !== undefined ? `Last turn: ${formatCompactNumber(lastTokens)}` : undefined,
      contextPercent !== undefined ? `Context window: ${formatPercent(contextPercent)}` : undefined,
      primaryPercent !== undefined ? `5h limit: ${formatPercent(primaryPercent)}` : undefined,
      secondaryPercent !== undefined ? `Weekly limit: ${formatPercent(secondaryPercent)}` : undefined
    ].filter(Boolean).join('\n'),
    metadata: [
      ...eventMetadata(event),
      ...tokenMetadata(totalUsage, lastUsage, contextWindow, primaryPercent, secondaryPercent, contextPercent)
    ]
  };
}

function tokenMetadata(
  totalUsage: JsonRecord | undefined,
  lastUsage: JsonRecord | undefined,
  contextWindow: number | undefined,
  primaryPercent: number | undefined,
  secondaryPercent: number | undefined,
  contextPercent: number | undefined
): EventMetadata[] {
  const totalTokens = getNumber(totalUsage, 'total_tokens');
  const inputTokens = getNumber(totalUsage, 'input_tokens');
  const cachedInputTokens = getNumber(totalUsage, 'cached_input_tokens');
  const outputTokens = getNumber(totalUsage, 'output_tokens');
  const lastTokens = getNumber(lastUsage, 'total_tokens');
  const lastInputTokens = getNumber(lastUsage, 'input_tokens');
  const lastOutputTokens = getNumber(lastUsage, 'output_tokens');
  const lastReasoningTokens = getNumber(lastUsage, 'reasoning_output_tokens');

  return [
    totalTokens !== undefined ? { label: 'Total', value: formatCompactNumber(totalTokens) } : undefined,
    inputTokens !== undefined ? { label: 'Input', value: formatCompactNumber(inputTokens) } : undefined,
    cachedInputTokens !== undefined ? { label: 'Cached', value: formatCompactNumber(cachedInputTokens) } : undefined,
    outputTokens !== undefined ? { label: 'Output', value: formatCompactNumber(outputTokens) } : undefined,
    lastTokens !== undefined ? { label: 'Last', value: formatCompactNumber(lastTokens) } : undefined,
    lastInputTokens !== undefined ? { label: 'Last input', value: formatCompactNumber(lastInputTokens) } : undefined,
    lastOutputTokens !== undefined ? { label: 'Last output', value: formatCompactNumber(lastOutputTokens) } : undefined,
    lastReasoningTokens !== undefined ? { label: 'Last reasoning', value: formatCompactNumber(lastReasoningTokens) } : undefined,
    contextWindow !== undefined ? { label: 'Context window', value: formatCompactNumber(contextWindow) } : undefined,
    contextPercent !== undefined ? { label: 'Context', value: formatPercent(contextPercent) } : undefined,
    primaryPercent !== undefined ? { label: '5h limit', value: formatPercent(primaryPercent) } : undefined,
    secondaryPercent !== undefined ? { label: 'Weekly limit', value: formatPercent(secondaryPercent) } : undefined
  ].filter((item): item is EventMetadata => item !== undefined);
}

function parseAgentMessageEvent(event: JsonRecord, payload: JsonRecord): ParsedLogEvent | undefined {
  const message = getString(payload, 'message');

  if (!message) {
    return undefined;
  }

  const firstLine = firstUsefulLine(message);

  return {
    kind: 'message',
    summary: `MSG  ${sanitizeMessagePreview(firstLine, 96)}`,
    statusText: 'Codex: message',
    detail: sanitizeMessageDetail(message, 1800),
    metadata: eventMetadata(event)
  };
}

function parseGenericEvent(event: JsonRecord, showFullPayload = false): ParsedLogEvent | undefined {
  const command = extractCommand(event);

  if (command) {
    return commandEvent(command, event);
  }

  const filePath = extractFilePath(event);

  if (filePath) {
    return {
      kind: 'edit',
      summary: `FILE ${filePath}`,
      statusText: 'Codex: editing file',
      detail: `Changed file: ${filePath}`,
      metadata: eventMetadata(event)
    };
  }

  const type = getString(event, 'type') ?? getString(event, 'name') ?? getString(event, 'event') ?? 'activity';
  return {
    kind: 'status',
    summary: `LOG  ${type.toUpperCase()}`,
    detail: showFullPayload ? JSON.stringify(event, null, 2) : `Event Keys: ${Object.keys(event).join(', ')}`
  };
}

function parseUserPromptEvent(event: JsonRecord): ParsedLogEvent | undefined {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item');
  const type = [getString(event, 'type'), getString(payload, 'type')].filter(Boolean).join(' ');
  const role = getString(event, 'role') ?? getString(payload, 'role');
  const normalizedType = type.toLowerCase();

  if (role !== 'user' && !normalizedType.includes('user_message')) {
    return undefined;
  }

  const promptText = extractPromptText(event);

  if (!promptText) {
    return undefined;
  }

  const preview = sanitizePromptPreview(extractUserRequestText(promptText) ?? promptText, 96);
  const detail = sanitizePromptDetail(promptText, 900);

  return {
    kind: 'prompt',
    summary: `ASK  ${preview}`,
    statusText: 'Codex: received prompt',
    detail: `Prompt: ${detail}`,
    metadata: eventMetadata(event, 'user')
  };
}

function commandEvent(command: SanitizedCommand, event: JsonRecord, toolName?: string): ParsedLogEvent {
  return {
    kind: 'command',
    summary: `RUN  ${command.short}`,
    statusText: 'Codex: running command',
    detail: `Command: ${command.detail}`,
    metadata: eventMetadata(event, toolName)
  };
}

interface SanitizedCommand {
  short: string;
  detail: string;
}

function extractCommand(value: unknown): SanitizedCommand | undefined {
  const command = findStringByKey(value, ['cmd', 'command']);

  if (command) {
    return compactCommand(command);
  }

  const argumentsValue = findStringByKey(value, ['arguments']);

  if (!argumentsValue) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(argumentsValue) as unknown;
    return compactCommand(findStringByKey(parsed, ['cmd', 'command']));
  } catch {
    return undefined;
  }
}

function extractFilePath(value: unknown): string | undefined {
  const filePath = findStringByKey(value, ['path', 'file', 'filePath', 'filepath', 'target_file']);

  if (!filePath) {
    return undefined;
  }

  return sanitizePath(filePath);
}

function extractPromptText(event: JsonRecord): string | undefined {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item');
  const message = getString(payload, 'message') ?? getString(event, 'message');

  if (message) {
    return message;
  }

  const content = payload?.content ?? event.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const pieces = content
      .map((item) => {
        if (!isRecord(item)) {
          return undefined;
        }

        const type = getString(item, 'type');

        if (type && type !== 'input_text' && type !== 'text') {
          return undefined;
        }

        return getString(item, 'text');
      })
      .filter((item): item is string => item !== undefined);

    return pieces.join('\n').trim() || undefined;
  }

  return undefined;
}

function extractOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    const pieces = value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (!isRecord(item)) {
          return undefined;
        }

        const type = getString(item, 'type');

        if (type === 'input_image') {
          return 'Image output';
        }

        return getString(item, 'text') ?? getString(item, 'output') ?? getString(item, 'message');
      })
      .filter((item): item is string => item !== undefined);

    return pieces.join('\n').trim() || undefined;
  }

  if (isRecord(value)) {
    return getString(value, 'text') ?? getString(value, 'output') ?? getString(value, 'message') ?? JSON.stringify(redactLargeFields(value));
  }

  return undefined;
}

function redactLargeFields(value: JsonRecord): JsonRecord {
  const redacted: JsonRecord = {};

  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' && field.length > 240) {
      redacted[key] = `${field.slice(0, 120)}...`;
    } else {
      redacted[key] = field;
    }
  }

  return redacted;
}

function findStringByKey(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findStringByKey(item, keys, depth + 1);

      if (match) {
        return match;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const field = value[key];

    if (typeof field === 'string' && field.trim().length > 0) {
      return field.trim();
    }
  }

  for (const field of Object.values(value)) {
    const match = findStringByKey(field, keys, depth + 1);

    if (match) {
      return match;
    }
  }

  return undefined;
}

function compactCommand(command: string | undefined): SanitizedCommand | undefined {
  if (!command) {
    return undefined;
  }

  const firstLine = command.split(/\r?\n/)[0]?.trim();

  if (!firstLine) {
    return undefined;
  }

  const tokens = firstLine.split(/\s+/);
  const executable = tokens[0];

  if (!executable) {
    return undefined;
  }

  const safeExecutable = sanitizeExecutable(executable);

  if (shouldHideSubcommand(safeExecutable)) {
    return {
      short: safeExecutable,
      detail: `${safeExecutable} (script hidden)`
    };
  }

  const safeTokens = tokens.slice(1, 5).map(sanitizeToken).filter(Boolean);
  const short = [safeExecutable, ...safeTokens.slice(0, 3)].join(' ');
  const detailTokens = tokens.slice(1, 12).map(sanitizeToken).filter(Boolean);
  const truncated = tokens.length > 13 ? ' ...' : '';

  return {
    short,
    detail: `${[safeExecutable, ...detailTokens].join(' ')}${truncated}`.slice(0, 160)
  };
}

function sanitizeExecutable(executable: string): string {
  const withoutPath = executable.split(/[\\/]/).pop() ?? executable;
  return sanitizeToken(withoutPath);
}

function sanitizeToolName(toolName: string): string {
  return sanitizeToken(toolName);
}

function sanitizeSessionId(value: string): string {
  return sanitizeToken(value).slice(0, 8);
}

function sanitizePath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? 'file';
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 32) || 'unknown';
}

function sanitizePromptPreview(value: string, maxLength: number): string {
  const compact = value
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!compact) {
    return 'empty prompt';
  }

  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}...` : compact;
}

function extractUserRequestText(value: string): string | undefined {
  const marker = '## My request for Codex:';
  const markerIndex = value.indexOf(marker);

  if (markerIndex === -1) {
    return undefined;
  }

  const request = value.slice(markerIndex + marker.length).trim();
  return request.length > 0 ? request : undefined;
}

function sanitizePromptDetail(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return 'empty prompt';
  }

  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}...` : normalized;
}

function sanitizeMessagePreview(value: string, maxLength: number): string {
  return sanitizePromptPreview(value.replace(/\[[^\]]+\]\([^)]*\)/g, '$1'), maxLength);
}

function sanitizeMessageDetail(value: string, maxLength: number): string {
  const withoutAbsoluteMarkdownLinks = value.replace(/\[([^\]]+)\]\((?:file:\/\/)?\/[^)]*\)/g, '$1');
  return sanitizePromptDetail(withoutAbsoluteMarkdownLinks, maxLength);
}

function firstUsefulLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean);

  return lines[0] ?? 'message';
}

function summarizeTaskComplete(payload: JsonRecord): string {
  const lastAgentMessage = getString(payload, 'last_agent_message');

  if (lastAgentMessage) {
    return sanitizeMessageDetail(lastAgentMessage, 900);
  }

  return 'Task complete';
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }

  if (absolute >= 1_000) {
    return `${trimNumber(value / 1_000)}k`;
  }

  return String(value);
}

function trimNumber(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function eventMetadata(event: JsonRecord, toolName?: string): EventMetadata[] {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item');
  const metadata = [
    { label: 'Event', value: getString(event, 'type') ?? getString(payload, 'type') },
    { label: 'Tool', value: toolName ?? getString(event, 'name') ?? getString(payload, 'name') }
  ].filter((item): item is EventMetadata => typeof item.value === 'string' && item.value.trim().length > 0);

  return metadata.map((item) => ({
    label: item.label,
    value: sanitizeMetadataValue(item.value)
  }));
}

function sanitizeMetadataValue(value: string): string {
  return value.replace(/[^\w ._:/-]/g, '').trim().slice(0, 80) || 'unknown';
}

function shouldHideSubcommand(executable: string): boolean {
  return executable === 'bash' || executable === 'zsh' || executable === 'sh' || executable === 'python' || executable === 'python3';
}

function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuppressedMessageEvent(event: JsonRecord): boolean {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item');
  const type = getString(event, 'type') ?? getString(payload, 'type');
  const payloadType = getString(payload, 'type');
  const role = getString(event, 'role') ?? getString(payload, 'role');

  if (payloadType === 'reasoning') {
    return true;
  }

  return (type?.toLowerCase().includes('message') === true || payloadType === 'message') && role !== 'user';
}
