import * as path from 'node:path';
import { setInterval, clearInterval } from 'node:timers';
import * as vscode from 'vscode';
import { CodexStatuslineConfig, getConfig } from './config';
import { parseLogLine, ParsedLogEvent } from './eventParser';
import { FollowTargetResolver } from './followTarget';
import { formatClockTime, formatRolloutLogDisplay, formatRolloutLogQuickPickDescription, formatRolloutLogQuickPickDetail } from './logDisplay';
import { findLatestRolloutLog, findRolloutLogs, RolloutLogFile } from './logLocator';
import { LogTailer, TailedLogLine } from './logTailer';
import { CodexStatus, createStatus } from './statusModel';

export interface ActivityEvent {
  id: number;
  summary: string;
  timestamp: Date;
  logName?: string;
  logPath?: string;
  lineNumber?: number;
  detail?: string;
  statusText?: string;
  metadata?: { label: string; value: string }[];
  relatedPromptId?: number;
  relatedPromptSummary?: string;
  relatedPromptDetail?: string;
  relatedPromptLogPath?: string;
  relatedPromptLineNumber?: number;
  promptSequence?: number;
  promptStep?: number;
}

export class CodexStatuslineWatcher implements vscode.Disposable {
  private timer: any;
  private config: CodexStatuslineConfig = getConfig();
  private status: CodexStatus = createStatus('stopped');
  private recentEvents: ActivityEvent[] = [];
  private nextEventId = 1;
  private isRefreshing = false;
  private isBatching = false;
  private lastPrompt: ActivityEvent | undefined;
  private currentPromptSequence = 0;
  private currentPromptStep = 0;
  private readonly followTarget = new FollowTargetResolver();
  private readonly tailer = new LogTailer();
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<{ status: CodexStatus; events: ActivityEvent[] }>();
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  constructor(
    private readonly statusBarItem: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel
  ) {}

  snapshot(): { status: CodexStatus; events: ActivityEvent[] } {
    return {
      status: this.status,
      events: this.recentEvents
    };
  }

  start(): void {
    this.stopTimer();
    this.config = getConfig();

    if (!this.config.enabled) {
      this.setStatus(createStatus('stopped', undefined, 'Watcher disabled in settings.'));
      this.appendEvent('Watcher disabled in settings.');
      return;
    }

    this.appendEvent('Started watching Codex rollout logs.');
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.pollIntervalMs);
  }

  stop(): void {
    this.stopTimer();
    this.setStatus(createStatus('stopped', this.status.followedLogPath, 'Watcher stopped.'));
    this.appendEvent('Stopped watching Codex rollout logs.');
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing) { return; }
    this.isRefreshing = true;
    this.config = getConfig();
    let targetLog: RolloutLogFile | undefined;

    try {
      targetLog = await this.resolveTargetLog();
      const currentPath = this.status.followedLogPath;

      if (!targetLog) {
        this.tailer.reset();
        if (this.status.kind !== 'no_log') {
          this.setStatus(createStatus('no_log', undefined, `No rollout log found under ${this.config.sessionsRoot}.`, undefined, this.followMode));
        }
        return;
      }

      const switchedLog = currentPath !== undefined && targetLog.path !== currentPath;
      const isFirstLoad = currentPath === undefined || this.status.kind === 'no_log' || this.status.kind === 'error';
      let lines: TailedLogLine[] = [];

      this.isBatching = true;

      if (switchedLog || isFirstLoad) {
        let history: TailedLogLine[] = [];
        try {
          history = await this.readHistoryForVisibleEvents(targetLog.path, this.config.initialHistoryLines);

          if (history.length > 0) {
            if (this.config.debug) {
              this.output.appendLine(`[History] Read ${history.length} raw lines while seeding ${targetLog.path}`);
            }

            this.recentEvents = [];
            this.lastPrompt = undefined;
            this.currentPromptSequence = 0;
            this.currentPromptStep = 0;

            for (const line of history) {
              this.processLogLine(line, targetLog.path);
            }
          }
        } catch (err) {
          if (this.config.debug) {
            this.output.appendLine(`[History] Failed to seed history for ${targetLog.path}: ${err}`);
          }
        }

        this.appendEvent(`${this.followMode === 'pinned' ? 'Pinned' : 'Watching'} ${formatRolloutLogDisplay(targetLog.path).label}`, targetLog.path);
        
        lines = history;
      } else {
        lines = await this.tailer.readAppendedLines(targetLog.path);
        for (const line of lines) {
          this.processLogLine(line, targetLog.path);
        }
      }

      this.isBatching = false;

      const latestParsedEvent = this.recentEvents.at(-1);

      // Update status if anything changed or if it's the first successful load
      if (switchedLog || isFirstLoad || lines.length > 0) {
        if (latestParsedEvent?.statusText) {
          this.setStatus(createStatus('working', targetLog.path, latestParsedEvent.summary, latestParsedEvent.statusText, this.followMode));
        } else {
          this.setStatus(
            createStatus(
              'watching',
              targetLog.path,
              latestParsedEvent?.summary ?? `${this.followMode === 'pinned' ? 'Pinned to' : 'Watching'} ${formatRolloutLogDisplay(targetLog.path).label}`,
              this.followMode === 'pinned' ? 'Codex: pinned' : undefined,
              this.followMode
            )
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logPath = targetLog?.path || this.status.followedLogPath;
      this.setStatus(createStatus('error', logPath, message, undefined, this.followMode));
      
      this.appendEvent(`Error while finding rollout log: ${message}`, logPath, {
        relatedPromptId: this.lastPrompt?.id,
        relatedPromptSummary: promptLabel(this.lastPrompt),
        relatedPromptDetail: promptDetail(this.lastPrompt),
        relatedPromptLogPath: this.lastPrompt?.logPath,
        relatedPromptLineNumber: this.lastPrompt?.lineNumber
      });
    } finally {
      this.isBatching = false;
      this.isRefreshing = false;
    }
  }

  private processLogLine(line: TailedLogLine, logPath: string): void {
    const parsed = parseLogLine(line.text, { showFullPayload: (this.config as any).showFullEventPayloads });    
    if (parsed) {
      const isPrompt = parsed.kind === 'prompt';
      if (isPrompt) {
        this.currentPromptSequence += 1;
        this.currentPromptStep = 0;
      } else if (this.currentPromptSequence > 0) {
        this.currentPromptStep += 1;
      }

      const activity = this.appendEvent(parsed.summary, logPath, {
        ...parsed,
        lineNumber: line.lineNumber,
        relatedPromptId: isPrompt ? undefined : this.lastPrompt?.id,
        relatedPromptSummary: isPrompt ? undefined : promptLabel(this.lastPrompt),
        relatedPromptDetail: isPrompt ? undefined : promptDetail(this.lastPrompt),
        relatedPromptLogPath: isPrompt ? undefined : this.lastPrompt?.logPath,
        relatedPromptLineNumber: isPrompt ? undefined : this.lastPrompt?.lineNumber,
        promptSequence: this.currentPromptSequence > 0 ? this.currentPromptSequence : undefined,
        promptStep: isPrompt ? undefined : this.currentPromptStep > 0 ? this.currentPromptStep : undefined
      });

      if (isPrompt) {
        this.lastPrompt = activity;
      }
    }
  }

  private async readHistoryForVisibleEvents(logPath: string, targetVisibleEvents: number): Promise<TailedLogLine[]> {
    if (targetVisibleEvents <= 0) {
      await this.tailer.switchTo(logPath);
      return [];
    }

    const targetCount = Math.max(1, targetVisibleEvents);
    const maxRawLines = Math.max(this.config.maxRecentEvents, targetCount * 200, 5000);
    let rawLineCount = Math.max(targetCount * 4, 50);
    let bestHistory: TailedLogLine[] = [];
    let bestVisibleCount = 0;
    let bestHasPrompt = false;

    while (rawLineCount <= maxRawLines) {
      const history = await this.tailer.readRecentCompleteLines(logPath, rawLineCount);
      let visibleCount = 0;
      let hasPrompt = false;

      for (const line of history) {
        const parsed = parseLogLine(line.text);

        if (!parsed) {
          continue;
        }

        visibleCount += 1;
        hasPrompt ||= parsed.kind === 'prompt';
      }

      bestHistory = history;
      bestVisibleCount = visibleCount;
      bestHasPrompt = hasPrompt;

      if ((visibleCount >= targetCount && hasPrompt) || history.length < rawLineCount) {
        break;
      }

      rawLineCount *= 2;
    }

    if (this.config.debug) {
      this.output.appendLine(
        `[History] Seeded ${bestVisibleCount}/${targetCount} visible events from ${bestHistory.length} raw lines; prompt anchor: ${bestHasPrompt ? 'yes' : 'no'}.`
      );
    }

    return bestHistory;
  }

  async selectLogToWatch(): Promise<void> {
    this.config = getConfig();
    const logs = await findRolloutLogs(this.config.sessionsRoot);

    if (logs.length === 0) {
      void vscode.window.showInformationMessage('No Codex rollout logs found.');
      return;
    }

    const selection = await vscode.window.showQuickPick(
      logs.slice(0, 30).map((log: RolloutLogFile) => ({
        label: formatRolloutLogDisplay(log.path).label,
        description: formatRolloutLogQuickPickDescription(log.path, log.mtimeMs),
        detail: formatRolloutLogQuickPickDetail(log.path),
        log
      })),
      {
        title: 'Watch Codex Rollout Log',
        placeHolder: 'Select a rollout log to pin this VS Code window to'
      }
    );

    if (!selection) {
      return;
    }

    await this.pinToLog(selection.log.path);
  }

  async pinCurrentLog(): Promise<void> {
    if (!this.status.followedLogPath) {
      const latestLog = await findLatestRolloutLog(getConfig().sessionsRoot);

      if (!latestLog) {
        void vscode.window.showInformationMessage('No Codex rollout log is available to pin.');
        return;
      }

      await this.pinToLog(latestLog.path);
      return;
    }

    await this.pinToLog(this.status.followedLogPath);
  }

  async unpinFollowLatest(): Promise<void> {
    this.followTarget.followLatest();
    this.appendEvent('Following newest rollout log.');
    await this.refresh();
  }

  showOutput(): void {
    this.output.show(true);
  }

  async copyCurrentStatus(): Promise<void> {
    await vscode.env.clipboard.writeText(this.status.text);
    this.appendEvent(`Copied current status: ${this.status.text}`);
  }

  clearActivity(): void {
    this.recentEvents = [];
    this.lastPrompt = undefined;
    this.currentPromptSequence = 0;
    this.currentPromptStep = 0;
    this.onDidUpdateEmitter.fire({ status: this.status, events: this.recentEvents });
  }

  dispose(): void {
    this.stopTimer();
    this.statusBarItem.dispose();
    this.output.dispose();
    this.onDidUpdateEmitter.dispose();
  }

  private setStatus(status: CodexStatus): void {
    this.status = status;
    this.statusBarItem.text = status.text;
    this.statusBarItem.tooltip = this.createHover(status);
    this.onDidUpdateEmitter.fire({ status: this.status, events: this.recentEvents });

    if (this.config.showInStatusBar) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private createHover(status: CodexStatus): vscode.MarkdownString {
    const hover = new vscode.MarkdownString(undefined, true);
    hover.appendMarkdown(`**${status.text}**\n\n`);

    if (status.followedLogPath) {
      const friendlyName = formatRolloutLogDisplay(status.followedLogPath).label;
      if (friendlyName !== path.basename(status.followedLogPath)) {
        hover.appendMarkdown(`Session: **${friendlyName}**\n\n`);
      }
      hover.appendMarkdown(`Log: \`${status.followedLogPath}\`\n\n`);
    }

    hover.appendMarkdown(`Mode: ${status.followMode ?? this.followMode}\n\n`);

    if (status.lastEventSummary) {
      hover.appendMarkdown(`Last event: ${status.lastEventSummary}\n\n`);
    }

    hover.appendMarkdown(`Updated: ${formatClockTime(status.lastUpdate, true)}`);
    return hover;
  }

  private appendEvent(message: string, logPath = this.status.followedLogPath, metadata?: Partial<ActivityEvent>): ActivityEvent {
    const event: ActivityEvent = {
      id: this.nextEventId,
      summary: message,
      timestamp: new Date(),
      logName: logPath ? formatRolloutLogDisplay(logPath).label : undefined,
      logPath,
      detail: metadata?.detail,
      statusText: metadata?.statusText,
      lineNumber: metadata?.lineNumber,
      metadata: metadata?.metadata,
      relatedPromptId: metadata?.relatedPromptId,
      relatedPromptSummary: metadata?.relatedPromptSummary,
      relatedPromptDetail: metadata?.relatedPromptDetail,
      relatedPromptLogPath: metadata?.relatedPromptLogPath,
      relatedPromptLineNumber: metadata?.relatedPromptLineNumber,
      promptSequence: metadata?.promptSequence,
      promptStep: metadata?.promptStep
    };
    this.nextEventId += 1;
    this.recentEvents.push(event);
    this.recentEvents = this.recentEvents.slice(-this.config.maxRecentEvents);

    if (this.config.showOutputChannel) {
      this.output.appendLine(`[${formatClockTime(event.timestamp, true)}] ${message}`);
    }

    if (!this.isBatching) {
      this.onDidUpdateEmitter.fire({ status: this.status, events: this.recentEvents });
    }
    return event;
  }

  private appendEventOnce(message: string): void {
    if (this.recentEvents[this.recentEvents.length - 1]?.summary === message) {
      return;
    }

    this.appendEvent(message);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async resolveTargetLog(): Promise<RolloutLogFile | undefined> {
    const latestLog = await findLatestRolloutLog(this.config.sessionsRoot);
    return this.followTarget.resolve(latestLog);
  }

  private async pinToLog(logPath: string): Promise<void> {
    this.followTarget.pin(logPath);
    this.appendEvent(`Pinned ${formatRolloutLogDisplay(logPath).label}`, logPath);
    await this.refresh();
  }

  private get followMode(): 'pinned' | 'latest' {
    return this.followTarget.snapshot().mode;
  }
}

function promptLabel(event: ActivityEvent | undefined): string | undefined {
  return event?.summary.replace(/^ASK\s+/, '').trim();
}

function promptDetail(event: ActivityEvent | undefined): string | undefined {
  return event?.detail?.replace(/^Prompt:\s*/, '').trim() ?? promptLabel(event);
}
