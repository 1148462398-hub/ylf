// 端到端：验证「同账号零配置」和「手工共享密钥」两条配对路径能同时生效。
//
// 场景模拟的是最容易踩的坑：本机因为以前点过「随机生成」，当前主密钥是 shared；
// 另一台同账号的机器从没填过共享密钥，只认账号派生的那一把。
// 修复前本机只会拿 shared 去敲门 → 对端 401 → 面板上永远显示「共享密钥不一致」。
// 修复后本机手上有多把候选密钥，任意一把能对上就算配对成功。
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATE_PORTS = [Number(process.env.DSH_WEB_PORT) || 0, 49870, 27380, 3000, 8080, 5173].filter(Boolean);

const fail = [];
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => {
  fail.push(msg);
  console.log(`✗ ${msg}`);
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let UI = "";
for (const port of CANDIDATE_PORTS) {
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/fleet/api/overview`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      UI = `http://127.0.0.1:${port}/fleet/api`;
      break;
    }
  } catch {
    /* 跳过 */
  }
}
if (!UI) {
  console.error("❌ 找不到本机 DSH web 端口（可用 DSH_WEB_PORT 指定）");
  process.exit(1);
}
console.log(`本机 Host: ${UI}`);

const debug = await (await fetch(`${UI}/debug`)).json();
if (!Array.isArray(debug.secrets)) {
  console.error("❌ /fleet/api/debug 没有 secrets 字段——插件版本太旧，先重装到 1.1.0");
  process.exit(1);
}
console.log(`本机认可 ${debug.secrets.length} 把钥匙：${debug.secrets.map((s) => `${s.mode}/${s.fingerprint}`).join("  ")}`);

const accountSecret = debug.secrets.find((item) => item.mode === "account");
if (!accountSecret) {
  console.error("❌ 本机没有账号派生密钥，无法测试同账号场景");
  process.exit(1);
}

// 测试脚本自己也走一遍同样推导，避免依赖内部实现。
// 注意指纹口径：插件报的 fingerprint = sha256(密钥).slice(0,8)，不是密钥明文的前 8 位。
const derived = sha256(`dsh-plugin-fleet/v1/${debug.account.userId}`);
const derivedFp = sha256(derived).slice(0, 8);
if (derivedFp !== accountSecret.fingerprint) {
  bad(`账号派生推导不一致：本地算出 ${derivedFp}，插件报 ${accountSecret.fingerprint}`);
} else {
  ok(`账号派生密钥推导一致（${derivedFp}，userId=${debug.account.userId}）`);
}

const FAKE_PORT = 45943;
const FAKE_HOST = "127.0.0.2";

// 假对端：只认账号派生密钥，不认本机的 shared 主密钥
const realSessions = await (await fetch("http://127.0.0.1:45940/fleet/v1/sessions", {
  headers: { authorization: `Bearer ${derived}` },
})).json();
if (!realSessions?.sessions?.length) {
  bad("假对端拿不到 fixture（本机用账号派生密钥请求 /fleet/v1/sessions 失败）");
}
const sample = (realSessions.sessions || []).find((item) => item.title && item.sessionId);

let recordedPrompt = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const reply = (code, body) => {
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
    res.end(buf);
  };
  if (req.headers.authorization !== `Bearer ${derived}`) return reply(401, { ok: false, error: "只认账号派生密钥" });
  if (url.pathname === "/fleet/v1/hello") {
    return reply(200, {
      ok: true,
      app: "dsh-plugin-fleet",
      v: 1,
      version: "1.1.0",
      instanceId: "acctonly0001",
      machine: "SAME-ACCOUNT-BOX",
      platform: "win32",
      account: { signedIn: true, userId: debug.account.userId, name: "同账号另一台" },
      sessionCount: realSessions.sessions.length,
      runningCount: realSessions.sessions.filter((item) => item.running).length,
      secretMode: "account",
    });
  }
  if (url.pathname === "/fleet/v1/sessions") return reply(200, realSessions);
  if (url.pathname === "/fleet/v1/transcript") {
    return reply(200, {
      ok: true,
      machine: "SAME-ACCOUNT-BOX",
      title: sample?.title ?? "",
      items: [{ seq: 1, kind: "assistant", text: "来自同账号另一台机器的投影", time: Date.now() }],
      cursor: 1,
      reset: true,
      truncated: false,
    });
  }
  if (url.pathname === "/fleet/v1/prompt" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    recordedPrompt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return reply(200, { ok: true, accepted: true, via: "account-only-peer" });
  }
  return reply(404, { ok: false, error: "unknown" });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(FAKE_PORT, FAKE_HOST, resolve);
});
console.log(`假对端（只认账号派生密钥）已监听 ${FAKE_HOST}:${FAKE_PORT}`);

try {
  const added = await (await fetch(`${UI}/peers/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: `${FAKE_HOST}:${FAKE_PORT}` }),
  })).json();
  if (!added.ok) bad(`添加机器失败：${added.error}`);

  const peer = (added.peers || []).find((item) => item.machine === "SAME-ACCOUNT-BOX");
  if (!peer) bad("overview 里没出现 SAME-ACCOUNT-BOX");
  else if (!peer.reachable) bad(`同账号机器不可达：${peer.note}`);
  else ok(`同账号机器可达（用上的钥匙=${peer.matchedSecretMode}，会话数=${peer.sessionCount}）`);

  if (peer?.matchedSecretMode === "account") ok("确实是账号派生那条路打通的，不是共享密钥");
  else if (peer) bad(`打通用的是 ${peer.matchedSecretMode || "未知"}，没验证到账号派生路径`);

  if (peer?.key) {
    const list = await (await fetch(`${UI}/sessions?target=${encodeURIComponent(peer.key)}`)).json();
    if (!list.ok) bad(`远程任务列表失败：${list.error}`);
    else ok(`远程任务列表 ${(list.sessions || []).length} 条`);

    const tr = await (await fetch(
      `${UI}/transcript?target=${encodeURIComponent(peer.key)}&sessionId=${encodeURIComponent(sample.sessionId)}&afterSeq=0`,
    )).json();
    if (!tr.ok) bad(`远程投影失败：${tr.error}`);
    else ok(`远程投影 ${(tr.items || []).length} 条`);

    const sent = await (await fetch(`${UI}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: peer.key, sessionId: sample.sessionId, text: "同账号路径测试", mode: "queue" }),
    })).json();
    if (!sent.ok) bad(`远程发消息失败：${sent.error}`);
    else if (recordedPrompt?.text !== "同账号路径测试") bad("对端没收到正确文本");
    else ok(`远程发消息成功（via=${sent.via}）`);
  }

  await fetch(`${UI}/peers/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: `${FAKE_HOST}:${FAKE_PORT}` }),
  });
  ok("已清理测试机器");
} finally {
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.log(fail.length === 0 ? "\n✅ 同账号零配置配对通过" : `\n❌ ${fail.length} 项失败`);
process.exit(fail.length === 0 ? 0 : 1);
