// 端到端测试：验证远程 HTTP 聚合、统一端点路由、管理 API（wake/sleep/config）、网页控制台。
// 运行：node test/e2e.mjs   （使用独立端口 3301 与临时配置文件，不影响正在运行的网关）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GW_PORT = 3301;
const RS_PORT = 3390;
const GW = `http://127.0.0.1:${GW_PORT}`;

let passed = 0, failed = 0;
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? '  [' + extra + ']' : ''}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(400);
  }
  throw new Error(`等待超时: ${label} (${lastErr ? lastErr.message : 'condition not met'})`);
}

const j = (p) => fetch(GW + p).then(r => r.json());

// ── 准备临时配置与子进程 ─────────────────────────────────────────────
const tmpConfigPath = path.join(__dirname, '.tmp-e2e-config.json');
// 防护断言用：测试绝不允许改写项目根目录的真实 config.json
const realConfigPath = path.join(ROOT, 'config.json');
const realConfigBefore = fs.existsSync(realConfigPath)
  ? fs.readFileSync(realConfigPath, 'utf8')
  : null;
fs.writeFileSync(tmpConfigPath, JSON.stringify({
  port: GW_PORT,
  defaultIdleTimeoutMinutes: 60,
  services: {
    'test-remote': {
      url: `http://127.0.0.1:${RS_PORT}/mcp`,
      idleTimeoutMinutes: 5
    }
  }
}, null, 2));

const remoteServer = spawn(process.execPath, [path.join(__dirname, 'remote-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
const gateway = spawn(process.execPath, [path.join(ROOT, 'gateway.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GATEWAY_CONFIG: tmpConfigPath }
});
let gwLog = '', rsLog = '';
gateway.stdout.on('data', d => { gwLog += d; });
gateway.stderr.on('data', d => { gwLog += d; });
remoteServer.stdout.on('data', d => { rsLog += d; });
remoteServer.stderr.on('data', d => { rsLog += d; });

async function cleanup() {
  for (const c of [gateway, remoteServer]) {
    try { c.kill(); } catch (e) { /* 忽略 */ }
  }
  await sleep(300);
  try { fs.unlinkSync(tmpConfigPath); } catch (e) { /* 忽略 */ }
}

try {
  console.log('=== 1. 启动：远程测试服务器 + 网关（临时配置，端口 3301） ===');
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${RS_PORT}/health`)).ok; } catch { return false; }
  }, 15000, '远程测试服务器就绪');

  const status0 = await waitFor(async () => {
    const d = await j('/api/status');
    if (d.status !== 'ok') return null;
    return d.services['test-remote']?.toolsCount >= 1 ? d : null;
  }, 30000, '网关启动并完成远程服务预热');

  ok(true, '网关 /api/status 正常，test-remote 预热完成');
  ok(status0.services['test-remote'].mode === 'remote', 'mode 识别为 remote', 'got: ' + status0.services['test-remote'].mode);
  ok(status0.services['test-remote'].toolsCount === 1, '远程工具已缓存 (toolsCount=1)');
  ok(status0.services['test-remote'].status === 'sleeping', '预热后回到休眠（远程版 Scale-to-Zero）');
  ok(gwLog.includes('Streamable HTTP 连接'), '使用 Streamable HTTP 传输连接成功');

  console.log('=== 2. 统一聚合端点：tools/list 与 tools/call 智能路由到远程服务 ===');
  {
    const transport = new SSEClientTransport(new URL(GW + '/sse'));
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    ok(listed.tools.some(t => t.name === 'echo_test'), '统一端点 tools/list 包含远程工具 echo_test');
    const res = await client.callTool({ name: 'echo_test', arguments: { text: '你好聚合网关' } });
    const text = (res.content || []).map(c => c.text || '').join('');
    ok(text.includes('echo: 你好聚合网关'), '统一端点 tools/call 路由到远程并返回结果', 'got: ' + text);
    await client.close();
  }

  console.log('=== 3. 分立端点：/:service/sse 对远程服务同样可用 ===');
  {
    const transport = new SSEClientTransport(new URL(GW + '/test-remote/sse'));
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    ok(listed.tools.length === 1 && listed.tools[0].name === 'echo_test', '分立端点 tools/list 正常');
    await client.close();
  }

  console.log('=== 4. 管理 API：wake / sleep ===');
  {
    const wakeRes = await fetch(GW + '/api/services/test-remote/wake', { method: 'POST' });
    ok(wakeRes.ok, 'POST wake 返回 200');
    await waitFor(async () => (await j('/api/status')).services['test-remote'].status === 'running', 10000, '服务进入 running');
    ok(true, 'wake 后状态为 running');
    const sleepRes = await fetch(GW + '/api/services/test-remote/sleep', { method: 'POST' });
    ok(sleepRes.ok, 'POST sleep 返回 200');
    const s2 = await j('/api/status');
    ok(s2.services['test-remote'].status === 'sleeping', 'sleep 后状态为 sleeping');
    const nf = await fetch(GW + '/api/services/no-such/wake', { method: 'POST' });
    ok(nf.status === 404, '未知服务 wake 返回 404');
  }

  console.log('=== 5. 管理 API：config 读取 / 校验 / 热应用 ===');
  {
    const cfgText = await fetch(GW + '/api/config').then(r => r.text());
    const cfg = JSON.parse(cfgText);
    ok(cfg.services['test-remote']?.url === `http://127.0.0.1:${RS_PORT}/mcp`, 'GET /api/config 返回当前配置');

    const bad = await fetch(GW + '/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services: { broken: { idleTimeoutMinutes: 5 } } })
    });
    ok(bad.status === 400, '缺少 command/package/url 的服务被拒绝 (400)');

    cfg.services['dummy-disabled'] = { enabled: false, package: 'mineru-mcp', binName: 'mineru-mcp' };
    const good = await fetch(GW + '/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    }).then(r => r.json());
    ok(good.ok === true && good.portChanged === false, '合法配置保存并热应用');
    const s3 = await j('/api/status');
    ok(!!s3.services['dummy-disabled'], '热应用后新服务出现在状态中（enabled=false 不预热不安装）');
    ok(s3.services['dummy-disabled'].toolsCount === 0, '禁用服务不触发安装与探测');
    ok(fs.existsSync(tmpConfigPath + '.bak'), '写盘前生成 .bak 备份');
  }

  console.log('=== 6. 同源防护：跨域 Origin 访问 /api 被拒 ===');
  {
    const evil = await fetch(GW + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ services: {} })
    });
    ok(evil.status === 403, '恶意 Origin 的 POST /api/config 返回 403');
    const evilGet = await fetch(GW + '/api/config', { headers: { Origin: 'http://evil.example' } });
    ok(evilGet.status === 403, '恶意 Origin 的 GET /api/config 返回 403');
    const sameOrigin = await fetch(GW + '/api/config', { headers: { Origin: GW } });
    ok(sameOrigin.ok, '同源 Origin 放行');
  }

  console.log('=== 7. 网页控制台 ===');
  {
    const html = await fetch(GW + '/').then(r => r.text());
    ok(html.includes('MCP-Aggregator 控制台'), 'GET / 返回控制台 HTML');
    ok(html.includes('/api/status') && html.includes('保存并热应用'), '页面包含监控与配置编辑器逻辑');
  }

  console.log('=== 8. 隔离性：真实 config.json 未被测试改写 ===');
  {
    const realNow = fs.existsSync(realConfigPath) ? fs.readFileSync(realConfigPath, 'utf8') : null;
    ok(realNow === realConfigBefore, 'GATEWAY_CONFIG 隔离生效，热保存未触碰真实 config.json');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
} catch (err) {
  failed++;
  console.error('\nE2E 异常终止:', err.message);
  console.error('--- gateway log ---\n' + gwLog.slice(-3000));
  console.error('--- remote server log ---\n' + rsLog.slice(-1000));
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
