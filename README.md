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
   - 自动聚合所有挂载服务的工具定义，智能根据工具名称完成 O(1) 请求路由与转发。
   - 保持向后兼容：依然保留分立端点 `http://127.0.0.1:3300/:service/sse` 供独立调用。

2. **真·按需秒级拉起 + 冷态归零 (Scale-to-Zero)**：
   - **冷态 0 MB**：闲时所有后台服务子进程（MS365、Brave 等）**完全不运行**，物理内存占用为 0。
   - **秒级拉起**：当任何 Agent 触发对应工具调用时，网关瞬间唤醒单例进程处理。
   - **空闲回收**：支持自定义超时倒计时（默认 60 分钟），无请求自动杀掉子进程，释放系统资源。

3. **Schema 毫秒级极速响应 (Zero-Delay Cache)**：
   - Agent 连接与工具枚举（`tools/list`）直接命中本地静态 JSON 缓存，响应时间 `< 1ms`，**无需提前唤醒后台重量级进程**。
   - 唤醒时后台异步静默刷新缓存，彻底消灭唤醒过程中的阻塞时延。

4. **架构脱壳，杜绝僵尸进程 (No Zombie Processes on Windows)**：
   - 抛弃 `npx` / `cmd.exe` 套娃包裹，使用原生 Node 进程树直接托管，退出即彻底销毁，绝不产生悬空孤儿进程。

5. **插件化自由装载 (Pluggable Backends)**：
   - 支持通过声明式配置载入任意运行时：Node.js、Python (`uv run`)、本地可执行二进制，支持环境变量动态插值（`${ENV_VAR}`）。

---

## 🏗️ 架构示意 (Architecture)

```text
[ Hermes / Claude CLI / AstrBot / Cursor / Continue ]
                       │
                       │ 统一单入口: GET /sse  &  POST /message
                       ▼
┌────────────────────────────────────────────────────────┐
│            MCP-Aggregator Gateway (Express)            │
│  ├─ 仪表盘 / 监控: GET /                               │
│  ├─ 统一聚合端点: GET /sse                             │
│  ├─ 分立兼容端点: GET /:service/sse                    │
│  ├─ Schema 缓存层: cache/<service>-tools.json (<1ms)   │
│  └─ Scale-to-Zero 状态机 (sleeping / starting / warm)  │
└───────────────────────┬────────────────────────────────┘
                        │ 按需拉起（脱壳直连）
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐┌──────────────┐┌──────────────┐
│  Node: ms365 ││ Node: brave  ││ Python / CLI │
│  (0MB 或热态)││ (0MB 或热态) ││ (扩展服务)   │
└──────────────┘└──────────────┘└──────────────┘
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

根据您的需求修改 `config.json`（支持环境变量动态插值 `${VAR_NAME}`）：

```json
{
  "port": 3300,
  "defaultIdleTimeoutMinutes": 60,
  "services": {
    "ms365": {
      "name": "ms365",
      "command": "node",
      "args": [
        "./node_modules/@softeria/ms-365-mcp-server/dist/index.js",
        "--preset",
        "calendar"
      ],
      "env": {},
      "idleTimeoutMinutes": 60
    },
    "brave-search": {
      "name": "brave-search",
      "command": "node",
      "args": [
        "--use-env-proxy",
        "./node_modules/@brave/brave-search-mcp-server/dist/index.js"
      ],
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

访问 `http://127.0.0.1:3300/` 可实时查看网关健康状态、内存用量、工具数量与休眠倒计时。

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

*(如需单独调用分立服务，可配置 URL 为 `http://127.0.0.1:3300/ms365/sse`)*

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

---

## 📊 仪表盘与监控 API

浏览器或 curl 直接访问 `http://127.0.0.1:3300/`，返回实时状态：

```json
{
  "status": "ok",
  "gateway": {
    "name": "MCP-Aggregator",
    "version": "1.0.0",
    "uptimeSeconds": 128,
    "memoryRSS_MB": "52.4",
    "memoryHeapUsed_MB": "24.6",
    "totalAggregatedTools": 50
  },
  "endpoints": {
    "unified_sse": "http://127.0.0.1:3300/sse",
    "unified_message": "http://127.0.0.1:3300/message"
  },
  "services": {
    "ms365": {
      "status": "sleeping",
      "idleTimeoutMinutes": 60,
      "remainingIdleSeconds": null,
      "toolsCount": 42,
      "stats": { "totalCalls": 4, "wakeups": 1 },
      "sseUrl": "http://127.0.0.1:3300/ms365/sse"
    }
  }
}
```

---

## 🛠️ 扩展新服务 (Extending Backends)

支持通过简单的 JSON 声明挂载任意新服务。例如挂载一个 Python 编写的 MCP 服务：

```json
"my-python-service": {
  "name": "my-python-service",
  "command": "uv",
  "args": ["run", "my_mcp_server.py"],
  "env": {
    "CUSTOM_ENV": "1"
  },
  "idleTimeoutMinutes": 30
}
```

---

## 📄 License

[MIT License](LICENSE) © 2026 TheMountainTree
