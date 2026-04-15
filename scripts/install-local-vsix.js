const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pkg = require('../package.json');
const vsixPath = path.join(process.cwd(), `${pkg.name}-${pkg.version}.vsix`);

function commandCandidates() {
  const envCommand = process.env.VSCODE_CLI ? [process.env.VSCODE_CLI] : [];
  const commonCommands = ['code', 'code-insiders'];
  const macAppCommands = [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'
  ].filter(existsSync);

  return [...envCommand, ...commonCommands, ...macAppCommands];
}

if (!existsSync(vsixPath)) {
  console.error(`Missing VSIX: ${vsixPath}`);
  console.error('Run `npm run vsix:package` first, or use `npm run vsix:reinstall`.');
  process.exit(1);
}

let lastError;

for (const codeCommand of commandCandidates()) {
  const result = spawnSync(codeCommand, ['--install-extension', vsixPath, '--force'], {
    stdio: 'inherit'
  });

  if (!result.error) {
    process.exit(result.status ?? 1);
  }

  lastError = result.error;
  if (result.error.code !== 'ENOENT') {
    console.error(`Failed to run ${codeCommand}: ${result.error.message}`);
    process.exit(1);
  }
}

console.error(`Could not find a VS Code CLI to install ${path.basename(vsixPath)}.`);
if (lastError) {
  console.error(`Last error: ${lastError.message}`);
}
console.error('Install the VS Code shell command, or set VSCODE_CLI, for example:');
console.error('  VSCODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" npm run vsix:install');
console.error('  VSCODE_CLI="code-insiders" npm run vsix:install');
process.exit(1);
