import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 读取配置文件 (支持 config.json / config.example.json 回退与环境变量插值)
function resolveEnvString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
}

function resolveEnvMap(envObj) {
  if (!envObj) return {};
  const res = {};
  for (const [k, v] of Object.entries(envObj)) {
    res[k] = resolveEnvString(v);
  }
  return res;
}

// ── npm 包自动安装与入口解析 ──────────────────────────────────────────────
// 服务配置中声明 "package": "name[@version]" 即可，网关在启动时自动补装缺失
// 依赖，并从包的 bin / main 字段解析真实入口。常驻进程仍以 node 直连入口
// 文件的方式拉起，不走 npx / cmd.exe 垫片（防僵尸进程承诺不变）。

// 解析 npm 包 spec："@scope/name@1.2.3" / "@scope/name" / "name@1.2.3" / "name"
function parsePackageSpec(spec) {
  const s = String(spec).trim();
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash === -1) throw new Error(`无效的 npm 包名: ${s}`);
    const at = s.indexOf('@', slash + 1);
    return at === -1
      ? { name: s, version: '' }
      : { name: s.slice(0, at), version: s.slice(at + 1) };
  }
  const at = s.indexOf('@', 1);
  return at === -1
    ? { name: s, version: '' }
    : { name: s.slice(0, at), version: s.slice(at + 1) };
}

// 定位随 Node 一起安装的 npm-cli.js（避免经 cmd.exe 调用 npm 垫片）
function getNpmCliPath() {
  const candidate = path.join(
    path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'
  );
  return fs.existsSync(candidate) ? candidate : null;
}

// 一次性执行 npm install（短命令、同步等待结束，不产生常驻进程）
function runNpmInstall(spec, timeoutMs) {
  return new Promise((resolve, reject) => {
    const npmCli = getNpmCliPath();
    const child = npmCli
      ? spawn(
          process.execPath,
          [npmCli, 'install', spec, '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error'],
          { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] }
        )
      : spawn(
          `npm install ${spec} --no-save --no-audit --no-fund --loglevel error`,
          { cwd: __dirname, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );

    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`npm install ${spec} 超时（${Math.round(timeoutMs / 1000)}s），请检查网络或调大 installTimeoutMs`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install ${spec} 失败 (exit ${code}):\n${output.slice(-2000)}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`npm install ${spec} 启动失败: ${err.message}`));
    });
  });
}

// 从已安装包的 package.json 中解析可执行入口的绝对路径
function resolvePackageEntry(packageName, binName) {
  const pkgDir = path.join(__dirname, 'node_modules', ...packageName.split('/'));
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`包 ${packageName} 未安装（未找到 ${pkgJsonPath}）`);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  let relEntry = null;
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      relEntry = pkg.bin;
    } else if (binName) {
      if (!pkg.bin[binName]) {
        throw new Error(`包 ${packageName} 不存在 bin 入口 "${binName}"，可用: ${Object.keys(pkg.bin).join(', ')}`);
      }
      relEntry = pkg.bin[binName];
    } else {
      const keys = Object.keys(pkg.bin);
      if (keys.length === 1) {
        relEntry = pkg.bin[keys[0]];
      } else {
        throw new Error(`包 ${packageName} 存在多个 bin 入口 (${keys.join(', ')})，请在服务配置中通过 "binName" 显式指定`);
      }
    }
  }
  if (!relEntry && pkg.main) relEntry = pkg.main;
  if (!relEntry) {
    throw new Error(`无法解析包 ${packageName} 的入口文件（package.json 中无 bin / main 字段）`);
  }

  let entryPath = path.resolve(pkgDir, relEntry);
  if (!fs.existsSync(entryPath) && fs.existsSync(`${entryPath}.js`)) entryPath += '.js';
  if (!fs.existsSync(entryPath)) {
    throw new Error(`包 ${packageName} 解析出的入口文件不存在: ${entryPath}`);
  }
  return entryPath;
}

let configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  const examplePath = path.join(__dirname, 'config.example.json');
  if (fs.existsSync(examplePath)) {
    console.warn('[Gateway] 未找到 config.json，已使用 config.example.json 作为默认模板');
    configPath = examplePath;
  } else {
    console.error('[Gateway] 未找到配置文件 config.json 或 config.example.json!');
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const PORT = config.port || 3300;
const DEFAULT_IDLE_MINUTES = config.defaultIdleTimeoutMinutes || 60;

// 确保缓存目录存在
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// 2. 后端服务状态管理器
class BackendManager {
  constructor(serviceKey, serviceConfig) {
    this.key = serviceKey;
    this.config = serviceConfig;
    this.idleMinutes = serviceConfig.idleTimeoutMinutes || DEFAULT_IDLE_MINUTES;
    this.status = 'sleeping'; // sleeping | installing | starting | running
    this.client = null;
    this.transport = null;
    this.idleTimer = null;
    this.lastActiveTime = null;
    this.startPromise = null;
    this.lastError = null;
    this.resolvedCommand = null; // ensureEntry() 之后的实际启动命令
    this.resolvedArgs = null;    // ensureEntry() 之后的实际启动参数
    this.cachedTools = this.loadToolsCache();
    this.stats = { totalCalls: 0, wakeups: 0 };
  }

  getCacheFilePath() {
    return path.join(cacheDir, `${this.key}-tools.json`);
  }

  loadToolsCache() {
    const file = this.getCacheFilePath();
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        console.warn(`[Gateway] 解析缓存 ${file} 失败:`, e.message);
      }
    }
    return null;
  }

  saveToolsCache(tools) {
    this.cachedTools = tools;
    fs.writeFileSync(this.getCacheFilePath(), JSON.stringify(tools, null, 2), 'utf8');
  }

  // 预热/刷新工具 Schema 缓存（若不存在，临时启动一下采集后立即归零）
  async warmCacheIfNeeded() {
    if (this.cachedTools && this.cachedTools.length > 0) {
      console.log(`[Gateway] 服务 [${this.key}] 工具缓存就绪 (${this.cachedTools.length} tools)`);
      return;
    }
    console.log(`[Gateway] 服务 [${this.key}] 未发现工具缓存，首次初始化探测...`);
    const client = await this.getOrStart();
    console.log(`[Gateway] 服务 [${this.key}] 首次探测完成，正在写入缓存...`);
    // 探测完后立即释放，保持冷态 0 占用
    await this.stop();
  }

  // 解析实际启动命令与参数：传统 command/args 模式 或 npm 包自动安装模式。
  // 结果缓存于 resolvedCommand / resolvedArgs，重复调用为幂等快速返回。
  async ensureEntry() {
    if (this.resolvedCommand) return;

    const resolveArg = (arg) => {
      if (arg.startsWith('./') || arg.startsWith('.\\')) {
        return path.resolve(__dirname, arg);
      }
      return resolveEnvString(arg);
    };
    const args = this.config.args || [];

    if (this.config.command) {
      if (this.config.package) {
        console.warn(`[Gateway] 服务 [${this.key}] 同时配置了 "command" 与 "package"，已优先采用 "command"`);
      }
      this.resolvedCommand = this.config.command === 'node' ? process.execPath : this.config.command;
      this.resolvedArgs = args.map(resolveArg);
      return;
    }

    if (!this.config.package) {
      throw new Error(`服务 [${this.key}] 缺少 "command" 或 "package" 配置，无法确定启动方式`);
    }

    const { name, version } = parsePackageSpec(this.config.package);
    const pkgDir = path.join(__dirname, 'node_modules', ...name.split('/'));

    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
      const spec = version ? `${name}@${version}` : name;
      console.log(`[Gateway] 服务 [${this.key}] 依赖包 ${spec} 尚未安装，正在自动执行 npm install ...`);
      this.status = 'installing';
      await runNpmInstall(spec, this.config.installTimeoutMs || 300000);
      console.log(`[Gateway] 服务 [${this.key}] 依赖包 ${spec} 安装完成`);
    }

    const entryPath = resolvePackageEntry(name, this.config.binName);
    this.resolvedCommand = process.execPath;
    this.resolvedArgs = [entryPath, ...args.map(resolveArg)];
  }

  // 获取正在运行的 client，若未运行则秒级唤醒
  async getOrStart() {
    if (this.client && this.status === 'running') {
      this.touch();
      return this.client;
    }

    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      this.status = 'starting';
      const startTime = Date.now();
      console.log(`[Gateway] 唤醒服务进程 [${this.key}]...`);

      try {
        await this.ensureEntry();
      } catch (err) {
        this.status = 'sleeping';
        this.lastError = err.message;
        throw err;
      }
      const command = this.resolvedCommand;
      const resolvedArgs = this.resolvedArgs;

      const env = {
        ...process.env,
        ...resolveEnvMap(this.config.env || {})
      };

      this.transport = new StdioClientTransport({
        command: command,
        args: resolvedArgs,
        env: env
      });

      this.client = new Client(
        { name: `gateway-${this.key}`, version: '1.0.0' },
        { capabilities: {} }
      );

      try {
        await this.client.connect(this.transport);
        this.status = 'running';
        this.lastError = null;
        this.stats.wakeups++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Gateway] 服务 [${this.key}] 唤醒成功 (耗时 ${elapsed}s)`);

        // 优化唤醒耗时：若已有缓存，不阻塞当前请求，后台静默刷新缓存
        if (!this.cachedTools || this.cachedTools.length === 0) {
          const toolsResult = await this.client.listTools();
          if (toolsResult && toolsResult.tools) {
            this.saveToolsCache(toolsResult.tools);
          }
        } else {
          this.client.listTools().then((toolsResult) => {
            if (toolsResult && toolsResult.tools) {
              this.saveToolsCache(toolsResult.tools);
            }
          }).catch((err) => {
            console.warn(`[Gateway] 后台异步刷新 [${this.key}] 工具缓存异常:`, err.message);
          });
        }

        this.touch();
        return this.client;
      } catch (err) {
        this.status = 'sleeping';
        this.lastError = err.message;
        this.client = null;
        this.transport = null;
        console.error(`[Gateway] 唤醒服务 [${this.key}] 失败:`, err);
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return await this.startPromise;
  }

  // 触摸保活：重置空闲倒计时
  touch() {
    this.lastActiveTime = Date.now();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    const timeoutMs = this.idleMinutes * 60 * 1000;
    this.idleTimer = setTimeout(async () => {
      console.log(`[Gateway] 服务 [${this.key}] 已连续空闲 ${this.idleMinutes} 分钟，执行自动卸载 (Scale-to-Zero)...`);
      await this.stop();
    }, timeoutMs);
  }

  // 终止子进程，内存归零
  async stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch (e) {
        console.warn(`[Gateway] 关闭 [${this.key}] 客户端异常:`, e.message);
      }
      this.client = null;
      this.transport = null;
    }
    this.status = 'sleeping';
    console.log(`[Gateway] 服务 [${this.key}] 已完全休眠，子进程已销毁，内存已归零释放。`);
  }
}

// 3. 初始化所有服务
const backends = new Map();
for (const [key, svcConfig] of Object.entries(config.services)) {
  backends.set(key, new BackendManager(key, svcConfig));
}

// 辅助方法：按工具名动态路由到对应的 Backend
function findBackendForTool(toolName) {
  for (const backend of backends.values()) {
    if (backend.config.enabled === false) continue;
    const hasTool = (backend.cachedTools || []).some(t => t.name === toolName);
    if (hasTool) {
      return backend;
    }
  }
  return null;
}

// 4. 构建 Express 服务
const app = express();
app.use(cors());

// 保存活跃的 SSE transports: sessionId -> SSEServerTransport
const transports = new Map();

// 仪表盘 / 健康检查状态接口
app.get('/', (req, res) => {
  const mem = process.memoryUsage();
  const servicesStatus = {};
  let totalTools = 0;

  for (const [key, backend] of backends.entries()) {
    let remainingIdleSec = 0;
    if (backend.status === 'running' && backend.lastActiveTime) {
      const elapsed = Math.floor((Date.now() - backend.lastActiveTime) / 1000);
      remainingIdleSec = Math.max(0, backend.idleMinutes * 60 - elapsed);
    }
    const tCount = (backend.cachedTools || []).length;
    totalTools += tCount;

    servicesStatus[key] = {
      status: backend.status,
      idleTimeoutMinutes: backend.idleMinutes,
      remainingIdleSeconds: backend.status === 'running' ? remainingIdleSec : null,
      toolsCount: tCount,
      stats: backend.stats,
      error: backend.lastError || null,
      sseUrl: `http://127.0.0.1:${PORT}/${key}/sse`
    };
  }

  res.json({
    status: 'ok',
    gateway: {
      name: 'MCP-Aggregator',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRSS_MB: (mem.rss / 1024 / 1024).toFixed(1),
      memoryHeapUsed_MB: (mem.heapUsed / 1024 / 1024).toFixed(1),
      totalAggregatedTools: totalTools
    },
    endpoints: {
      unified_sse: `http://127.0.0.1:${PORT}/sse`,
      unified_message: `http://127.0.0.1:${PORT}/message`
    },
    services: servicesStatus
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A. 统一聚合 SSE 端点：GET /sse (所有 Agent 统一连接该端点即可使用全量工具)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/sse', async (req, res) => {
  const endpointPath = '/message';
  const transport = new SSEServerTransport(endpointPath, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  const server = new Server(
    { name: 'mcp-aggregator', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );

  // 1. tools/list: 聚合所有子服务的 Schema 缓存，毫秒级响应
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = [];
    for (const backend of backends.values()) {
      if (backend.config.enabled === false) continue;
      if (backend.cachedTools && backend.cachedTools.length > 0) {
        allTools.push(...backend.cachedTools);
      } else {
        const client = await backend.getOrStart();
        const result = await client.listTools();
        backend.saveToolsCache(result.tools);
        allTools.push(...result.tools);
      }
    }
    return { tools: allTools };
  });

  // 2. tools/call: 智能动态路由到提供该工具的目标后台进程
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const targetBackend = findBackendForTool(toolName);

    if (!targetBackend) {
      throw new Error(`未找到提供工具 [${toolName}] 的后台服务，请检查配置或服务是否已就绪。`);
    }

    targetBackend.stats.totalCalls++;
    targetBackend.touch();
    const client = await targetBackend.getOrStart();
    try {
      const result = await client.callTool(request.params);
      targetBackend.touch();
      return result;
    } catch (err) {
      targetBackend.touch();
      console.error(`[Gateway] 调用 [${targetBackend.key}] 工具 [${toolName}] 失败:`, err.message);
      throw err;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  req.on('close', () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
  console.log(`[Gateway] 客户端已连接到统一聚合网关 (Session: ${sessionId})`);
});

// ══════════════════════════════════════════════════════════════════════════════
// B. 向后兼容的独立服务 SSE 端点：GET /:service/sse
// ══════════════════════════════════════════════════════════════════════════════
app.get('/:service/sse', async (req, res) => {
  const serviceKey = req.params.service;
  const backend = backends.get(serviceKey);

  if (!backend) {
    return res.status(404).send(`Unknown MCP service: ${serviceKey}`);
  }

  const endpointPath = `/${serviceKey}/message`;
  const transport = new SSEServerTransport(endpointPath, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  const server = new Server(
    { name: `gateway-${serviceKey}`, version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );

  // 1. tools/list：优先返回缓存，毫秒级响应，零启动开销！
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (backend.cachedTools && backend.cachedTools.length > 0) {
      return { tools: backend.cachedTools };
    }
    const client = await backend.getOrStart();
    const result = await client.listTools();
    backend.saveToolsCache(result.tools);
    return result;
  });

  // 2. tools/call：按需唤醒 + 转发 + 重置空闲倒计时
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    backend.stats.totalCalls++;
    backend.touch();
    const client = await backend.getOrStart();
    try {
      const result = await client.callTool(request.params);
      backend.touch();
      return result;
    } catch (err) {
      backend.touch();
      console.error(`[Gateway] 调用 [${serviceKey}] 工具 [${request.params.name}] 失败:`, err.message);
      throw err;
    }
  });

  // 空实现的 prompts/resources（防止部分客户端报错）
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  req.on('close', () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
  console.log(`[Gateway] 客户端已连接到 [${serviceKey}] (Session: ${sessionId})`);
});

// ══════════════════════════════════════════════════════════════════════════════
// C. 统一消息路由：支持 POST /message 和 POST /:service/message
// ══════════════════════════════════════════════════════════════════════════════
const handlePostMessage = async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).send('Missing sessionId');
  }
  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(404).send('Session not found or expired');
  }
  await transport.handlePostMessage(req, res);
};

app.post('/message', handlePostMessage);
app.post('/:service/message', handlePostMessage);

// 5. 启动网关
const server = app.listen(PORT, '127.0.0.1', async () => {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  MCP-Aggregator 网关已在 http://127.0.0.1:${PORT} 启动`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  [统一聚合端点] : http://127.0.0.1:${PORT}/sse`);
  console.log('  [分立服务端点] :');
  for (const key of backends.keys()) {
    console.log(`    - ${key.padEnd(14)} : http://127.0.0.1:${PORT}/${key}/sse`);
  }
  console.log('──────────────────────────────────────────────────────────────');
  console.log('正在初始化服务依赖并预热工具 Schema 缓存...');
  for (const backend of backends.values()) {
    if (backend.config.enabled === false) continue;
    try {
      await backend.ensureEntry();
      await backend.warmCacheIfNeeded();
    } catch (err) {
      backend.lastError = err.message;
      console.error(`[Gateway] 服务 [${backend.key}] 初始化失败:`, err.message);
    }
  }
  console.log('所有后端已置入冷态休眠（Scale-to-Zero，物理内存 0 MB）。');
  console.log('等待 Agent 请求唤醒中...');
});

// 优雅关机
const shutdown = async () => {
  console.log('\n[Gateway] 正在关闭网关，清理所有子进程...');
  for (const backend of backends.values()) {
    await backend.stop();
  }
  server.close(() => {
    console.log('[Gateway] 网关已安全停止。');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
