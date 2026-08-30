# Vita3K Codex MCP sidecar

This repository-local STDIO MCP server lets Codex build Vita3K and drive one visible emulator process through a private Windows named pipe. It exposes build status, installed apps, launch/session state, frame capture, bounded controller/touch input, incremental logs, restart, stop, and shutdown.

## Local-only setup

The project configuration in `.codex/config.toml` starts `launch.ps1`. On first use it accepts an existing Node 24 installation or downloads portable Node into `.tools/node`, then runs `npm ci` only in this directory. `build_start` provisions portable CMake, a local Python virtual environment, aqtinstall, and Qt under `.tools`. It only discovers an existing Visual Studio 2022 C++ workload and Windows SDK; it never launches an installer.

Tool versions and archive hashes are pinned in `toolchain.lock.json`. Downloads are cached below `.tools/cache`. The scripts modify environment variables only for their child processes.

To validate the sidecar without downloading Qt or building Vita3K:

```powershell
npm test --prefix tools/vita3k-mcp
```

After a local build, run the reusable real-emulator smoke workflow with an installed homebrew Title ID:

```powershell
npm --prefix tools/vita3k-mcp run smoke:real -- --title-id STSVDEMO1
```

The smoke workflow waits for a capturable frame, validates MCP image content, exercises pause, front touch, controller input, restart, resume, stop, and graceful shutdown, and leaves its evidence in `.vita3k-mcp/runs/`.

After reopening/trusting the project in Codex, the `vita3k` MCP service is available automatically. A typical tool sequence is:

1. `build_start`, then `build_status` until terminal.
2. `list_apps`, then `launch_app` with a Title ID or a user-scoped VPK/ZIP/directory.
3. `session_status` until `running`, then `capture_screen`, `send_input`/`touch`, `get_logs`.
4. `control_session` with `stop` or `shutdown` when finished.

Each launch writes `.vita3k-mcp/runs/<timestamp>-<sessionId>/manifest.json`, logs, and numbered PNG captures. The authentication token is never persisted. Games may still update their ordinary Vita3K save data.

## Development override

Set `VITA3K_EXECUTABLE` only in the process launching Codex/MCP to test an existing compatible build. No persistent environment setting is required.
