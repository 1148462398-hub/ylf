// 检查 Web 端是否真的把 dsh-plugin-fleet 的 client bundle 挂进了页面
// DSH 的 web 端口每次启动都可能变，所以先自动探测。
const CANDIDATE_PORTS = [
  Number(process.env.DSH_WEB_PORT) || 0,
  49870,
  27380,
  3000,
  8080,
  5173,
].filter(Boolean);

let BASE = '';
for (const port of CANDIDATE_PORTS) {
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/fleet/api/overview`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      BASE = `http://127.0.0.1:${port}`;
      break;
    }
  } catch {
    /* 这个端口没有 DSH */
  }
}
if (!BASE) {
  console.error('❌ 找不到本机 DSH web 端口（可用 DSH_WEB_PORT 指定）');
  process.exit(1);
}
console.log('本机 Host:', BASE);

const index = await (await fetch(`${BASE}/`)).text();
console.log('index bytes', index.length);
const scripts = [...index.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
console.log('scripts:', scripts.slice(0, 12).join(' | '));
console.log('index mentions dsh-plugin-fleet:', /dsh-plugin-fleet/.test(index));

// 浏览器里 client 插件通常以 /plugins/<id>/client.js 或 client-modules 清单暴露
const candidates = [
  `${BASE}/plugins/dsh-plugin-fleet/client.js`,
  `${BASE}/client-plugins/dsh-plugin-fleet/client.js`,
  `${BASE}/api/client-plugins`,
];
for (const url of candidates) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`${url} -> ${res.status} ${res.headers.get('content-type') || ''} ${text.length}B fleet=${text.includes('dsh-plugin-fleet')}`);
  } catch (err) {
    console.log(`${url} -> ERR ${err.message}`);
  }
}
