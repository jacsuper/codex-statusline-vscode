# Manual QA Checklist

Use this checklist before publishing or cutting a release.

## Setup

- [ ] Run `npm install`
- [ ] Run `npm run check`
- [ ] Run `npm run test:all`
- [ ] Launch the Extension Development Host with `F5`
- [ ] Confirm Codex has at least one local rollout log under the configured sessions root

## Activity View

- [ ] Confirm `Codex Activity` appears in Explorer
- [ ] Confirm the view renders without pressing `Start Watching`
- [ ] Confirm the status card shows a friendly log label such as `Today 19:16`
- [ ] Confirm long rollout filenames are not shown in the primary UI
- [ ] Confirm activity rows show compact tags such as `RUN`, `EDIT`, `TOOL`, and `LOG`
- [ ] Click an activity row and confirm the detail panel updates
- [ ] Move the view to another dock location and confirm layout remains usable

## Commands

- [ ] Run `Codex Statusline: Show Activity View`
- [ ] Run `Codex Statusline: Refresh Now`
- [ ] Run `Codex Statusline: Watch Another Log`
- [ ] Pick another rollout log and confirm the activity view shows the selected session
- [ ] Run `Codex Statusline: Unpin and Follow Latest`
- [ ] Run `Codex Statusline: Pin Current Log`
- [ ] Run `Codex Statusline: Copy Current Status` and confirm clipboard text is sanitized
- [ ] Run `Codex Statusline: Show Output` and confirm output is opt-in/plain text

## Multi-Session Behavior

- [ ] Start two Codex sessions on the same machine
- [ ] Confirm the extension pins to the initially detected session by default
- [ ] Confirm `Follow latest` switches to newest-log behavior
- [ ] Confirm `Watch other` can select a different session explicitly

## Privacy / Safety

- [ ] Confirm raw message contents do not appear in the activity view
- [ ] Confirm command summaries are compact and sanitized
- [ ] Confirm file summaries show only a basename
- [ ] Confirm malformed JSONL lines do not break the watcher

## Cross-Platform Spot Checks

- [ ] macOS: default root resolves to `~/.codex/sessions`
- [ ] Linux: default root resolves to `~/.codex/sessions`
- [ ] Windows: default root resolves to `%USERPROFILE%\.codex\sessions`

## Release Readiness

- [ ] Update `CHANGELOG.md`
- [ ] Verify `.vscodeignore`
- [ ] Add/update screenshots or GIFs
- [ ] Package locally with `vsce package`
