# Vita3K Codex MCP sidecar

中文使用手册：[`../../docs/codex-mcp-usage.zh-CN.md`](../../docs/codex-mcp-usage.zh-CN.md)

This MCP server offers both repository-local STDIO and loopback-only Streamable HTTP transports. It lets Codex build Vita3K and drive one visible emulator process through a private Windows named pipe. It exposes build status, installed apps, launch/session state, frame capture, bounded controller/touch input, incremental logs, restart, stop, and shutdown.

## Portable HTTP deployment

Deploy the compiled server, portable Node 24, production dependencies, logs, and run artifacts beside an MCP-enabled `Vita3K.exe`:

```powershell
& tools/vita3k-mcp/scripts/deploy-http.ps1 -DestinationRoot E:\EmuGame\vita3k_mcp
& E:\EmuGame\vita3k_mcp\mcp\Start-MCP.ps1
```

The endpoint is `http://127.0.0.1:32560/mcp` and does not require HTTP credentials. Keep it bound to loopback: do not expose it on `0.0.0.0` or a LAN address. `Start-MCP.cmd`, `Status-MCP.cmd`, and `Stop-MCP.cmd` are included in the deployment. Nothing is installed globally.

## Local-only setup

The development configuration in `.codex/config.toml` starts the STDIO `launch.ps1`. On first use it accepts an existing Node 24 installation or downloads portable Node into `.tools/node`, then runs `npm ci` only in this directory. `build_start` provisions portable CMake, a local Python virtual environment, aqtinstall, and Qt under the selected local `.tools`. It only discovers an existing Visual Studio 2022 C++ workload and Windows SDK; it never launches an installer.

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

Each launch writes `.vita3k-mcp/runs/<timestamp>-<sessionId>/manifest.json`, logs, and numbered PNG captures. The per-process named-pipe token is never persisted or written to manifests. Games may still update their ordinary Vita3K save data.

## Development override

Set `VITA3K_EXECUTABLE` only in the process launching Codex/MCP to test an existing compatible build. No persistent environment setting is required.
