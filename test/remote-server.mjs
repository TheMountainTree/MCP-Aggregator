// 测试用途：一个最小化的 Streamable HTTP (无状态) MCP 服务器，暴露 echo_test 工具。
// 供 test/e2e.mjs 验证网关的远程 HTTP 聚合能力。
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.PORT || 3390);

function createServer() {
  const server = new Server(
    { name: 'remote-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'echo_test',
      description: '回显输入文本，用于连通性测试',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text']
      }
    }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: 'echo: ' + (req.params.arguments?.text ?? '') }]
  }));
  return server;
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// 无状态模式：每个 POST 请求独立创建 transport 与 server
const handle = async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[remote-test-server] 请求处理失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};
app.post('/mcp', handle);
app.get('/mcp', async (req, res) => res.status(405).json({ error: 'stateless: POST only' }));
app.delete('/mcp', async (req, res) => res.status(405).json({ error: 'stateless: POST only' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[remote-test-server] listening on http://127.0.0.1:${PORT}/mcp`);
});
