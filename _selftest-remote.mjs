// 端到端：把本机当成「另一台机器」，验证 fleet 的远程代理链路（发现 → 列表 → 投影 → 发消息）。
// 做法：在 127.0.0.2:45941 起一个假对端（机器名 FAKE-BOX），用本机真实 /fleet/v1/* 抓下来的数据回放，
// 然后通过 UI 接口 /fleet/api/peers/add 添加它，检查 overview/sessions/transcript/prompt 全部走远程分支。
import { createServer } from "node:http";

const UI = "http://127.0.0.1:27380/fleet/api";
const FAKE_PORT = 45941;
const FAKE_HOST = "127.0.0.2";

const fail = [];
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => {
  fail.push(msg);
  console.log(`✗ ${msg}`);
};

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON（${res.status}）：${text.slice(0, 120)}`);
  }
};

// 1) 拿本机密钥
const overview0 = await json(await fetch(`${UI}/overview`));
const secret = overview0.secret.value;
console.log(`密钥指纹 ${overview0.secret.fingerprint}（mode=${overview0.secret.mode}）`);

// 2) 从本机真实对端端口抓 fixture
const auth = { authorization: `Bearer ${secret}` };
const realSessions = await json(await fetch(`http://127.0.0.1:45940/fleet/v1/sessions`, { headers: auth }));
const sample = (realSessions.sessions || []).find((item) => item.title && item.sessionId);
if (!sample) throw new Error("本机没有可用的示例会话，无法构造 fixture");
const realTranscript = await json(
  await fetch(`http://127.0.0.1:45940/fleet/v1/transcript?sessionId=${encodeURIComponent(sample.sessionId)}&afterSeq=0`, {
    headers: auth,
  }),
);
console.log(`fixture: ${realSessions.sessions.length} 个会话，示例「${sample.title}」${realTranscript.items.length} 条投影`);

// 3) 假对端：机器名 FAKE-BOX，只认同一个密钥
let recordedPrompt = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const reply = (code, body) => {
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
    res.end(buf);
  };
  if (req.headers.authorization !== `Bearer ${secret}`) return reply(401, { ok: false, error: "nope" });

  if (url.pathname === "/fleet/v1/hello") {
    return reply(200, {
      ok: true,
      app: "dsh-fleet",
      v: 1,
      version: "9.9.9",
      instanceId: "fakebox0001",
      machine: "FAKE-BOX",
      hostname: "FAKE-BOX",
      platform: "win32",
      port: FAKE_PORT,
      account: { signedIn: true, userId: "u-fake", name: "假机器" },
      sessionCount: realSessions.sessions.length,
      runningCount: realSessions.sessions.filter((item) => item.running).length,
      secretMode: "shared",
    });
  }
  if (url.pathname === "/fleet/v1/sessions") return reply(200, realSessions);
  if (url.pathname === "/fleet/v1/transcript") {
    const id = url.searchParams.get("sessionId");
    if (id !== sample.sessionId) return reply(200, { ok: true, machine: "FAKE-BOX", items: [], cursor: 0, reset: true, truncated: false });
    return reply(200, { ...realTranscript, machine: "FAKE-BOX" });
  }
  if (url.pathname === "/fleet/v1/prompt" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    recordedPrompt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return reply(200, { ok: true, machine: "FAKE-BOX", accepted: true, via: "fake-peer" });
  }
  return reply(404, { ok: false, error: "unknown" });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(FAKE_PORT, FAKE_HOST, resolve);
});
console.log(`假对端已监听 ${FAKE_HOST}:${FAKE_PORT}`);

try {
  // 4) 添加机器
  const added = await json(
    await fetch(`${UI}/peers/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: `${FAKE_HOST}:${FAKE_PORT}` }),
    }),
  );
  if (!added.ok) bad(`添加机器失败：${added.error}`);
  else ok(`添加机器 ${added.entry}`);

  const peer = (added.peers || []).find((item) => item.machine === "FAKE-BOX");
  if (!peer) bad("overview 里没出现 FAKE-BOX");
  else if (!peer.reachable) bad(`FAKE-BOX 不可达：${peer.note}`);
  else ok(`发现 FAKE-BOX（online=${peer.online} reachable=${peer.reachable} 会话数=${peer.sessionCount} 运行中=${peer.runningCount}）`);

  if (peer && peer.key) {
    // 5) 远程任务列表
    const list = await json(await fetch(`${UI}/sessions?target=${encodeURIComponent(peer.key)}`));
    if (!list.ok) bad(`远程会话列表失败：${list.error}`);
    else if ((list.sessions || []).length !== realSessions.sessions.length) bad(`远程会话数不对：${(list.sessions || []).length} != ${realSessions.sessions.length}`);
    else ok(`远程任务列表 ${list.sessions.length} 条（machine=${list.machine || peer.machine}）`);

    // 6) 远程投影
    const tr = await json(
      await fetch(`${UI}/transcript?target=${encodeURIComponent(peer.key)}&sessionId=${encodeURIComponent(sample.sessionId)}&afterSeq=0`),
    );
    if (!tr.ok) bad(`远程投影失败：${tr.error}`);
    else if ((tr.items || []).length === 0) bad("远程投影是空的");
    else ok(`远程投影 ${tr.items.length} 条，cursor=${tr.cursor}，title=「${tr.title}」`);

    // 7) 远程发消息
    const send = await json(
      await fetch(`${UI}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: peer.key, sessionId: sample.sessionId, text: "来自另一台机器的问候", mode: "queue" }),
      }),
    );
    if (!send.ok) bad(`远程发消息失败：${send.error}`);
    else if (!recordedPrompt) bad("假对端没收到 prompt 请求");
    else if (recordedPrompt.text !== "来自另一台机器的问候") bad(`对端收到的文本不对：${recordedPrompt.text}`);
    else ok(`远程发消息成功（via=${send.via}，对端收到「${recordedPrompt.text}」）`);

    // 8) 错误密钥的目标应当报中文错
    const badPeer = (added.peers || []).find((item) => item.key === peer.key);
    if (badPeer) console.log(`   （目标键 ${peer.key} / 地址 ${badPeer.matchedHost || "?"}:${badPeer.port}）`);
  }

  // 9) 移除
  const removed = await json(
    await fetch(`${UI}/peers/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: `${FAKE_HOST}:${FAKE_PORT}` }),
    }),
  );
  if (!removed.ok) bad(`移除失败：${removed.error}`);
  else if ((removed.peers || []).some((item) => item.machine === "FAKE-BOX")) bad("移除后仍能看到 FAKE-BOX");
  else ok("移除机器后不再出现在列表里");
} finally {
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.log(fail.length === 0 ? "\n✅ 远程链路全部通过" : `\n❌ ${fail.length} 项失败`);
process.exit(fail.length === 0 ? 0 : 1);
