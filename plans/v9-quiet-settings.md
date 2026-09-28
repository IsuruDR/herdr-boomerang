# boomerang v9: three settings in /config, the rest in an optional file

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clean install. `claude plugin install` said "10 userConfig options not yet set", although every option has a default and boomerang works without any answer.

**Why:** Claude Code counts each `userConfig` field without a saved value as "not yet set", and the `/plugin install` dialog asks one question per field. A plugin cannot turn that message off. The only lever is the number of fields. Three settings are the ones people really change. The other seven are for tuning.

**Tech stack:** as v7/v8 (Node 22.18+, `.ts` run directly, `node:test`).

## Design

```
 userConfig (plugin.json, shown in /config and in the install dialog)
   switch_mode            confirm | auto | notify
   cheap_model_agents     none | low-effort agents | low- and medium-effort agents
   cheap_model            provider/model

 ~/.claude/boomerang/config.json (optional, the user creates it only to tune)
   five_hour_threshold, seven_day_threshold, codex_placement, codex_args,
   hand_back, cheap_model_can_edit_files, delegate_timeout_seconds

 the 3 settings: userConfig ──> else the built-in default
 the 7 settings: config.json ──> else the built-in default   (neither reads the other)
```

- One reader for both paths (hooks get `CLAUDE_PLUGIN_OPTION_*`; the launcher and commands read `settings.json`). The seven tuning keys are read only from `config.json`, so a hook and the launcher can never see different values. Old saved values for those seven in `pluginConfigs` are ignored; nobody has saved any yet.
- `config.json` sits next to `~/.claude/boomerang/originals`, outside the plugin data folder, so it survives an uninstall.
- The file is read with a named result: missing (use defaults), valid, or invalid (use defaults, and SessionStart says why, every session until it is fixed).
- A test keeps `plugin.json` and the code in step: the manifest must declare exactly the three user-config keys.
- Tests never read the real home folder: they pass the file values in, and the hook process tests get a temp `HOME`.

## Tasks

- [ ] **1. Reader.** `readAdvancedConfig(path)` in `scripts/lib/hook-io.ts` returns `{kind: "missing"} | {kind: "valid", values} | {kind: "invalid", reason}`. `optionsFromEnv(env, advanced)` and `optionsFromSettings(saved, advanced)` take the file values. Tests: user config wins for the three keys, the file supplies the seven, bad values fall back to defaults, invalid JSON is reported.
- [ ] **2. Manifest.** Remove the seven fields from `.claude-plugin/plugin.json`. Test that exactly `switch_mode`, `cheap_model_agents` and `cheap_model` remain. `claude plugin validate` passes.
- [ ] **3. Callers.** `hook-context.ts`, and the `delegate`, `external` and `setup` entries, load the file once and pass it in. SessionStart adds a message when the file is invalid.
- [ ] **4. Tests stay out of the real home.** `tests/hooks.test.ts` runs its hook processes with a temp `HOME`.
- [ ] **5. README.** The settings section shows the three `/config` settings, and a `config.json` example with all seven keys and their defaults.
- [ ] **6. Checks and review.** `npm run check`; the code review; a real install shows "3 userConfig options not yet set".

## Watch out for

- The install still prints "3 userConfig options not yet set". That text is Claude Code's, and it goes away when the user opens `/plugin configure` once. The README says that the defaults already work.

## Implementation notes

- Review: config.json never fills in the three userConfig settings (a hook could get the manifest default in its env while the launcher read config.json, so they could disagree). Only strings, numbers and booleans count in config.json. A file that exists but cannot be read is reported as invalid. SessionStart names unknown keys, to catch typos.
