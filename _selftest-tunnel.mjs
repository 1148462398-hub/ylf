// 端到端验证：通过 https 隧道域名访问对端 fleet（跨公网路径）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const state = JSON.parse(readFileSync(join(homedir(), ".dsh", "fleet", "state.json"), "utf8"));
const SECRET = state.sharedSecret;
const WEB = process.env.DSH_WEB_PORT || 49870;
const TUNNEL = process.argv[2] || "https://1ae40e94.r19.vip.cpolar.cn";

const api = (p, init) => fetch(`http://127.0.0.1:${WEB}/fleet/api${p}`, init);

const ok = [];
const bad = [];
function check(label, cond, extra = "") {
  (cond ? ok : bad).push(`${cond ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
}

// 0) 直接对隧道打 hello（不经过本机插件）
{
  const r = await fetch(`${TUNNEL}/fleet/v1/hello`, {
    headers: { authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => null);
  check("隧道域名 /fleet/v1/hello 可达", r.status === 200 && j?.ok === true, `HTTP ${r.status} machine=${j?.machine}`);
}

// 1) 把隧道地址当「手工机器」加进插件
{
  const r = await api("/peers/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: TUNNEL }),
  });
  const j = await r.json();
  check("添加隧道地址成功", j?.ok === true, `entry=${j?.entry ?? j?.error}`);
  const peer = (j?.peers ?? []).find((p) => p.key?.startsWith("manual:"));
  check("隧道对端被探活成功", peer?.reachable === true, `scheme=${peer?.scheme} host=${peer?.matchedHost} sessions=${peer?.sessionCount}`);
}

// 2) 用隧道地址拉会话列表
let peerKey = "";
{
  const ov = await (await api("/overview")).json();
  const peer = (ov?.peers ?? []).find((p) => p.key?.startsWith("manual:"));
  peerKey = peer?.key ?? "";
  check("overview 里隧道对端在线", peer?.reachable === true, `key=${peerKey}`);

  const r = await api(`/sessions?target=${encodeURIComponent(peerKey)}`);
  const j = await r.json();
  check("经隧道拉会话列表", j?.ok === true && Array.isArray(j?.sessions), `sessions=${j?.sessions?.length}`);
}

// 3) 用隧道地址拉对话投影
{
  const list = await (await api(`/sessions?target=${encodeURIComponent(peerKey)}`)).json();
  const first = (list?.sessions ?? []).find((s) => !s.blank) ?? (list?.sessions ?? [])[0];
  if (!first) {
    check("经隧道拉对话投影", false, "对端没有会话可用");
  } else {
    const r = await api(
      `/transcript?target=${encodeURIComponent(peerKey)}&sessionId=${encodeURIComponent(first.sessionId)}&afterSeq=0`,
    );
    const j = await r.json();
    check(
      "经隧道拉对话投影",
      j?.ok === true && Array.isArray(j?.items),
      `items=${j?.items?.length} cursor=${j?.cursor} session=${first.sessionId.slice(0, 16)}`,
    );
  }
}

// 4) 清理
{
  const r = await api("/peers/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: peerKey }),
  });
  const j = await r.json();
  check("移除隧道地址", j?.ok === true, `removed=${j?.removed}`);
}

console.log(ok.join("\n"));
if (bad.length) console.log("\n失败：\n" + bad.join("\n"));
console.log(`\n结果：${ok.length} 通过 / ${bad.length} 失败`);
process.exit(bad.length ? 1 : 0);
