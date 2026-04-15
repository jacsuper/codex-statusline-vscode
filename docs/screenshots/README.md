# Screenshots

GitHub README screenshots live here, but they are excluded from the packaged VSIX.

Before committing screenshots, check for:

- absolute local paths, especially home directories under `/Users/...` or `C:\Users\...`
- private project names, repository names, branch names, domains, or file paths
- raw prompt text that includes sensitive code, intent, client names, or business context
- Codex rollout filenames or session IDs if they reveal more than the feature needs
- visible chat content, diffs, or file lists from unrelated work
- account names, extension/account badges, or other machine-specific UI

Recommended captures:

- `activity-overview.png`: `Codex Activity` view cropped to the sidebar with sanitized activity rows
- `activity-detail.png`: row detail panel showing split IDE context and user request blocks
- `watch-other.png`: `Watch Another Log` Quick Pick with friendly log labels
- `status-hover.png`: status bar hover with the local path redacted
