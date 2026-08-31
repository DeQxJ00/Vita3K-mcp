# Vita3K Codex MCP 使用手册

本项目提供 Windows MCP sidecar，使 Codex 可以构建 Vita3K、启动应用、查看状态、截取当前帧、注入手柄/触摸输入、读取日志，以及重启或停止会话。日常使用推荐把便携 Node、服务端和依赖全部部署到 `Vita3K.exe` 旁的 `mcp/`，通过仅监听回环地址的 Streamable HTTP 连接；源码开发仍保留 STDIO 入口。

## 1. 三类目录不要混淆

| 目录 | 用途 | 示例 |
| --- | --- | --- |
| Vita3K 源码仓库 | MCP sidecar、构建脚本和本地工具链 | `E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp` |
| MCP 版 Vita3K 程序 | `Vita3K.exe`、Qt/FFmpeg DLL 和程序资源 | `E:\EmuGame\vita3k_mcp` |
| VitaFS 数据 | 固件、应用、补丁、配置映射和存档 | `E:\EmuGame\vita3k_data` |
| 便携 HTTP MCP | Node、服务端、日志和测试产物 | `E:\EmuGame\vita3k_mcp\mcp` |

上述示例中的 `vita3k_mcp` 与 `vita3k_data` 是 `E:\EmuGame` 下的两个同级目录，不是 `E:\EmuGame\vita3k` 的子目录。

MCP 版程序必须是由本 fork 构建的版本。普通官方 Vita3K 不包含私有命名管道控制层，sidecar 无法连接。

## 2. 当前机器的配置

### 2.1 指定 VitaFS 数据目录

编辑 MCP 版程序旁的 `config.yml`：

```yaml
pref-path: E:/EmuGame/vita3k_data/
```

建议在 YAML 中使用正斜杠，并保留末尾 `/`。

### 2.2 部署并启动便携 HTTP MCP

在源码仓库执行：

```powershell
& E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp\tools\vita3k-mcp\scripts\deploy-http.ps1 `
  -DestinationRoot E:\EmuGame\vita3k_mcp `
  -SourceRoot E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp
& E:\EmuGame\vita3k_mcp\mcp\Start-MCP.ps1
```

部署结果如下；不需要全局 Node 或 npm：

```text
E:\EmuGame\vita3k_mcp\mcp\
├── runtime\          # 便携 Node 24
├── server\           # 编译后的 MCP 和本地生产依赖
├── config\           # HTTP 配置
├── .tools\           # MCP 后续准备的 CMake/Qt/缓存
├── .vita3k-mcp\      # 测试产物
├── logs\
├── Start-MCP.cmd
├── Status-MCP.cmd
└── Stop-MCP.cmd
```

可双击三个 `.cmd`，也可直接运行对应 PowerShell 脚本。HTTP 主机只绑定 `127.0.0.1`，不会开放局域网端口。`deploy-http.ps1` 可重复执行。

### 2.3 注册为用户级全局 MCP

如果希望所有本地项目都能使用，在用户级 Codex 配置中注册一次即可。本机配置文件位于：

```text
C:\Users\DeQxJ00\.codex\config.toml
```

将以下内容追加到该文件；不要覆盖其中已有的其他 Codex 配置：

```toml
[mcp_servers.vita3k]
url = "http://127.0.0.1:32560/mcp"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 1200
required = false
```

此部署不要求 HTTP token，因此必须保持 `host` 为 `127.0.0.1`，不要改成 `0.0.0.0` 或局域网地址。Vita3K 子进程内部的随机命名管道 token 仍会保留，用来隔离私有控制层。Codex 官方支持 STDIO 和 Streamable HTTP MCP，参见 [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

保存后重启 Codex，或在 Codex 的 MCP servers 设置页选择 Restart。可以在任意项目目录执行以下命令确认：

```powershell
codex mcp list
```

输出中应出现状态为 `enabled` 的 `vita3k`。

### 2.4 只允许指定项目使用（可选）

若不希望全局启用，可以从用户级 `config.toml` 删除上述表，然后把同样的 HTTP 配置放到目标项目根目录的 `.codex/config.toml`。项目级配置只会在受信任项目中加载。

如果目标项目已经包含同名 `[mcp_servers.vita3k]`，请用 `codex mcp list` 检查最终生效的命令、工作目录和环境变量。本源码仓库自带的项目级配置与上述全局配置兼容；其他项目不需要再复制一份。若要同时连接另一份 Vita3K，应改用不同名称，例如 `[mcp_servers.vita3k_test]`。

## 3. 本地依赖策略

日常 HTTP 启动器为部署目录中的 `Start-MCP.ps1`；源码开发用 STDIO 启动器为 `tools/vita3k-mcp/launch.ps1`。

- Node 24 不存在时，只下载到仓库 `.tools/node/`。
- HTTP 部署的 Node 和 npm 生产依赖只安装到 `vita3k_mcp/mcp/runtime/` 与 `vita3k_mcp/mcp/server/node_modules/`。
- 源码开发依赖只安装到 `tools/vita3k-mcp/node_modules/`。
- CMake、Qt、Python 虚拟环境和缓存只放在仓库 `.tools/`。
- Vita3K 构建输出只放在仓库 `build/`。
- 只复用已有 Visual Studio 2022 C++ 工具链和 Windows SDK。
- 不运行 VS Installer，不全局安装 npm/Python 包，不修改 PATH、注册表或持久环境变量。

部署阶段会准备本地 Node 和生产依赖；首次 `build_start` 仍可能在 `mcp/.tools/` 中下载 CMake、Qt 等构建工具，因此会比以后慢。

## 4. 建议的 Codex 使用方式

通常不需要手写 MCP JSON。直接把目标和安全边界告诉 Codex即可。

### 列出已安装应用

```text
使用 vita3k MCP 刷新并列出当前数据目录中的应用，显示标题、Title ID 和版本。不要启动游戏。
```

### 启动并截图

```text
使用 vita3k MCP 启动 Title ID 为 PCSG00776 的应用。等待 session_status 显示 running 且 frameReady=true，然后截图并告诉我当前画面。不要自动输入。
```

### 交互测试

```text
使用 vita3k MCP 启动 PCSG00776。每次输入前先截图确认当前页面；一次只发送一个有限时长输入，输入后再次截图并检查 error 级别日志。测试结束后停止应用并关闭模拟器。
```

### 构建源码

```text
使用 vita3k MCP 以 RelWithDebInfo 启动增量构建。持续读取 build_status，直到 succeeded 或 failed；失败时给出最后的关键编译错误和日志 cursor。
```

## 5. Muv-Luv 测试提示词

下面这段可以直接复制给 Codex。普通《マブラヴ》的 Title ID 是 `PCSG00776`；《マブラヴ オルタネイティヴ》是 `PCSG00777`，不要混用。

```text
使用 vita3k MCP 测试 PCSG00776（マブラヴ）：
1. 先确认没有其他普通版或 MCP 版 Vita3K 正在运行。
2. 启动游戏，等待 running 且 frameReady=true。
3. 截图确认已经进入标题/开始画面；未确认前不要猜测或输入。
4. 确认标题画面后，短按 Start 100 ms。
5. 等待画面变化并再次截图，确认进入我所说的日文页面。
6. 确认页面正确后按住 R1 2000 ms，然后自动释放。
7. 再次截图，并读取 error 及以上级别的新日志，报告画面变化、错误和截图路径。
8. 测试结束后停止应用并关闭 Vita3K，确认没有残留进程。
不要操作存档删除、安装、升级或覆盖内容。
```

MCP 中的 Vita `R` 肩键名称是 `r1`。`r2` 表示右扳机，不要用错。单次按住最长 60 秒，到时 sidecar 会自动释放所有按钮并让摇杆回中。

## 6. 工具参考

### `build_start`

启动后台增量构建。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `configuration` | `Debug` / `RelWithDebInfo` / `Release` | `RelWithDebInfo` | 构建配置 |
| `reconfigure` | boolean | `false` | 是否重新运行 CMake configure |

返回 `buildId`。该工具不提供 clean，避免误删构建目录。

### `build_status`

读取构建阶段和增量输出。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `buildId` | UUID | 必填 | `build_start` 返回的 ID |
| `cursor` | 非负整数 | `0` | 从该位置读取新输出 |
| `waitMs` | 0–30000 | `0` | 等待新输出或完成的时间 |

阶段包括 `provisioning`、`configuring`、`building`、`succeeded` 和 `failed`。重复查询时传回上一次返回的 cursor，避免重复日志。

### `list_apps`

读取当前 VitaFS 中的应用。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `refresh` | boolean | `false` | 是否刷新应用缓存 |

如果 Vita3K 尚未运行，该调用会启动一个可见的空闲模拟器进程。

### `launch_app`

启动已安装应用，或安装并启动用户指定的本地内容。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `titleId` | string | 与 `contentPath` 二选一 | 已安装应用的 Title ID |
| `contentPath` | string | 与 `titleId` 二选一 | VPK、ZIP 或解包目录 |
| `appArgs` | string[] | `[]` | 传给应用的参数 |
| `replace` | boolean | `false` | 是否替换当前活动应用 |

返回 `sessionId`。同一时间只允许一个活动应用；除非用户明确要求，否则不要使用 `replace=true`。

### `session_status`

查看应用阶段、分辨率、首帧状态、进程 ID、运行时间和崩溃信息。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | UUID | 当前会话 | 指定会话 |
| `afterRevision` | 非负整数 | 可选 | 仅在状态版本变化后返回 |
| `waitMs` | 0–30000 | `0` | 最长等待时间 |

常见阶段：`starting`、`idle`、`installing`、`launching`、`running`、`paused`、`stopping`、`stopped`、`exited`、`crashed`、`failed`。

截图前应同时满足：

```text
phase = running 或 paused
frameReady = true
resolution.width > 0
resolution.height > 0
```

### `capture_screen`

参数只有 `sessionId`。返回 MCP image content、PNG 路径、宽度和高度。截图直接来自模拟器当前帧，不依赖窗口是否被其他窗口遮挡。

### `send_input`

发送按钮和摇杆状态，保持指定时间后自动全部释放。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | UUID | 必填 | 活动会话 |
| `buttons` | string[] | `[]` | 同时按下的按钮 |
| `leftStick` | `{x,y}` | 可选 | 左摇杆，范围 `[-1,1]` |
| `rightStick` | `{x,y}` | 可选 | 右摇杆，范围 `[-1,1]` |
| `durationMs` | 1–60000 | `100` | 保持时间 |

按钮名称：

```text
select start up right down left
triangle circle cross square ps
l1 r1 l2 r2 l3 r3
```

示例语义：

```text
短按 Start：buttons=["start"], durationMs=100
按住 R 肩键 2 秒：buttons=["r1"], durationMs=2000
左摇杆向右推 1 秒：leftStick={x:1,y:0}, durationMs=1000
```

### `touch`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | UUID | 必填 | 活动会话 |
| `port` | `front` / `rear` | 必填 | 前/后触摸板 |
| `points` | 1–32 个 `{x,y}` | 必填 | 归一化坐标 `[0,1]` |
| `durationMs` | 1–60000 | `100` | 点击保持或整段轨迹时间 |

一个点表示点击；多个点按顺序形成拖动轨迹。结束后自动抬起。

### `get_logs`

读取已去除 ANSI 控制符的增量日志。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | UUID | 可选 | 指定当前会话 |
| `cursor` | 非负整数 | `0` | 增量读取位置 |
| `minLevel` | 日志级别 | `trace` | 最低级别 |
| `limit` | 1–1000 | `200` | 最大行数 |

日志级别为 `trace`、`debug`、`info`、`warn`、`error`、`critical`。诊断画面或崩溃问题时，先读取 `error`，需要上下文时再降低级别。

### `control_session`

| action | 作用 | 注意 |
| --- | --- | --- |
| `pause` | 暂停应用 | 可在暂停画面截图 |
| `resume` | 恢复应用 | — |
| `restart` | 重启当前应用 | 可能丢失未保存进度 |
| `stop` | 停止当前应用 | 可能丢失未保存进度 |
| `shutdown` | 关闭 Vita3K | 可能丢失未保存进度 |

测试完成后应依次停止应用并关闭模拟器。异常中断后还应确认任务管理器中没有遗留的 `Vita3K.exe`。

## 7. 测试产物

每次 `launch_app` 会创建：

```text
E:\EmuGame\vita3k_mcp\mcp\.vita3k-mcp\runs\<时间>-<sessionId>\
├── manifest.json
├── vita3k.log
├── stderr.log
└── screenshots/
    ├── 0001.png
    └── 0002.png
```

`manifest.json` 记录构建版本、应用、状态时间线、退出码和错误；不会保存命名管道鉴权 token。游戏本身仍可能更新 `vita3k_data` 中的普通存档。

## 8. 安全与使用边界

- 不要同时运行普通版和 MCP 版 Vita3K，它们共享同一 VitaFS 时可能竞争配置、缓存或存档文件。
- 自动化输入前先截图确认页面，不要根据等待时间盲按。
- 一次只发送一个有界输入，随后截图并检查日志。
- `restart`、`stop`、`shutdown` 可能丢失未保存进度。
- 只测试用户明确指定或放入范围的内容。
- MCP 不提供固件、许可证、PKG/zRIF、内容删除、录屏或画面自动判定。

## 9. 常见故障

### Codex 中没有 `vita3k` 工具

1. 运行 `E:\EmuGame\vita3k_mcp\mcp\Status-MCP.cmd`，确认 HTTP 主机在线。
2. 如果未运行，执行 `Start-MCP.cmd`。
3. 运行 `codex mcp list`，确认 `vita3k` 的 URL 是 `http://127.0.0.1:32560/mcp` 且状态为 `enabled`。
4. 修改配置或重新启动 HTTP 主机后，重启 Codex 或在 MCP 设置页重连。

### `BINARY_NOT_FOUND`

检查 `mcp/config/mcp-config.json` 中的 `executable` 是否指向存在的 MCP 版 `Vita3K.exe`。重新运行部署脚本可修复该路径。

### `PIPE_TIMEOUT` 或连接后立即断开

通常说明启动的是普通 Vita3K、二进制版本与 sidecar 不匹配，或 Vita3K 在控制管道准备好前崩溃。先查看 `get_logs`、`stderr.log` 和 `manifest.json`。

### `list_apps` 为空或读取了错误应用

检查 MCP 版程序旁 `config.yml` 的 `pref-path`。启动日志应包含类似：

```text
VitaFS path: "E:/EmuGame/vita3k_data/"
```

### `SESSION_ACTIVE`

已有应用正在运行。先调用 `control_session(action="stop")`；只有用户明确要求替换时才使用 `replace=true`。

### `FRAME_NOT_READY`

应用可能仍在编译着色器、没有提交有效帧，或自身与当前 Vita3K 不兼容。读取会话状态和 error 日志，不要继续盲目输入。

### `MISSING_MSVC`

本机没有可用的 VS 2022 C++ 工具链或 Windows SDK。MCP 不会请求管理员权限，也不会自动启动 Visual Studio Installer。

### 构建下载失败或哈希错误

检查网络、磁盘空间和 `.tools` 是否可写。下载文件必须通过锁定清单中的 SHA-256 校验，不能绕过校验继续安装。

## 10. 验证命令

验证便携 HTTP 主机：

```powershell
E:\EmuGame\vita3k_mcp\mcp\Status-MCP.cmd
codex mcp list
```

停止 HTTP 主机不会删除测试数据；重新启动不需要重新部署：

```powershell
E:\EmuGame\vita3k_mcp\mcp\Stop-MCP.cmd
E:\EmuGame\vita3k_mcp\mcp\Start-MCP.cmd
```

验证 sidecar TypeScript 测试：

```powershell
E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp\.tools\node\npm.cmd test --prefix E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp\tools\vita3k-mcp
```

使用一个已安装且已知可正常渲染的 homebrew 做真实闭环测试：

```powershell
$env:VITA3K_EXECUTABLE = 'E:\EmuGame\vita3k_mcp\Vita3K.exe'
E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp\.tools\node\npm.cmd run smoke:real --prefix E:\WorkSpaceAI\psv_vita3k\Vita3K-mcp\tools\vita3k-mcp -- --title-id YOUR_TITLE_ID
```

这里的环境变量只对当前 PowerShell 及其子进程有效。真实 smoke 会执行截图、输入、触摸、暂停、重启和停止，请勿用有重要未保存进度的游戏进行验收。
