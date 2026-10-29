// 检查 Web 端是否真的把 dsh-fleet 的 client bundle 挂进了页面
const index = await (await fetch('http://127.0.0.1:27380/')).text();
console.log('index bytes', index.length);
const scripts = [...index.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
console.log('scripts:', scripts.slice(0, 12).join(' | '));
const mentions = /dsh-fleet/.test(index);
console.log('index mentions dsh-fleet:', mentions);

// 浏览器里 client 插件通常以 /plugins/<id>/client.js 或 client-modules 清单暴露
const candidates = [
  'http://127.0.0.1:27380/plugins/dsh-fleet/client.js',
  'http://127.0.0.1:27380/client-plugins/dsh-fleet/client.js',
  'http://127.0.0.1:27380/api/client-plugins',
];
for (const url of candidates) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`${url} -> ${res.status} ${res.headers.get('content-type') || ''} ${text.length}B fleet=${text.includes('dsh-fleet')}`);
  } catch (err) {
    console.log(`${url} -> ERR ${err.message}`);
  }
}
