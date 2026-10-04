# MCP-Aggregator

> **High-Performance Scale-to-Zero MCP Aggregation Gateway for Windows, macOS & Linux.**  
> 将多个分立的 MCP 服务无缝聚合为一个统一的 SSE 端点，提供基于智能路由的按需秒级唤醒与超时自动卸载（Scale-to-Zero）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Model Context Protocol](https://img.shields.io/badge/protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

---

## 🌟 核心特性 (Features)

1. **统一单端点聚合 (Unified SSE Endpoint)**：
   - 对所有 AI Agent 仅暴露单一统一入口：`http://127.0.0.1:3300/sse`。
   - 聚合对象覆盖**全部后端形态**：stdio（npm 包 / uvx / 任意命令）与**远程 HTTP MCP**（Streamable HTTP 优先、旧式 SSE 自动回退）。
   - 自动聚合所有挂载服务的工具定义，智能根据工具名称完成 O(1) 请求路由与转发。
   - 保持向后兼容：依然保留分立端点 `http://127.0.0.1:3300/:service/sse` 供独立调用。

2. **真·按需秒级拉起 + 冷态归零 (Scale-to-Zero)**：
   - **冷态 0 MB**：闲时所有后台服务子进程（MS365、Brave 等）**完全不运行**，物理内存占用为 0；远程 HTTP 后端则为空闲断连，不占用对端会话。
   - **秒级拉起**：当任何 Agent 触发对应工具调用时，网关瞬间唤醒单例进程处理（远程服务自动重连）。
   - **空闲回收**：支持自定义超时倒计时（默认 60 分钟），无请求自动杀掉子进程，释放系统资源。

3. **Schema 毫秒级极速响应 (Zero-Delay Cache)**：
   - Agent 连接与工具枚举（`tools/list`）直接命中本地静态 JSON 缓存，响应时间 `< 1ms`，**无需提前唤醒后台重量级进程**。
   - 唤醒时后台异步静默刷新缓存，彻底消灭唤醒过程中的阻塞时延。

4. **架构脱壳，杜绝僵尸进程 (No Zombie Processes on Windows)**：
   - 抛弃 `npx` / `cmd.exe` 套娃包裹，使用原生 Node 进程树直接托管，退出即彻底销毁，绝不产生悬空孤儿进程。

5. **插件化自由装载 (Pluggable Backends)**：
   - 支持通过声明式配置载入任意运行时：Node.js、Python (`uv run`)、本地可执行二进制，支持环境变量动态插值（`${ENV_VAR}`）。
   - npm 服务**只需声明包名**：网关启动时自动补装缺失依赖，并从包的 `bin` / `main` 字段自动解析真实入口，无需手动查找路径。

6. **网页控制台 (Web Console)**：
   - 浏览器访问 `http://127.0.0.1:3300/` 即可**监控与配置**：实时状态卡片、唤醒/休眠/删除操作、配置在线编辑并热应用（写盘前自动备份 `.bak`）。
   - **双配置路径**：表单模式（选择 npm 包 / 命令 / 远程 HTTP 类型后按提示填空）与 JSON 模式（直接手写完整配置），共享同一份 config.json。
   - 管理接口带同源防护，跨域网页无法读取配置或触发写操作。

---

## 🏗️ 架构示意 (Architecture)

```text
[ Hermes / Claude CLI / AstrBot / Cursor / Continue ]
                       │
                       │ 统一单入口: GET /sse  &  POST /message
                       ▼
┌────────────────────────────────────────────────────────┐
│            MCP-Aggregator Gateway (Express)            │
│  ├─ 网页控制台: GET /（监控 + 配置热编辑）             │
│  ├─ 统一聚合端点: GET /sse                             │
│  ├─ 分立兼容端点: GET /:service/sse                    │
│  ├─ 管理 API: /api/status · /api/config · wake/sleep   │
│  ├─ Schema 缓存层: cache/<service>-tools.json (<1ms)   │
│  └─ Scale-to-Zero 状态机 (sleeping / starting / warm)  │
└───────────────────────┬────────────────────────────────┘
                        │ 按需拉起（脱壳直连） / 按需重连
        ┌───────────────┼───────────────┬─────────────────┐
        ▼               ▼               ▼                 ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────────┐
│  Node: ms365 ││ Node: brave  ││ Python / uvx ││ 远程 HTTP MCP    │
│  (0MB 或热态)││ (0MB 或热态) ││ (扩展服务)   ││ (Streamable/SSE) │
└──────────────┘└──────────────┘└──────────────┘└──────────────────┘
```

---

## 🚀 快速上手 (Quick Start)

### 1. 克隆与安装依赖

```bash
git clone https://github.com/TheMountainTree/MCP-Aggregator.git
cd MCP-Aggregator
npm install
```

### 2. 配置服务

复制示例配置文件：

```bash
cp config.example.json config.json
```

**npm 服务只需声明包名**，网关会自动完成安装与入口解析：

```json
{
  "port": 3300,
  "defaultIdleTimeoutMinutes": 60,
  "services": {
    "ms365": {
      "package": "@softeria/ms-365-mcp-server",
      "args": ["--preset", "calendar"],
      "env": {},
      "idleTimeoutMinutes": 60
    },
    "brave-search": {
      "package": "@brave/brave-search-mcp-server",
      "args": [],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}",
        "HTTP_PROXY": "http://127.0.0.1:7890",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "NODE_USE_ENV_PROXY": "1"
      },
      "idleTimeoutMinutes": 15
    }
  }
}
```

### 3. 运行网关

* **Windows 前台运行**：
  双击运行 `start.bat` 或在终端执行 `npm start`。
* **Windows 后台无窗口静默运行**（适合开机自启）：
  双击运行 `start-daemon.vbs`。
* **Windows 停止网关**：
  双击运行 `stop.bat`。
* **Linux / macOS 运行与停止**：
  `./start.sh` 与 `./stop.sh`。

访问 `http://127.0.0.1:3300/` 打开**网页控制台**，可实时监控各服务状态、手动唤醒/休眠，并在线编辑配置（保存即热应用）。

---

## 🤖 AI 客户端配置指引 (Client Integration)

### 1. Hermes Agent (`config.yaml`)

推荐直接挂载统一聚合端点，一次性接入全量工具：

```yaml
mcp_servers:
  aggregator:
    enabled: true
    transport: sse
    url: http://127.0.0.1:3300/sse
```

*(如需单独调用分立服务，可配置 URL 为 `http://127.0.0.1:3300/ms365/sse`，详见下文第 4 节)*

### 2. Claude CLI / Claude Desktop (`claude_desktop_config.json` 或 `.claude.json`)

```json
{
  "mcpServers": {
    "aggregator": {
      "type": "sse",
      "url": "http://127.0.0.1:3300/sse"
    }
  }
}
```

### 3. AstrBot / Cursor / 其他 MCP 客户端

添加类型为 **SSE** 的 MCP Server，填入地址：
```text
http://127.0.0.1:3300/sse
```

### 4. 单独接入某个分立服务 (Per-Service Endpoint)

如果不希望某个客户端接入全量工具，网关为每个后端服务都保留了分立端点 `http://127.0.0.1:3300/:service/sse`，无需改动任何代码，直接将客户端的 URL 指向对应服务即可。例如只接入 ms365：

```json
{
  "mcpServers": {
    "ms365": {
      "type": "sse",
      "url": "http://127.0.0.1:3300/ms365/sse"
    }
  }
}
```

分立端点与统一聚合端点共享同一套 Scale-to-Zero 机制：

- 客户端只会枚举到该服务自身的工具，互不干扰；
- `tools/list` 依然命中本地 Schema 缓存（< 1ms），调用时按需唤醒；
- 多个客户端分别连接不同端点时，共享同一个后端单例进程，不会重复拉起。

#### 进阶：将某个服务从统一聚合端点中摘除

若希望某个服务仅供专用客户端调用、不出现在统一端点的工具列表中，可在 `config.json` 中为该服务添加 `"enabled": false`：

```json
"brave-search": {
  "package": "@brave/brave-search-mcp-server",
  "enabled": false,
  "args": [],
  "env": {
    "BRAVE_API_KEY": "${BRAVE_API_KEY}"
  },
  "idleTimeoutMinutes": 15
}
```

被摘除的服务将从统一端点 `http://127.0.0.1:3300/sse` 的 `tools/list` 与工具路由中隐藏，但其分立端点 `http://127.0.0.1:3300/brave-search/sse` 仍然可用，适合「部分工具仅授权给指定 Agent」的场景。

> **提示**：统一端点按「工具名」在所有已启用的服务间智能路由，若多个服务存在同名工具，将命中配置顺序靠前的服务；分立端点则只暴露各自的工具，不存在歧义。

---

## 📊 网页控制台与管理 API

浏览器访问 `http://127.0.0.1:3300/` 打开网页控制台：

- **监控**：网关内存/运行时长/工具总数，每个服务的状态徽章（休眠/安装中/启动中/运行中）、工具数、空闲回收倒计时、累计调用与唤醒、错误信息；
- **操作**：对任意服务「立即唤醒」「立即休眠」「编辑」「删除」；
- **配置（两条路径）**：
  - **表单模式**：选择服务类型（npm 包 / 命令 / 远程 HTTP）后按提示填空，「添加并热应用」；配置错了点服务卡上的「编辑」，表单自动回填该服务当前配置，改完保存即热应用；
  - **JSON 模式**：直接在线编辑 `config.json` 全文（JSON 校验 → 写盘前自动备份 `.bak` → **热应用**，服务增删改即时生效；修改 `port` 会提示需重启）。

脚本化监控可使用 JSON 接口 `GET /api/status`（控制台的数据源）：

```json
{
  "status": "ok",
  "gateway": { "memoryRSS_MB": "52.4", "totalAggregatedTools": 50, "...": "..." },
  "services": {
    "ms365": {
      "status": "sleeping",
      "mode": "npm",
      "enabled": true,
      "idleTimeoutMinutes": 60,
      "remainingIdleSeconds": null,
      "toolsCount": 42,
      "stats": { "totalCalls": 4, "wakeups": 1 },
      "error": null,
      "sseUrl": "http://127.0.0.1:3300/ms365/sse",
      "remoteUrl": null
    }
  }
}
```

管理 API 一览（`/api/*` 带同源防护，跨域网页访问返回 403）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/status` | 网关与服务实时状态（JSON） |
| GET | `/api/config` | 读取当前配置原文 |
| POST | `/api/config` | 校验并保存配置，热应用（自动 `.bak` 备份） |
| POST | `/api/services/:key/wake` | 立即唤醒/重连指定服务 |
| POST | `/api/services/:key/sleep` | 立即休眠指定服务（进程销毁/断连） |

---

## 🛠️ 扩展新服务 (Extending Backends)

### 方式一：npm 包模式（推荐）

只需声明包名，网关在启动时会自动补装缺失的依赖（`npm install --no-save`），并从包的 `bin` / `main` 字段解析真实入口，以 node 直连方式拉起常驻进程：

```json
"my-npm-service": {
  "package": "@scope/some-mcp-server",
  "args": ["--some-flag"],
  "env": {
    "CUSTOM_ENV": "1"
  },
  "idleTimeoutMinutes": 30
}
```

说明：

- 支持版本锁定：`"package": "@scope/some-mcp-server@1.2.3"`；
- 若包存在多个 `bin` 入口，需通过 `"binName": "xxx"` 显式指定；
- 自动安装为一次性短命令（默认超时 300 秒，可通过 `"installTimeoutMs"` 调整），常驻服务进程依然不走 `npx` / `cmd.exe` 垫片；
- 依赖包缺失导致安装失败时，该服务会在仪表盘标记 `error`，不影响网关与其他服务的运行；
- 可通过 `"nodeArgs"` 向 Node 运行时传递开关（如 `"--require"` 预加载脚本），`./` 开头的路径会解析为项目根目录下的绝对路径。项目自带的 `proxy-bootstrap.cjs` 即通过该机制挂载：它让 Node 24 以下版本的原生 fetch 遵循 `HTTP(S)_PROXY` 环境变量（Node 24+ 可直接使用 `NODE_USE_ENV_PROXY=1`，无需此脚本），供需要代理出站的 npm 服务使用。

### 方式二：显式命令模式（Python / 本地二进制等任意运行时）

```json
"my-python-service": {
  "command": "uv",
  "args": ["run", "my_mcp_server.py"],
  "env": {
    "CUSTOM_ENV": "1"
  },
  "idleTimeoutMinutes": 30
}
```

两种模式均支持环境变量插值（`${ENV_VAR}`）；`args` 中以 `./` 开头的路径会自动解析为网关项目根目录下的绝对路径。注意：`args` 中的参数会传给 MCP 服务本身；若需向 Node 运行时传递开关（如 `--require` 预加载脚本），请使用 `"nodeArgs"`。

### 方式三：远程 HTTP MCP（Streamable HTTP / SSE）

聚合一个部署在远端（或本机其他端口）的 HTTP MCP 服务，无需任何本地进程：

```json
"my-remote-service": {
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer ${MCP_TOKEN}"
  },
  "idleTimeoutMinutes": 30
}
```

说明：

- 传输协议自动协商：优先 **Streamable HTTP**，失败自动回退旧式 **SSE**；也可通过 `"transport": "sse" | "http"` 显式指定；
- `headers` 支持环境变量插值（`${VAR}`），用于放置鉴权头等；
- **远程版 Scale-to-Zero**：空闲超时后自动断开连接（不占用对端会话/连接配额），下次调用自动重连；连接意外断开同样会在下次调用时自动恢复；
- 该服务的分立端点 `/:service/sse` 与统一端点路由行为与本地服务完全一致。

### 测试

```bash
node test/e2e.mjs
```

端到端测试会自动启动一个本地 Streamable HTTP 测试服务器与一套隔离的网关实例（独立端口与临时配置文件，不影响正在运行的网关），覆盖：远程聚合、统一端点路由、分立端点、wake/sleep、配置读取/校验/热应用、同源防护与网页控制台。

---

## 📄 License

[MIT License](LICENSE) © 2026 TheMountainTree
