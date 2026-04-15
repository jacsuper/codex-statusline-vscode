const path = require('node:path');
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const vscodeExecutablePath = resolveCliPathFromVSCodeExecutablePath(await downloadAndUnzipVSCode('1.92.2'));

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    version: '1.92.2'
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
