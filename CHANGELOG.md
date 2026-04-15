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
- Dockable `Codex Activity` webview with sanitized activity rows and click-to-detail behavior.
- Pinned and follow-latest modes for multi-Codex workflows.
- Friendly rollout labels such as `Today 19:16`.
- Cross-platform path display handling for macOS, Linux, and Windows.
- Configurable sessions root, polling interval, recent event count, output channel, and idle timeout.
- Unit tests for parser, locator, tailer, display formatting, and follow target behavior.
- VS Code Extension Host command-registration smoke test.

### Security

- Activity webview uses a Content Security Policy with nonces.
- Raw message contents are suppressed from normal UI output.
- Command and file summaries are sanitized before display.

### Known Gaps

- Integration test coverage does not yet inspect the rendered webview DOM.
- Real-world parser fixtures still need to be collected from sanitized rollout event shapes.
- Marketplace screenshots/GIF are not yet committed.
