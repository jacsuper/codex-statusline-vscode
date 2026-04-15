const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pkg = require('../package.json');

const vsixPath = path.join(process.cwd(), `${pkg.name}-${pkg.version}.vsix`);

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('npm', ['run', 'test:all']);
run('npm', ['run', 'vsix:package']);

if (!existsSync(vsixPath)) {
  console.error(`Expected VSIX was not created: ${vsixPath}`);
  process.exit(1);
}

console.log(`\nPublishing ${path.basename(vsixPath)} to the VS Code Marketplace.`);
console.log('Authentication: VSCE_PAT environment variable or prior `npx vsce login <publisher>` session.');

run('npx', ['vsce', 'publish', '--packagePath', vsixPath, '--no-dependencies']);
