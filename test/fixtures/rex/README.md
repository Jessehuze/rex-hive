# Rex screen fixtures

These are real screens of Claude Code running in a Rex block, captured with `rex capture --format=vt`. That command is the same output as the block method `com.superlogical.terminal.format` with `{"format":"vt"}`. They are parser fixtures: they let tests check that hive's input-box and dialog classifiers read Rex `vt` output the same way they read tmux `capture-pane -e` output.

- Rex: `0.1.0-preview.25` (api_revision 24), macOS arm64
- Claude Code: `2.1.332`
- Captured: 2026-11-26, at an 80x24 block

| File | Screen | Expected classification | `program_status` root record at capture |
|---|---|---|---|
| `claude-idle.vt` | input box, empty prompt | input box `ghost` (Claude's dim placeholder; nobody typed it) | `idle` |
| `claude-typing.vt` | input box with unsubmitted text | input box `pending` | `idle` |
| `claude-dialog.vt` | Bash permission dialog ("Do you want to proceed?") | awaiting a choice | `blocked`, kind `permission`, msg `approve Bash: touch made-by-fixture.txt` |
| `claude-trust-dialog.vt` | workspace trust dialog | awaiting a choice | `blocked`, kind `permission`, msg `trust this folder` |

Notes:
- Rex `vt` output moves the cursor forward with `CSI n C` where tmux emits literal spaces, so a capture may need normalising before the classifiers read it.
- No Codex fixture is included, because Codex was not installed on the capture machine.
- The fixtures were scrubbed with same-length replacements, so column widths are unchanged. The user and org names, the Claude session id inside the working-directory path, and the plan name were replaced with placeholders.
