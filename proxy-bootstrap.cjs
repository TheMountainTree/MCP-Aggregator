// 让 Node < 24 的原生 fetch 遵循 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量。
// Node 24 起已内置该能力（NODE_USE_ENV_PROXY），届时可移除此文件与相关 nodeArgs。
// 用法：node --require ./proxy-bootstrap.cjs <入口>
try {
  const undici = require('undici');
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  // Node 内置 fetch 不受 npm undici 的全局 dispatcher 影响（两套独立实例），
  // 因此需整体替换全局 fetch 及配套类，保证 instanceof 判断一致。
  globalThis.fetch = undici.fetch;
  globalThis.Headers = undici.Headers;
  globalThis.Request = undici.Request;
  globalThis.Response = undici.Response;
  globalThis.FormData = undici.FormData;
} catch (err) {
  console.error('[proxy-bootstrap] 启用环境变量代理失败:', err.message);
}
