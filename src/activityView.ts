import * as crypto from 'crypto';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { formatClockTime, formatRolloutLogDisplay } from './logDisplay';
import { CodexStatus } from './statusModel';
import { ActivityEvent } from './watcher';

const maxDirectOpenBytes = 45 * 1000 * 1000;
const excerptContextLines = 80;

interface WebviewEvent {
  id: number;
  summary: string;
  timestamp: string;
  kind: string;
  label: string;
  detail: string;
  metadata: { label: string; value: string }[];
  logName: string;
  lineNumber?: number;
  relatedPromptId?: number;
  relatedPromptSummary?: string;
  relatedPromptDetail?: string;
  relatedPromptLogPath?: string;
  relatedPromptLineNumber?: number;
  promptSequence?: number;
  promptStep?: number;
  hasLogPath: boolean;
  tagClass: string;
}

interface WebviewState {
  statusText: string;
  statusKind: CodexStatus['kind'] | 'stopped';
  followMode: string;
  logName: string;
  logDetail?: string;
  lastUpdate: string;
  events: WebviewEvent[];
}

export class CodexActivityView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private status: CodexStatus | undefined;
  private events: ActivityEvent[] = [];
  private ready = false;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = true;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!isMessage(message)) {
        return;
      }

      const command = commandForAction(message.action);

      if (command) {
        void vscode.commands.executeCommand(command).then(undefined, () => {
          // VS Code can reject command execution while the extension host is closing.
        });
        return;
      }

      if (message.action === 'openLog' && typeof message.eventId === 'number') {
        void this.openEventLog(message.eventId);
      }
    });
    this.render();
  }

  update(status: CodexStatus, events: ActivityEvent[]): void {
    this.status = status;
    this.events = [...events].reverse();

    if (this.view && this.ready) {
      void this.view.webview.postMessage({ type: 'update', state: toWebviewState(this.status, this.events) });
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = renderHtml(toWebviewState(this.status, this.events), this.view.webview.cspSource, createNonce());
  }

  private async openEventLog(eventId: number): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === eventId);

    if (!event?.logPath) {
      return;
    }

    try {
      const stat = await fs.promises.stat(event.logPath);

      if (stat.size >= maxDirectOpenBytes) {
        await this.openEventLogExcerpt(event, stat.size);
        return;
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(event.logPath));
      const editor = await vscode.window.showTextDocument(document, { preview: true });

      if (event.lineNumber !== undefined) {
        const lastLine = Math.max(0, document.lineCount - 1);
        const line = Math.min(lastLine, Math.max(0, event.lineNumber - 1));
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      } else {
        // If no line number, just reveal the end of the file where the activity is happening
        const lastLine = document.lineCount - 1;
        editor.revealRange(new vscode.Range(lastLine, 0, lastLine, 0), vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Could not open the selected Codex rollout log: ${message}`);
    }
  }

  private async openEventLogExcerpt(event: ActivityEvent, fileSize: number): Promise<void> {
    if (!event.logPath) {
      return;
    }

    const excerpt = await readLogExcerpt(event.logPath, event.lineNumber);
    const targetDescription = event.lineNumber ? `line ${event.lineNumber}` : 'end of file';
    const content = [
      `Codex rollout log excerpt`,
      `Source: ${event.logPath}`,
      `Size: ${formatBytes(fileSize)}`,
      `Target: ${targetDescription}`,
      ``,
      `VS Code does not open rollout logs over 50 MB through extensions, so this is a local excerpt.`,
      `Use a terminal or external editor to inspect the full file if needed.`,
      ``,
      excerpt
    ].join('\n');

    const document = await vscode.workspace.openTextDocument({
      content,
      language: 'jsonl'
    });
    const editor = await vscode.window.showTextDocument(document, { preview: true });

    const markerLine = Math.max(0, content.split('\n').findIndex((line) => line.startsWith('> ')));
    const position = new vscode.Position(markerLine, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(markerLine, 0, markerLine, 0), vscode.TextEditorRevealType.InCenter);
  }
}

async function readLogExcerpt(logPath: string, lineNumber: number | undefined): Promise<string> {
  if (lineNumber === undefined) {
    return readTailExcerpt(logPath);
  }

  const startLine = Math.max(1, lineNumber - excerptContextLines);
  const endLine = lineNumber + excerptContextLines;
  const lines: string[] = [];
  const reader = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let currentLine = 0;

  for await (const line of reader) {
    currentLine += 1;

    if (currentLine < startLine) {
      continue;
    }

    if (currentLine > endLine) {
      break;
    }

    lines.push(formatExcerptLine(currentLine, line, currentLine === lineNumber));
  }

  if (lines.length === 0) {
    return readTailExcerpt(logPath);
  }

  return lines.join('\n');
}

async function readTailExcerpt(logPath: string): Promise<string> {
  const stat = await fs.promises.stat(logPath);
  const bytesToRead = Math.min(stat.size, 256 * 1024);
  const handle = await fs.promises.open(logPath, 'r');

  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-160);
    const firstLine = Math.max(1, countNewlinesInFileTail(text, stat.size > bytesToRead) + 1);
    return lines.map((line, index) => formatExcerptLine(firstLine + index, line, index === lines.length - 1)).join('\n');
  } finally {
    await handle.close();
  }
}

function formatExcerptLine(lineNumber: number, line: string, selected: boolean): string {
  return `${selected ? '>' : ' '} ${String(lineNumber).padStart(7, ' ')}  ${line}`;
}

function countNewlinesInFileTail(text: string, truncated: boolean): number {
  if (!truncated) {
    return 0;
  }

  return Math.max(0, text.split(/\r?\n/).length - 161);
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}

function toWebviewState(status: CodexStatus | undefined, events: ActivityEvent[]): WebviewState {
  const statusText = status?.text.replace(/^Codex:\s*/, '') ?? 'not started';
  const statusKind = status?.kind ?? 'stopped';
  const followMode = status?.followMode ?? 'pinned';
  const logDisplay = status?.followedLogPath ? formatRolloutLogDisplay(status.followedLogPath) : undefined;
  const logName = logDisplay?.label ?? (status?.kind === 'no_log' ? 'no log found' : 'selecting log...');

  return {
    statusText,
    statusKind,
    followMode,
    logName,
    logDetail: logDisplay?.detail,
    lastUpdate: status?.lastUpdate ? formatTime(status.lastUpdate) : '--:--:--',
    events: events.map((event) => ({
      id: event.id,
      summary: event.summary,
      timestamp: formatTime(event.timestamp),
      kind: eventTag(event.summary).label,
      label: eventLabel(event.summary),
      detail: event.detail ?? event.summary,
      metadata: event.metadata ?? [],
      logName: event.logName ?? logName,
      lineNumber: event.lineNumber,
      relatedPromptId: event.relatedPromptId,
      relatedPromptSummary: event.relatedPromptSummary,
      relatedPromptDetail: event.relatedPromptDetail,
      relatedPromptLogPath: event.relatedPromptLogPath,
      relatedPromptLineNumber: event.relatedPromptLineNumber,
      promptSequence: event.promptSequence,
      promptStep: event.promptStep,
      hasLogPath: event.logPath !== undefined,
      tagClass: eventTag(event.summary).className
    }))
  };
}

function renderHtml(state: WebviewState, cspSource: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background);
    }
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 10;
      padding: 12px 12px 10px;
      margin: -12px -12px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-widget-border);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
    }
    body.paused .sticky-header {
      background: color-mix(in srgb, var(--vscode-charts-yellow) 18%, var(--vscode-sideBar-background));
      border-bottom-color: var(--vscode-charts-yellow);
    }
    .pause-banner {
      display: none;
      margin: 0 0 8px;
      border: 1px solid var(--vscode-charts-yellow);
      border-radius: 8px;
      padding: 7px 8px;
      color: var(--vscode-editor-background);
      background: var(--vscode-charts-yellow);
      font-weight: 700;
    }
    body.paused .pause-banner {
      display: block;
    }
    .status {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editorWidget-background);
      margin-bottom: 12px;
    }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin-bottom: 6px;
    }
    .current {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 8px;
      flex: 0 0 auto;
    }
    .meta {
      display: grid;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      min-width: 0;
    }
    .mode {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      gap: 6px;
      border-radius: 6px;
      padding: 3px 6px;
      font-size: 11px;
      font-weight: 700;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 12px;
    }
    .action,
    .detail-action {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 8px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .action {
      padding: 6px 8px;
    }
    .detail-action {
      padding: 5px 8px;
      font-size: 12px;
    }
    .action:hover,
    .action:focus,
    .detail-action:hover,
    .detail-action:focus {
      outline: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .detail-action[disabled] {
      cursor: default;
      opacity: 0.55;
    }
    .mono {
      font-family: var(--vscode-editor-font-family);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .events {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
    }
    .event-shell {
      display: grid;
      gap: 6px;
    }
    button.event {
      color: inherit;
      font: inherit;
      text-align: left;
      border: 1px solid transparent;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      padding: 7px 8px;
      border-radius: 8px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      width: 100%;
    }
    button.event:hover,
    button.event:focus {
      border-color: var(--vscode-focusBorder);
      outline: none;
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    button.event.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .tag {
      font-size: 10px;
      line-height: 1;
      font-weight: 700;
      padding: 4px 5px;
      border-radius: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .tag-run { background: var(--vscode-charts-purple); }
    .tag-ask {
      background: var(--vscode-charts-yellow);
      color: var(--vscode-editor-background);
    }
    .tag-edit { background: var(--vscode-charts-orange); }
    .tag-tool { background: var(--vscode-charts-blue); }
    .tag-log { background: var(--vscode-charts-green); }
    .event-text {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .event strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .event-hint {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .time {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
      padding-top: 2px;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px 0;
    }
    .inline-detail {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editorWidget-background);
    }
    .detail-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px 10px;
      font-size: 12px;
    }
    .detail-key { color: var(--vscode-descriptionForeground); }
    .detail-value {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .local-actions {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin: -4px 0 12px;
    }
    .mini-action {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 8px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 6px;
      cursor: pointer;
    }
    .mini-action.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .mini-action.primary:hover,
    .mini-action.primary:focus {
      background: var(--vscode-button-hoverBackground);
    }
    .mini-action:hover,
    .mini-action:focus {
      outline: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .event-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }
    .chip {
      border-radius: 6px;
      padding: 2px 5px;
      font-size: 10px;
      font-weight: 700;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    .chip-muted {
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
    }
    .group-separator {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
      margin: 6px 0 0;
    }
    .group-separator::after {
      content: "";
      height: 1px;
      flex: 1;
      background: var(--vscode-widget-border);
    }
    .detail-heading {
      margin: 8px 0 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .detail-card {
      border-left: 3px solid var(--vscode-button-background);
      border-radius: 6px;
      padding: 7px 8px;
      background: var(--vscode-input-background);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      font-size: 12px;
    }
    .detail-card code {
      font-family: var(--vscode-editor-font-family);
      font-weight: 700;
    }
    .prompt-parts {
      display: grid;
      gap: 8px;
    }
    .prompt-part {
      border-left: 3px solid var(--vscode-button-background);
      border-radius: 6px;
      padding: 7px 8px;
      background: var(--vscode-input-background);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      font-size: 12px;
    }
    .prompt-context {
      border-left-color: var(--vscode-charts-blue);
    }
    .prompt-request {
      border-left-color: var(--vscode-charts-yellow);
    }
    .prompt-part-title {
      display: block;
      margin-bottom: 5px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
  </style>
</head>
<body>
  <header class="sticky-header">
    <div id="pause-banner" class="pause-banner">Paused</div>
    <section class="status">
      <div class="eyebrow">Codex Status</div>
      <div class="current"><span id="status-dot" class="dot"></span><strong id="status-text"></strong></div>
      <div class="meta">
        <span id="log-name" class="mono"></span>
        <span id="log-detail"></span>
        <span id="follow-mode" class="mode"></span>
        <span id="last-update"></span>
      </div>
    </section>
    <section class="actions" aria-label="Follow controls">
      <button type="button" class="action" data-action="watchAnother">⇄ Watch other</button>
      <button type="button" id="mode-action" class="action"></button>
    </section>
    <section class="local-actions" aria-label="View controls">
      <button type="button" id="pause-action" class="mini-action primary" data-local-action="pause">⏸ Pause</button>
      <button type="button" class="mini-action" data-local-action="top">↑ Top</button>
      <button type="button" class="mini-action" data-local-action="bottom">↓ Bottom</button>
      <button type="button" class="mini-action" data-local-action="clear">× Clear</button>
    </section>
  </header>
  <section id="events" class="events" aria-label="Recent Codex activity"></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${JSON.stringify(state).replace(/</g, '\\u003c')};
    let lastStateJson = '';
    let selectedEventId = undefined;
    let promptFallback = undefined;
    let paused = false;
    let pendingState = undefined;
    let pendingUpdateCount = 0;

    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');
    const logName = document.getElementById('log-name');
    const logDetail = document.getElementById('log-detail');
    const followMode = document.getElementById('follow-mode');
    const lastUpdate = document.getElementById('last-update');
    const modeAction = document.getElementById('mode-action');
    const pauseAction = document.getElementById('pause-action');
    const pauseBanner = document.getElementById('pause-banner');
    const eventsRoot = document.getElementById('events');

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ action: button.dataset.action });
      });
    });

    document.querySelectorAll('[data-local-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.localAction === 'pause') {
          paused = !paused;

          if (!paused && pendingState) {
            state = pendingState;
            pendingState = undefined;
            pendingUpdateCount = 0;
            reconcileSelection();
          }

          render();
          return;
        }

        if (button.dataset.localAction === 'clear') {
          selectedEventId = undefined;
          promptFallback = undefined;
          pendingState = undefined;
          pendingUpdateCount = 0;
          state = { ...state, events: [] };
          render();
          vscode.postMessage({ action: 'clearActivity' });
          return;
        }

        if (button.dataset.localAction === 'top') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }

        if (button.dataset.localAction === 'bottom') {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        }
      });
    });

    modeAction.addEventListener('click', () => {
      vscode.postMessage({ action: modeAction.dataset.action });
    });

    eventsRoot.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const detailAction = target.closest('[data-detail-action]');

      if (detailAction) {
        const eventId = Number(detailAction.dataset.eventId);

        if (detailAction.dataset.detailAction === 'openLog') {
          vscode.postMessage({ action: 'openLog', eventId });
        } else if (detailAction.dataset.detailAction === 'showPrompt') {
          const promptEvent = state.events.find((item) => item.id === eventId);
          const sourceEvent = state.events.find((item) => item.id === Number(detailAction.dataset.sourceEventId));

          if (sourceEvent && (sourceEvent.relatedPromptDetail || sourceEvent.relatedPromptSummary || promptEvent)) {
            selectedEventId = sourceEvent.id;
            promptFallback = {
              sourceEventId: sourceEvent.id,
              summary: sourceEvent.relatedPromptSummary || promptEvent?.label || 'Prompt',
              detail: sourceEvent.relatedPromptDetail || promptEvent?.detail || promptEvent?.label || sourceEvent.relatedPromptSummary,
              logName: sourceEvent.logName,
              lineNumber: sourceEvent.relatedPromptLineNumber || promptEvent?.lineNumber
            };
          }

          renderEvents();
        }
        return;
      }

      const eventButton = target.closest('[data-event-id]');

      if (eventButton) {
        const eventId = Number(eventButton.dataset.eventId);
        selectedEventId = selectedEventId === eventId ? undefined : eventId;
        promptFallback = undefined;
        renderEvents();
      }
    });

    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'update') {
        return;
      }

      // Check if state actually changed to prevent flickering
      const currentStateJson = JSON.stringify({
        s: event.data.state.statusText,
        k: event.data.state.statusKind,
        e: event.data.state.events.map(e => e.id + e.summary)
      });
      if (currentStateJson === lastStateJson) { return; }
      lastStateJson = currentStateJson;

      if (paused) {
        pendingState = event.data.state;
        pendingUpdateCount += 1;
        renderPausedChrome();
        return;
      }

      state = event.data.state;
      reconcileSelection();
      render();
    });

    render();

    function render() {
      statusText.textContent = state.statusText;
      statusDot.style.background = statusColor(state.statusKind);
      logName.textContent = state.logName;
      logDetail.textContent = state.logDetail || '';
      followMode.textContent = state.followMode === 'pinned' ? 'Pinned to this log' : 'Following newest log';
      lastUpdate.textContent = 'Updated ' + state.lastUpdate;
      modeAction.dataset.action = state.followMode === 'pinned' ? 'followLatest' : 'pinCurrent';
      modeAction.textContent = state.followMode === 'pinned' ? '▶ Follow latest' : '📌 Pin current';
      renderPausedChrome();
      renderEvents();
    }

    function renderPausedChrome() {
      document.body.classList.toggle('paused', paused);
      pauseAction.textContent = paused ? '▶ Resume' : '⏸ Pause';
      pauseAction.setAttribute('aria-pressed', paused ? 'true' : 'false');

      if (!paused) {
        pauseBanner.textContent = 'Paused';
        return;
      }

      const waiting = pendingUpdateCount === 0 ? 'No new updates yet' : pendingUpdateCount + ' update' + (pendingUpdateCount === 1 ? '' : 's') + ' waiting';
      pauseBanner.textContent = 'Paused · activity is frozen · ' + waiting;
    }

    function reconcileSelection() {
      if (selectedEventId !== undefined && !state.events.some((item) => item.id === selectedEventId)) {
        selectedEventId = undefined;
        promptFallback = undefined;
      }

      if (promptFallback !== undefined && !state.events.some((item) => item.id === promptFallback.sourceEventId)) {
        promptFallback = undefined;
      }
    }

    function renderEvents() {
      if (state.events.length === 0) {
        eventsRoot.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No recent activity';
        eventsRoot.appendChild(empty);
        return;
      }

      const fragment = document.createDocumentFragment();
      let lastPromptSequence = undefined;
      for (const item of state.events) {
        if (item.promptSequence !== undefined && item.promptSequence !== lastPromptSequence) {
          const separator = document.createElement('div');
          separator.className = 'group-separator';
          separator.textContent = 'Ask ' + item.promptSequence;
          fragment.appendChild(separator);
          lastPromptSequence = item.promptSequence;
        }

        const shell = document.createElement('div');
        shell.className = 'event-shell';
        shell.appendChild(renderEventButton(item));

        if (item.id === selectedEventId) {
          shell.appendChild(renderInlineDetail(item));
          if (promptFallback?.sourceEventId === item.id) {
            shell.appendChild(renderPromptFallback(promptFallback));
          }
        }

        fragment.appendChild(shell);
      }

      eventsRoot.textContent = '';
      eventsRoot.appendChild(fragment);
    }

    function renderEventButton(item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'event' + (item.id === selectedEventId ? ' selected' : '');
      button.dataset.eventId = String(item.id);
      button.setAttribute('aria-label', 'Show details for ' + item.label);

      const tag = document.createElement('span');
      tag.className = 'tag ' + item.tagClass;
      tag.textContent = item.kind;

      const text = document.createElement('span');
      text.className = 'event-text';
      const label = document.createElement('strong');
      label.textContent = item.label;
      const hint = document.createElement('span');
      hint.className = 'event-hint';
      hint.textContent = item.detail;
      text.append(label, hint);
      const meta = renderEventMeta(item);
      if (meta) {
        text.appendChild(meta);
      }

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = item.timestamp;

      button.append(tag, text, time);
      return button;
    }

    function renderEventMeta(item) {
      if (item.promptSequence === undefined && item.promptStep === undefined) {
        return undefined;
      }

      const meta = document.createElement('span');
      meta.className = 'event-meta';

      if (item.promptSequence !== undefined) {
        meta.appendChild(renderChip('Ask ' + item.promptSequence));
      }

      if (item.promptStep !== undefined) {
        meta.appendChild(renderChip('Step ' + item.promptStep, true));
      }

      return meta;
    }

    function renderChip(label, muted) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (muted ? ' chip-muted' : '');
      chip.textContent = label;
      return chip;
    }

    function renderInlineDetail(item) {
      const detail = document.createElement('section');
      detail.className = 'inline-detail';
      detail.setAttribute('aria-live', 'polite');

      const title = document.createElement('div');
      title.className = 'detail-title';
      const tag = document.createElement('span');
      tag.className = 'tag ' + item.tagClass;
      tag.textContent = item.kind;
      const titleText = document.createElement('strong');
      titleText.textContent = item.kind === 'ASK' ? 'Prompt' : item.label;
      title.append(tag, titleText);

      const grid = document.createElement('div');
      grid.className = 'detail-grid';
      appendDetail(grid, 'Time', item.timestamp);
      appendDetail(grid, 'Type', item.kind);
      if (item.promptSequence !== undefined) {
        appendDetail(grid, 'Ask', String(item.promptSequence));
      }
      if (item.promptStep !== undefined) {
        appendDetail(grid, 'Step', String(item.promptStep));
      }
      appendDetail(grid, 'Session', item.logName);
      appendDetail(grid, 'Line', item.lineNumber ? String(item.lineNumber) : '--');

      if (item.kind !== 'ASK') {
        appendDetailIfUseful(grid, 'Prompt', shortPromptReference(item), item.label);
      }

      const mainDetail = detailBody(item);
      appendDetailIfUseful(grid, 'Meta', item.metadata.length > 0 ? item.metadata.map((entry) => entry.label + ': ' + entry.value).join(' · ') : '');

      const actions = document.createElement('div');
      actions.className = 'detail-actions';
      const openLog = item.hasLogPath ? renderDetailAction('Open log', 'openLog', item.id) : null;
      const showPrompt = item.relatedPromptId !== undefined ? renderDetailAction('Show prompt', 'showPrompt', item.relatedPromptId) : null;

      if (openLog) {
        actions.appendChild(openLog);
      }

      if (showPrompt) {
        showPrompt.dataset.sourceEventId = String(item.id);
        actions.appendChild(showPrompt);
      }

      detail.append(title, grid);

      if (mainDetail && item.kind === 'ASK') {
        appendPromptBlocks(detail, mainDetail);
      } else if (mainDetail) {
        appendDetailBlock(detail, detailHeading(item), mainDetail, item.kind);
      }

      detail.append(actions);

      if (actions.childElementCount === 0) {
        actions.remove();
      }

      return detail;
    }

    function renderPromptFallback(prompt) {
      const detail = document.createElement('section');
      detail.className = 'inline-detail';
      detail.setAttribute('aria-live', 'polite');

      const title = document.createElement('div');
      title.className = 'detail-title';
      const tag = document.createElement('span');
      tag.className = 'tag tag-ask';
      tag.textContent = 'ASK';
      const titleText = document.createElement('strong');
      titleText.textContent = 'Prompt';
      title.append(tag, titleText);

      const grid = document.createElement('div');
      grid.className = 'detail-grid';
      appendDetail(grid, 'Session', prompt.logName);
      appendDetail(grid, 'Line', prompt.lineNumber ? String(prompt.lineNumber) : '--');

      detail.append(title, grid);
      appendPromptBlocks(detail, stripPrefix(prompt.detail || prompt.summary, 'Prompt:'));
      return detail;
    }

    function appendPromptBlocks(parent, value) {
      const parts = splitPromptParts(value);
      const wrapper = document.createElement('div');
      wrapper.className = 'prompt-parts';

      for (const part of parts) {
        const block = document.createElement('div');
        block.className = 'prompt-part ' + part.className;

        const title = document.createElement('span');
        title.className = 'prompt-part-title';
        title.textContent = part.title;

        block.append(title, ...renderRichText(part.text));
        wrapper.appendChild(block);
      }

      const heading = document.createElement('div');
      heading.className = 'detail-heading';
      heading.textContent = 'Prompt';
      parent.append(heading, wrapper);
    }

    function splitPromptParts(value) {
      const cleaned = (value || '').trim();

      if (!cleaned) {
        return [{ title: 'Request', text: 'empty prompt', className: 'prompt-request' }];
      }

      const requestMarker = '## My request for Codex:';
      const requestIndex = cleaned.indexOf(requestMarker);

      if (requestIndex === -1) {
        return [{ title: 'Request', text: cleaned, className: 'prompt-request' }];
      }

      const before = cleaned.slice(0, requestIndex).trim();
      const after = cleaned.slice(requestIndex + requestMarker.length).trim();
      const parts = [];

      if (before) {
        parts.push({
          title: 'IDE context',
          text: normalizePromptContext(before),
          className: 'prompt-context'
        });
      }

      parts.push({
        title: 'User request',
        text: after || 'empty prompt',
        className: 'prompt-request'
      });

      return parts;
    }

    function normalizePromptContext(value) {
      return value
        .replace(/^# Context from my IDE setup:\s*/i, '')
        .replace(/^# Context\s*/i, '')
        .replace(/##\s*/g, '')
        .trim();
    }

    function appendDetailBlock(parent, heading, value, kind) {
      if (!value) {
        return;
      }

      const title = document.createElement('div');
      title.className = 'detail-heading';
      title.textContent = heading;

      const body = document.createElement('div');
      body.className = 'detail-card';
      body.style.borderLeftColor = tagColor(kind);
      body.append(...renderRichText(value));
      parent.append(title, body);
    }

    function appendDetail(grid, key, value) {
      const keyNode = document.createElement('span');
      keyNode.className = 'detail-key';
      keyNode.textContent = key;
      const valueNode = document.createElement('span');
      valueNode.className = 'detail-value';
      valueNode.textContent = value;
      grid.append(keyNode, valueNode);
    }

    function appendDetailIfUseful(grid, key, value) {
      if (!value) {
        return;
      }

      for (let index = 3; index < arguments.length; index += 1) {
        if (value === arguments[index]) {
          return;
        }
      }

      appendDetail(grid, key, value);
    }

    function detailHeading(item) {
      if (item.kind === 'RUN') { return 'Command'; }
      if (item.kind === 'ASK') { return 'Prompt'; }
      if (item.kind === 'EDIT') { return 'Change'; }
      if (item.kind === 'TOOL') { return 'Tool'; }
      return 'Detail';
    }

    function detailBody(item) {
      if (item.kind === 'ASK') {
        return stripPrefix(item.detail, 'Prompt:');
      }

      if (item.kind === 'RUN') {
        return stripPrefix(item.detail, 'Command:');
      }

      if (item.detail && item.detail !== item.label && item.detail !== item.summary) {
        return item.detail;
      }

      return undefined;
    }

    function shortPromptReference(item) {
      const value = item.relatedPromptSummary || item.relatedPromptDetail;

      if (!value) {
        return undefined;
      }

      const compact = value.replace(/\\s+/g, ' ').trim();
      return compact.length > 120 ? compact.slice(0, 119) + '...' : compact;
    }

    function stripPrefix(value, prefix) {
      if (!value) {
        return value;
      }

      return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
    }

    function renderRichText(value) {
      const nodes = [];
      const pattern = /\\b(Command|Prompt|RUN|ASK|EDIT|TOOL|Session|Step)\\b/g;
      let cursor = 0;
      let match;

      while ((match = pattern.exec(value)) !== null) {
        if (match.index > cursor) {
          nodes.push(document.createTextNode(value.slice(cursor, match.index)));
        }

        const strong = document.createElement('strong');
        strong.textContent = match[0];
        nodes.push(strong);
        cursor = match.index + match[0].length;
      }

      if (cursor < value.length) {
        nodes.push(document.createTextNode(value.slice(cursor)));
      }

      return nodes.length > 0 ? nodes : [document.createTextNode(value)];
    }

    function renderDetailAction(label, action, eventId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'detail-action';
      button.textContent = label;
      button.dataset.detailAction = action;

      if (eventId !== undefined) {
        button.dataset.eventId = String(eventId);
      }

      return button;
    }

    function statusColor(kind) {
      if (kind === 'working') {
        return 'var(--vscode-charts-yellow)';
      }

      if (kind === 'watching') {
        return 'var(--vscode-charts-green)';
      }

      if (kind === 'error') {
        return 'var(--vscode-charts-red)';
      }

      return 'var(--vscode-descriptionForeground)';
    }

    function tagColor(kind) {
      if (kind === 'RUN') { return 'var(--vscode-charts-purple)'; }
      if (kind === 'ASK') { return 'var(--vscode-charts-yellow)'; }
      if (kind === 'EDIT') { return 'var(--vscode-charts-orange)'; }
      if (kind === 'TOOL') { return 'var(--vscode-charts-blue)'; }
      return 'var(--vscode-charts-green)';
    }
  </script>
</body>
</html>`;
}

function commandForAction(action: string): string | undefined {
  switch (action) {
    case 'watchAnother':
      return 'codexStatusline.watchAnotherLog';
    case 'pinCurrent':
      return 'codexStatusline.pinCurrentLog';
    case 'followLatest':
      return 'codexStatusline.unpinFollowLatest';
    case 'clearActivity':
      return 'codexStatusline.clearActivity';
    default:
      return undefined;
  }
}

function isMessage(value: unknown): value is { action: string; eventId?: unknown } {
  return typeof value === 'object' && value !== null && 'action' in value && typeof value.action === 'string';
}

function eventLabel(summary: string): string {
  return summary.replace(/^(ASK|RUN|EDIT|FILE|TOOL)\s+/, '').trim();
}

function eventTag(summary: string): { label: string; className: string } {
  if (summary.startsWith('ASK')) {
    return { label: 'ASK', className: 'tag-ask' };
  }

  if (summary.startsWith('RUN')) {
    return { label: 'RUN', className: 'tag-run' };
  }

  if (summary.startsWith('EDIT') || summary.startsWith('FILE')) {
    return { label: 'EDIT', className: 'tag-edit' };
  }

  if (summary.startsWith('TOOL')) {
    return { label: 'TOOL', className: 'tag-tool' };
  }

  return { label: 'LOG', className: 'tag-log' };
}

function formatTime(date: Date): string {
  return formatClockTime(date, true);
}

function createNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}
