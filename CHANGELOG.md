# Changelog

All notable changes to Codex Statusline will be documented in this file.

This project follows a pragmatic pre-1.0 changelog style while the extension is still stabilizing.

## 0.0.1 - Unreleased

### Added

- Initial TypeScript VS Code extension scaffold.
- Automatic Codex rollout log discovery under the configured sessions root.
- Append-only rollout log tailing with partial-line buffering and truncation recovery.
- Defensive JSONL parsing for a conservative subset of operational events.
- Compact status bar item.
- Dockable `Codex Activity` webview with sanitized activity rows, inline expandable details, and sticky session controls.
- Pinned and follow-latest modes for multi-Codex workflows.
- Friendly rollout labels such as `Today 19:16`.
- Cross-platform path display handling for macOS, Linux, and Windows.
- Configurable sessions root, polling interval, recent event count, output channel, and idle timeout.
- Initial history seeding when a rollout log is first watched.
- Ask grouping with per-ask step labels.
- Prompt extraction with separated IDE context and user request sections.
- Open-log support that falls back to a bounded excerpt for very large rollout logs.
- Local VSIX packaging and reinstall scripts.
- Marketplace metadata, icon, GitHub screenshots, and README feature screenshots.
- Marketplace publish script that tests, packages, and uploads the generated VSIX.
- Unit tests for parser, locator, tailer, display formatting, and follow target behavior.
- VS Code Extension Host command-registration smoke test.

### Security

- Activity webview uses a Content Security Policy with nonces.
- Raw message contents are suppressed from normal UI output.
- Command and file summaries are sanitized before display.
- Screenshots are committed for GitHub documentation but excluded from packaged VSIX output.

### Known Gaps

- Integration test coverage does not yet inspect the rendered webview DOM.
- Real-world parser fixtures still need to be collected from sanitized rollout event shapes.
- Marketplace publishing still requires a local `vsce` login session or `VSCE_PAT` environment variable.
