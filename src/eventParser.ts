export type ParsedEventKind = 'prompt' | 'message' | 'command' | 'edit' | 'patch' | 'status';

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
  const combinedType = [type, name].filter(Boolean).join(' ').toLowerCase();

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

  const preview = sanitizePromptPreview(promptText, 96);
  const detail = sanitizePromptPreview(promptText, 600);

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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuppressedMessageEvent(event: JsonRecord): boolean {
  const payload = getRecord(event, 'payload') ?? getRecord(event, 'item');
  const type = getString(event, 'type') ?? getString(payload, 'type');
  const role = getString(event, 'role') ?? getString(payload, 'role');

  return type?.toLowerCase().includes('message') === true && role !== 'user';
}
