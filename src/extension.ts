import * as vscode from 'vscode';
import { CodexActivityView } from './activityView';
import { CodexStatuslineWatcher } from './watcher';

export function activate(context: vscode.ExtensionContext): void {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const output = vscode.window.createOutputChannel('Codex Statusline');
  const watcher = new CodexStatuslineWatcher(statusBarItem, output);
  const activityView = new CodexActivityView();

  context.subscriptions.push(
    watcher,
    vscode.window.registerWebviewViewProvider('codexStatusline.activityView', activityView),
    watcher.onDidUpdate(({ status, events }) => activityView.update(status, events)),
    vscode.commands.registerCommand('codexStatusline.startWatching', () => watcher.start()),
    vscode.commands.registerCommand('codexStatusline.stopWatching', () => watcher.stop()),
    vscode.commands.registerCommand('codexStatusline.refreshNow', () => watcher.refresh()),
    vscode.commands.registerCommand('codexStatusline.showOutput', () => watcher.showOutput()),
    vscode.commands.registerCommand('codexStatusline.showActivity', () => vscode.commands.executeCommand('codexStatusline.activityView.focus')),
    vscode.commands.registerCommand('codexStatusline.watchAnotherLog', () => watcher.selectLogToWatch()),
    vscode.commands.registerCommand('codexStatusline.pinCurrentLog', () => watcher.pinCurrentLog()),
    vscode.commands.registerCommand('codexStatusline.unpinFollowLatest', () => watcher.unpinFollowLatest()),
    vscode.commands.registerCommand('codexStatusline.copyCurrentStatus', () => watcher.copyCurrentStatus()),
    vscode.commands.registerCommand('codexStatusline.clearActivity', () => watcher.clearActivity()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexStatusline')) {
        watcher.start();
      }
    })
  );

  activityView.update(watcher.snapshot().status, watcher.snapshot().events);
  watcher.start();
}

export function deactivate(): void {}
