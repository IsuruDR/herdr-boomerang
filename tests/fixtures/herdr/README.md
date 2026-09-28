Real Herdr 0.9.0 CLI output, recorded on 2026-09-26 from a scratch tab. `.json` files are stdout of a
successful call; `.stderr` files are the JSON error Herdr prints on failure (exit code 1).
`process-info-*.json` keep only the process names (the real output has full argv, which can hold secrets).
`process-info-busy.json` is the shell fixture with the process name changed to `opencode`.
`agent-list.json` and `pane-list.json` keep only the fields we read. One agent name and one pane label were
edited to `boomerang-codex` and `boomerang-codebase-scout`, so the naming tests have something to collide with.
