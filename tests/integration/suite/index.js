const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  await vscode.extensions.getExtension('jacsteyn.codex-statusline-vscode')?.activate();

  const commands = await vscode.commands.getCommands(true);
  const expectedCommands = [
    'codexStatusline.startWatching',
    'codexStatusline.stopWatching',
    'codexStatusline.refreshNow',
    'codexStatusline.showOutput',
    'codexStatusline.showActivity',
    'codexStatusline.watchAnotherLog',
    'codexStatusline.pinCurrentLog',
    'codexStatusline.unpinFollowLatest',
    'codexStatusline.copyCurrentStatus',
    'codexStatusline.clearActivity'
  ];

  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `Expected command to be registered: ${command}`);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusline-integration-'));
  const logDir = path.join(root, '2026', '04', '11');
  const logPath = path.join(logDir, 'rollout-2026-04-11T19-16-25-019d7dc2-test.jsonl');
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(logPath, '{}\n', 'utf8');

  const config = vscode.workspace.getConfiguration('codexStatusline');
  await config.update('sessionsRoot', root, vscode.ConfigurationTarget.Global);
  await config.update('pollIntervalMs', 1000, vscode.ConfigurationTarget.Global);
  await config.update('showOutputChannel', false, vscode.ConfigurationTarget.Global);

  await vscode.commands.executeCommand('codexStatusline.startWatching');
  await vscode.commands.executeCommand('codexStatusline.refreshNow');
  await vscode.commands.executeCommand('codexStatusline.unpinFollowLatest');
  await vscode.commands.executeCommand('codexStatusline.pinCurrentLog');
  await vscode.commands.executeCommand('codexStatusline.copyCurrentStatus');
  await vscode.commands.executeCommand('codexStatusline.clearActivity');

  const clipboard = await vscode.env.clipboard.readText();
  assert.match(clipboard, /^Codex:/);

  await vscode.commands.executeCommand('codexStatusline.stopWatching');
}

run()
  .then(() => {
    void vscode.commands.executeCommand('workbench.action.closeWindow');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
