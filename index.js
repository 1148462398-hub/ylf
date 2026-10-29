/**
 * dsh-plugin-fleet —— Host 侧。
 *
 * 目标：在任意一台装了本插件的 DSH 上，看到「我账号下其它电脑」上正在跑的任务，
 * 把那些会话的对话内容投影过来，并能继续往里发消息。
 *
 * 两条表面：
 *   1. 对端端口（默认 45940，绑 0.0.0.0）：`/fleet/v1/*`，给别的机器的 fleet 调用，
 *      用共享密钥做 Bearer 鉴权（同账号时密钥由账号 ID 派生，零配置）。
 *   2. UI 路由（挂在本机 DSH 的 webServer，前缀 /fleet/api）：浏览器同源 fetch。
 *
 * 核心三件事都用本机既有的官方服务完成，不自己造会话运行时：
 *   · 任务总览 —— sessionController.list()（带 running）+ sessionQuery.readTitleSnapshots()
 *   · 对话投影 —— sessionQuery.readSurface()（当前 model surface，按 surfaceOp 归并）
 *   · 继续发消息 —— sessionController.prompt()（官方 remote 语义，内部负责恢复会话）
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname, networkInterfaces, platform } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";

export const name = "dsh-plugin-fleet";
// 硬依赖只有 webServer：其余服务在调用时探测，缺了要给出明确提示而不是让插件起不来。
export const inject = ["webServer"];

const VERSION = "1.2.0";
// 模块被真正重新 import 的时刻（用于判断改代码后加载器有没有重新加载）
const MODULE_LOADED_AT = Date.now();
const API = "/fleet/api";
const PEER = "/fleet/v1";
const MAX_ITEMS = 400;

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 对端端口：别的机器的 fleet 连这个端口 */
  port: z.natural().default(45940),
  /** dsh-plugin-mesh 的端口，用来读它发现的机器列表 */
  meshPort: z.natural().default(45917),
  /** 留空 = 自动（登录账号则按账号派生，否则用本机随机密钥） */
  secret: z.string().default(""),
  /** 手工补充的对端地址，允许 "ip" 或 "ip:port" */
  extraPeers: z.array(String).default([]),
  /** 留空 = 主机名 */
  machineName: z.string().default(""),
  /** 局域网请求超时 */
  requestTimeoutMs: z.natural().default(20000),
  /** 隧道（https）请求超时：跨公网 + 会话列表上百 KB，要放宽 */
  tunnelTimeoutMs: z.natural().default(60000),
});

// ────────────────────────────── 小工具 ──────────────────────────────

const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest();

function send(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    /* 连接已断 */
  }
}

function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function deepPick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split(".")) {
      if (cur === null || cur === undefined) break;
      cur = cur[key];
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return "";
}

/**
 * 解析一个对端地址。除了 `192.168.1.5` / `192.168.1.5:45940`，
 * 还接受带协议的完整 URL —— 跨公网时对端往往只有一个 https 隧道域名：
 *   https://1ae40e94.r19.vip.cpolar.cn
 *   http://my-vps:8080
 * 返回 { host, port, scheme }，scheme 默认 http；https 且没写端口时补 443。
 */
function parseTarget(text) {
  let raw = String(text ?? "").trim();
  if (!raw) return null;
  let scheme = "http";
  const withScheme = /^(https?):\/\/(.+)$/i.exec(raw);
  if (withScheme) {
    scheme = withScheme[1].toLowerCase();
    raw = withScheme[2];
  }
  raw = raw.replace(/\/+$/, "");
  if (!raw) return null;
  const withPort = /^(.+?):(\d+)$/.exec(raw);
  if (withPort) return { host: withPort[1], port: Number(withPort[2]), scheme };
  return { host: raw, port: scheme === "https" ? 443 : null, scheme };
}

/** 把 { scheme, host, port } 还原成可写进配置/状态文件的地址字符串 */
function formatTarget(parsed, defaultPort) {
  const scheme = parsed.scheme === "https" ? "https" : "http";
  const prefix = scheme === "https" ? "https://" : "";
  const port = parsed.port ?? defaultPort;
  const suffix = port === defaultPort || (scheme === "https" && port === 443) ? "" : `:${port}`;
  return `${prefix}${parsed.host}${suffix}`;
}

/** 本机所有可用的局域网地址 —— 面板要直接告诉用户「另一台该填哪个地址」 */
function localAddresses() {
  const out = [];
  try {
    const interfaces = networkInterfaces();
    for (const [name, list] of Object.entries(interfaces)) {
      for (const item of list ?? []) {
        if (item.family !== "IPv4" || item.internal) continue;
        out.push({ name, address: item.address, netmask: item.netmask });
      }
    }
  } catch {
    /* 取不到就算了 */
  }
  // 169.254.x 是链路本地地址，对面填了也连不上，排到最后
  out.sort((a, b) => Number(a.address.startsWith("169.254.")) - Number(b.address.startsWith("169.254.")));
  return out;
}

/** 拼对端 URL。https 且端口是 443 时不写端口，隧道域名才认得。 */
function peerUrl(scheme, host, port, path) {
  const proto = scheme === "https" ? "https" : "http";
  const portPart = scheme === "https" && (port === 443 || !port) ? "" : `:${port}`;
  return `${proto}://${host}${portPart}${path}`;
}

function blocksText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

// ────────────────────────────── 状态文件 ──────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return join(homedir(), ".dsh");
}

const STATE_DIR = join(dshHome(), "fleet");
const STATE_FILE = join(STATE_DIR, "state.json");

const state = { instanceId: "", localSecret: "", sharedSecret: "", extraPeers: [] };

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (typeof parsed?.instanceId === "string") state.instanceId = parsed.instanceId;
    if (typeof parsed?.localSecret === "string") state.localSecret = parsed.localSecret;
    if (typeof parsed?.sharedSecret === "string") state.sharedSecret = parsed.sharedSecret;
    if (Array.isArray(parsed?.extraPeers)) {
      state.extraPeers = parsed.extraPeers.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
    }
  } catch {
    /* 状态文件坏了就重建，不影响启动 */
  }
}

function saveState() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          instanceId: state.instanceId,
          localSecret: state.localSecret,
          sharedSecret: state.sharedSecret,
          extraPeers: state.extraPeers,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* 写不进去只影响身份稳定性 */
  }
}

function ensureState() {
  loadState();
  let dirty = false;
  if (!state.instanceId) {
    state.instanceId = randomUUID().replace(/-/g, "").slice(0, 16);
    dirty = true;
  }
  if (!state.localSecret) {
    state.localSecret = randomBytes(24).toString("base64url");
    dirty = true;
  }
  if (dirty) saveState();
}

// ────────────────────────────── apply ──────────────────────────────

export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.("fleet: 已禁用");
    return;
  }

  const log = (m) => ctx.logger?.info?.(`fleet: ${m}`);
  const warn = (m) => ctx.logger?.warn?.(`fleet: ${m}`);

  ensureState();

  const machine = (config.machineName || "").trim() || hostname();

  function svc(serviceName) {
    try {
      return ctx.get(serviceName) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 归档集合。
   * sessionController.list() 的 SessionSummary 上没有 archived 字段，归档信息只存在于
   * workspaceController.follow() 的 baseline 帧里（WorkspaceBaseline.archivedSessionIds）。
   * follow 是流，所以这里开流→取首帧→立刻 abort，结果缓存 10 秒。
   */
  const archiveCache = { at: 0, ids: null, inflight: null };

  async function readArchivedIds() {
    if (archiveCache.ids && Date.now() - archiveCache.at < 10_000) return archiveCache.ids;
    if (archiveCache.inflight) return archiveCache.inflight;
    const wc = svc("workspaceController");
    if (!wc || typeof wc.follow !== "function") return null;
    archiveCache.inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      timer.unref?.();
      try {
        for await (const frame of wc.follow(controller.signal)) {
          const ids = frame?.type === "baseline" ? frame.value?.archivedSessionIds : frame?.archivedSessionIds;
          if (Array.isArray(ids)) {
            archiveCache.at = Date.now();
            archiveCache.ids = ids.filter((id) => typeof id === "string" && id);
            return archiveCache.ids;
          }
          break;
        }
        return null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        controller.abort();
        archiveCache.inflight = null;
      }
    })();
    return archiveCache.inflight;
  }

  // ── 账号身份（仅作归属标签 + 共享密钥派生依据）──
  const accountCache = { at: 0, value: null };

  /**
   * AccountView 里没有昵称，要另问一次 Platform profile。
   * 失败、超时、未授权一律当作「没有昵称」，绝不影响账号状态判定。
   */
  async function readProfileName(acc) {
    try {
      const client = {
        version: VERSION,
        locale: "zh-CN",
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
      const outcome = await Promise.race([
        acc.getProfile(client),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      const detail = outcome?.value ?? outcome;
      return deepPick(detail, [
        "name",
        "nickname",
        "displayName",
        "contact",
        "user.name",
        "profile.name",
      ]);
    } catch {
      return "";
    }
  }

  /**
   * AccountView 里没有 userId。真正的账号 ID 在 PlatformSession（getPlatformSession）
   * 或 DeviceIdentity（getDeviceIdentity）里。都拿不到就返回空串——调用方会退回本机随机密钥。
   */
  async function readAccountUserId(acc) {
    const tryCall = async (fn) => {
      try {
        if (typeof fn !== "function") return "";
        const value = await Promise.race([
          fn.call(acc),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        return deepPick(value, ["userId", "id", "user.userId", "identity.userId", "account.userId", "profile.id"]);
      } catch {
        return "";
      }
    };
    const fromSession = await tryCall(acc.getPlatformSession);
    if (fromSession) return fromSession;
    return tryCall(acc.getDeviceIdentity);
  }

  async function accountSnapshot(force = false) {
    const now = Date.now();
    if (!force && accountCache.value && now - accountCache.at < 30_000) return accountCache.value;
    const acc = svc("deepseekAccount");
    let raw = null;
    let value = { available: Boolean(acc), signedIn: false, userId: "", name: "" };
    if (acc && typeof acc.getState === "function") {
      try {
        raw = await acc.getState();
        const userId = deepPick(raw, [
          "userId",
          "id",
          "user.id",
          "user.userId",
          "profile.id",
          "profile.userId",
          "identity.userId",
          "account.id",
          "account.userId",
        ]);
        const nick = deepPick(raw, [
          "user.name",
          "user.nickname",
          "user.displayName",
          "profile.name",
          "profile.nickname",
          "account.name",
          "name",
          "nickname",
        ]);
        // AccountView = { status: "signed-out" | "credential-stored", links, attempt }
        // 里面既没有 userId，也没有 signedIn —— 之前只认 "signed-in"，于是永远判成未登录。
        const status = raw?.status ?? raw?.state;
        const signedIn = Boolean(
          userId ||
            raw?.signedIn === true ||
            status === "signed-in" ||
            status === "credential-stored" ||
            raw?.attempt?.phase === "succeeded",
        );
        // AccountView 不含 userId，真实身份要从 getPlatformSession / getDeviceIdentity 取，
        // 否则「同账号自动派生密钥」这条腿永远走不到。
        let resolvedUserId = userId;
        if (!resolvedUserId && signedIn) {
          resolvedUserId = await readAccountUserId(acc);
        }
        const name = nick || (signedIn && typeof acc.getProfile === "function" ? await readProfileName(acc) : "");
        value = { available: true, signedIn, userId: resolvedUserId, name };
      } catch (err) {
        value = { available: true, signedIn: false, userId: "", name: "", error: String(err?.message ?? err) };
      }
    }
    accountCache.at = now;
    accountCache.value = value;
    return value;
  }

  const ACCOUNT_SALT = "dsh-plugin-fleet/v1/";
  const ACCOUNT_SALT_LEGACY = "dsh-fleet/v1/";

  /**
   * 本机「认可」的全部密钥，按优先级排列。
   *
   * 这里不取单一值，是因为两种配对方式必须能同时生效：
   *   1) 同账号零配置 —— 两台机器登录同一个 DeepSeek 账号，各自从 userId 派生，
   *      谁都没填过共享密钥，也要能互通；
   *   2) 手工配对   —— 一台机器上点了「随机生成」，另一台粘贴过来。
   * 只留一个「当前密钥」时，一旦本机存了共享密钥，账号派生这条腿就被永久盖住，
   * 同一个账号的另一台机器就再也连不上——这正是「同账号自动配对失效」的根因。
   * 所以入站校验和出站探测都遍历这一整张表：任意一条能对上就算配对成功。
   */
  async function candidateSecrets() {
    const list = [];
    const push = (secret, mode) => {
      const text = String(secret ?? "").trim();
      if (!text) return;
      if (list.some((item) => item.secret === text)) return;
      list.push({ secret: text, mode });
    };
    push((config.secret || "").trim(), "config");
    push(state.sharedSecret, "shared");
    const account = await accountSnapshot();
    if (account.userId) {
      push(sha256(`${ACCOUNT_SALT}${account.userId}`).toString("hex"), "account");
      // 老版本（插件还叫 dsh-fleet 时）用的是另一个前缀，留着兼容没升级的对端
      push(sha256(`${ACCOUNT_SALT_LEGACY}${account.userId}`).toString("hex"), "account-legacy");
    }
    push(state.localSecret, "local");
    return list;
  }

  /** 主密钥：面板上展示、也是「我是谁」的默认答案 */
  async function currentSecret() {
    const list = await candidateSecrets();
    const first = list[0] ?? { secret: state.localSecret, mode: "local" };
    const account = await accountSnapshot();
    return { ...first, accountUserId: account.userId || "", all: list };
  }

  /** 在面板里设置/清除两端共用的密钥（写进 state.json，重启后仍在） */
  function setSharedSecret(value) {
    const text = String(value ?? "").trim();
    if (text && text.length < 12) throw new Error("共享密钥至少 12 个字符（建议直接用「随机生成」）");
    if (text.length > 200) throw new Error("共享密钥过长");
    state.sharedSecret = text;
    saveState();
    return { mode: text ? "shared" : "local" };
  }

  async function secretFingerprint() {
    const { secret } = await currentSecret();
    return sha256(secret).toString("hex").slice(0, 8);
  }

  /**
   * 入站鉴权：对端只要能用上本机任一认可密钥，就放行。
   * 这样「同账号派生」和「手工共享密钥」两条路同时有效，不再互相排斥。
   */
  async function authOk(req) {
    const header = String(req.headers["authorization"] ?? "");
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    const provided = sha256(match[1].trim());
    const list = await candidateSecrets();
    for (const item of list) {
      const expected = sha256(item.secret);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
    }
    return false;
  }

  // ── 会话总览 ──
  // 标题快照读一次就记住：几百条会话时重复读会持续超时，而标题本身几乎不变。
  const titleCache = new Map();

  async function listSessionsLocal() {
    const sc = svc("sessionController");
    const sq = svc("sessionQuery");
    const notes = [];
    let items = [];

    if (sc && typeof sc.list === "function") {
      try {
        const value = await sc.list({}, AbortSignal.timeout(20_000));
        items = Array.isArray(value?.items) ? value.items : [];
      } catch (err) {
        notes.push(`sessionController.list 失败：${String(err?.message ?? err)}`);
      }
    } else {
      notes.push("本机没有 sessionController.list");
    }

    if (items.length === 0 && sq && typeof sq.listSessions === "function") {
      try {
        const records = await sq.listSessions(AbortSignal.timeout(20_000));
        items = (Array.isArray(records) ? records : []).map((record) => ({
          sessionId: record?.header?.id,
          updatedAt: record?.header?.createdAt ?? 0,
          running: Boolean(record?.live),
          blank: false,
          cwd: record?.header?.cwd,
          parentSessionId: record?.header?.parentSession?.id,
          origin: record?.header?.origin,
          agentAvailable: true,
          runningFrom: "live",
        }));
        notes.push("已降级为 sessionQuery.listSessions（running 取自 live 标记）");
      } catch (err) {
        notes.push(`sessionQuery.listSessions 失败：${String(err?.message ?? err)}`);
      }
    }

    // 归档集合：官方出口只有 workspaceController.follow 的 baseline 帧
    let archivedIds = null;
    try {
      archivedIds = await readArchivedIds();
    } catch (err) {
      notes.push(`读取归档集合失败：${String(err?.message ?? err)}`);
    }
    if (archivedIds === null) notes.push("读不到归档集合（workspaceController 不可用），已归档会话无法单独收纳");
    const archivedSet = new Set(archivedIds ?? []);

    const rows = items
      .filter((item) => typeof item?.sessionId === "string" && item.sessionId)
      .map((item) => {
        const parentSessionId = typeof item.parentSessionId === "string" ? item.parentSessionId : "";
        const origin = typeof item.origin === "string" ? item.origin : "";
        const blank = Boolean(item.blank);
        const archived = archivedSet.has(item.sessionId);
        // 分组优先级：归档 > 子智能体 > 空白 > 工作区
        const group = archived ? "archived" : origin === "subagent" || parentSessionId ? "subagent" : blank ? "blank" : "workspace";
        return {
          sessionId: item.sessionId,
          title: "",
          running: Boolean(item.running),
          updatedAt: Number(item.updatedAt) || 0,
          cwd: typeof item.cwd === "string" ? item.cwd : "",
          origin,
          parentSessionId,
          blank,
          archived,
          group,
          agentAvailable: item.agentAvailable !== false,
        };
      });

    // 标题是单独的快照读取；失败不能拖垮整个列表。
    // 会话多时（几百条子智能体）一次读全部会超时，所以分批 + 缓存：
    // 已经拿到标题的会话不再重复读，每批失败只影响这一批。
    if (sq && typeof sq.readTitleSnapshots === "function" && rows.length > 0) {      const missing = rows.filter((row) => !titleCache.has(row.sessionId)).map((row) => row.sessionId);
      const BATCH = 60;
      let failedBatches = 0;
      for (let i = 0; i < missing.length; i += BATCH) {
        const slice = missing.slice(i, i + BATCH);
        try {
          const observations = await sq.readTitleSnapshots(slice, AbortSignal.timeout(12_000));
          for (const observation of Array.isArray(observations) ? observations : []) {
            if (observation?.status !== "fulfilled") continue;
            const title = observation.value?.title?.title;
            if (typeof title === "string" && title.trim()) titleCache.set(observation.sessionId, title.trim());
            else titleCache.set(observation.sessionId, "");
          }
        } catch {
          failedBatches += 1;
        }
      }
      for (const row of rows) {
        const cached = titleCache.get(row.sessionId);
        if (cached) row.title = cached;
      }
      if (failedBatches > 0) {
        notes.push(`标题读取有 ${failedBatches} 批超时（共 ${Math.ceil(missing.length / BATCH)} 批），其余已缓存`);
      }
    }

    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return { rows, notes };
  }

  // ── 对话投影 ──
  function renderEvent(event) {
    const type = typeof event?.type === "string" ? event.type : "";
    const data = event?.data ?? {};
    const seq = Number(event?.seq);
    const time = Number(event?.time) || 0;
    if (!Number.isFinite(seq)) return null;

    if (type === "user/message") {
      const message = data.message ?? data;
      const text = blocksText(message?.content);
      if (!text) return null;
      return { seq, time, kind: "user", text };
    }

    if (type === "assistant/message") {
      const message = data.message ?? data;
      const content = Array.isArray(message?.content) ? message.content : [];
      const parts = [];
      const calls = [];
      let reasoning = "";
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          parts.push(block.text.trim());
        } else if (block.type === "reasoning") {
          const text = typeof block.text === "string" ? block.text : typeof block.reasoning === "string" ? block.reasoning : "";
          if (text.trim()) reasoning += text;
        } else if (block.type === "tool-call") {
          let args = block.arguments ?? block.input ?? "";
          if (typeof args !== "string") {
            try {
              args = JSON.stringify(args);
            } catch {
              args = String(args);
            }
          }
          calls.push({ name: String(block.name ?? "tool"), args: String(args ?? "") });
        }
      }
      const text = parts.join("\n\n");
      if (!text && calls.length === 0) return null;
      return {
        seq,
        time,
        kind: "assistant",
        text,
        calls,
        interrupted: data.interrupted === true,
        hasReasoning: Boolean(reasoning),
      };
    }

    if (type === "tool/result") {
      const message = data.message ?? data;
      const text = blocksText(message?.content);
      const failed = Boolean(data.error);
      if (!text && !failed) return null;
      return {
        seq,
        time,
        kind: "tool-result",
        name: String(message?.name ?? data.name ?? ""),
        text: text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text,
        error: failed,
      };
    }

    if (type === "tool/call") {
      let args = data.arguments ?? "";
      if (typeof args !== "string") {
        try {
          args = JSON.stringify(args);
        } catch {
          args = String(args);
        }
      }
      return { seq, time, kind: "tool-call", name: String(data.name ?? "tool"), args: String(args ?? "") };
    }

    return null;
  }

  async function transcriptLocal(sessionId, afterSeq = 0) {
    const sq = svc("sessionQuery");
    if (!sq || typeof sq.readSurface !== "function") {
      throw new Error("本机没有 sessionQuery.readSurface，无法投影对话");
    }
    const snapshot = await sq.readSurface(sessionId);
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];

    // 按 surfaceOp 归并：replace 用新事件覆盖旧区间，append 直接追加。
    const merged = [];
    for (const event of events) {
      const op = event?.surfaceOp;
      if (op && typeof op === "object" && op.op === "replace") {
        const start = Number(op.startSeq);
        const end = Number(op.endSeq);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          for (let i = merged.length - 1; i >= 0; i -= 1) {
            if (merged[i].seq >= start && merged[i].seq <= end) merged.splice(i, 1);
          }
        }
      }
      const item = renderEvent(event);
      if (item) merged.push(item);
    }

    const maxSeq = merged.reduce((acc, item) => Math.max(acc, item.seq), 0);
    const captured = Number(snapshot?.capturedThroughSeq);
    const cursor = Math.max(Number.isFinite(captured) ? captured : 0, maxSeq);

    let reset = false;
    let items = merged;
    if (afterSeq > 0) {
      items = merged.filter((item) => item.seq > afterSeq);
      // 只有「本轮新增的事件里出现了覆盖到游标之前区间的 replace」才需要让前端重载。
      // 老的 replace 已经体现在合并结果里，不能每轮都触发重置，否则前端会一直重刷。
      reset = events.some((event) => {
        const seq = Number(event?.seq);
        if (!Number.isFinite(seq) || seq <= afterSeq) return false;
        const op = event?.surfaceOp;
        return Boolean(op) && typeof op === "object" && Number(op.startSeq) <= afterSeq;
      });
    }
    const truncated = items.length > MAX_ITEMS;
    if (truncated) items = items.slice(items.length - MAX_ITEMS);

    let title = "";
    try {
      const observations = await sq.readTitleSnapshots?.([sessionId], AbortSignal.timeout(8000));
      const first = Array.isArray(observations) ? observations[0] : null;
      if (first?.status === "fulfilled" && typeof first.value?.title?.title === "string") {
        title = first.value.title.title;
      }
    } catch {
      /* 标题拿不到不影响投影 */
    }

    return {
      sessionId,
      title,
      cwd: typeof snapshot?.session?.cwd === "string" ? snapshot.session.cwd : "",
      cursor,
      reset,
      truncated,
      items,
    };
  }

  // ── 继续发消息 ──
  async function promptLocal(sessionId, text, mode = "queue") {
    const body = String(text ?? "");
    if (!body.trim()) throw new Error("消息内容为空");
    if (body.length > 60_000) throw new Error("消息过长（上限 60000 字符）");

    const sc = svc("sessionController");
    if (sc && typeof sc.prompt === "function") {
      const requestId = `fleet-${randomUUID()}`;
      const result = await sc.prompt(
        {
          requestId,
          sessionId,
          mode: mode === "steer" ? "steer" : "queue",
          content: [{ type: "text", text: body }],
        },
        AbortSignal.timeout(45_000),
      );
      return { accepted: result?.accepted !== false, via: "sessionController.prompt" };
    }

    // 兜底：官方 remote 入口不在时，用 agent handle 恢复会话再 followup
    const agents = svc("agents");
    if (agents && typeof agents.resume === "function") {
      const llm = await import("@deepseek-ai/dsh-llm");
      const handle = await agents.resume({ resumeSessionId: sessionId });
      try {
        handle.agent.followup(
          llm.createUserMessage({
            content: [{ type: "text", text: body }],
            source: { kind: "webhook", provider: "fleet", source: machine, form: "notice", summary: "fleet 远程消息" },
          }),
        );
      } catch (err) {
        await handle.dispose?.().catch?.(() => {});
        throw err;
      }
      return { accepted: true, via: "agents.resume+followup" };
    }

    throw new Error("本机既没有 sessionController.prompt，也没有 agents.resume，无法发送消息");
  }

  // ── 机器发现：优先复用 mesh，其次手工地址 ──
  async function meshPeers() {
    const url = `http://127.0.0.1:${config.meshPort}/mesh/v1/peers`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return { ok: false, error: `mesh 返回 HTTP ${response.status}`, peers: [] };
      const payload = await response.json();
      return { ok: true, peers: Array.isArray(payload?.peers) ? payload.peers : [] };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err), peers: [] };
    }
  }

  function hostsOfPeer(peer) {
    const hosts = [];
    const push = (value) => {
      const text = String(value ?? "").trim();
      if (text && !hosts.includes(text)) hosts.push(text);
    };
    push(peer?.host);
    for (const endpoint of Array.isArray(peer?.endpoints) ? peer.endpoints : []) push(endpoint?.host);
    for (const address of Array.isArray(peer?.knownAddresses) ? peer.knownAddresses : []) {
      const parts = String(address).split(":");
      if (parts.length === 3) push(parts[1]);
    }
    for (const address of Array.isArray(peer?.addresses) ? peer.addresses : []) {
      push(typeof address === "string" ? address : address?.address);
    }
    return hosts.filter((host) => host !== "0.0.0.0" && host !== "::");
  }

  const peerCache = { at: 0, value: null, inflight: null };

  async function computePeers() {
    const account = await accountSnapshot();
    const secret = await currentSecret();
    const mesh = await meshPeers();

    const candidates = [];
    candidates.push({
      key: "self",
      machine,
      instanceId: state.instanceId,
      hosts: ["127.0.0.1"],
      port: config.port,
      self: true,
      online: true,
      note: "",
    });

    for (const peer of mesh.peers) {
      const hosts = hostsOfPeer(peer);
      if (hosts.length === 0) continue;
      if (String(peer?.id ?? "") === state.instanceId) continue;
      candidates.push({
        key: String(peer?.id ?? peer?.machine ?? hosts[0]),
        machine: String(peer?.machine ?? peer?.hostname ?? hosts[0]),
        instanceId: String(peer?.id ?? ""),
        hosts,
        port: config.port,
        self: false,
        online: Boolean(peer?.online),
        note: peer?.online ? "" : "mesh 侧标记为离线（仍会尝试直连）",
      });
    }

    for (const entry of [...config.extraPeers, ...state.extraPeers]) {
      const parsed = parseTarget(entry);
      if (!parsed) continue;
      if (candidates.some((item) => item.hosts.includes(parsed.host))) continue;
      const scheme = parsed.scheme === "https" ? "https" : "http";
      const port = parsed.port ?? config.port;
      candidates.push({
        key: `manual:${parsed.host}`,
        machine: parsed.host,
        instanceId: "",
        hosts: [parsed.host],
        port,
        scheme,
        self: false,
        online: true,
        note: scheme === "https" ? "手工添加的隧道地址" : "手工添加的地址",
      });
    }

    // 并行探活：拿到对方机器名、账号、会话数
    // 每条地址 × 每个本地认可密钥都要试一遍——两端可能各自落在不同的配对方式上
    // （一边是账号派生、一边是手工粘贴的共享密钥），只试主密钥会把这种组合误判成「密钥不一致」。
    const secrets = secret.all?.length ? secret.all : [{ secret: secret.secret, mode: secret.mode }];
    await Promise.all(
      candidates.map(async (candidate) => {
        let lastError = "";
        const scheme = candidate.scheme === "https" ? "https" : "http";
        // 隧道走公网，握手比局域网慢，给更宽的预算
        const probeTimeout = scheme === "https" ? 15_000 : 8_000;
        for (const host of candidate.hosts) {
          for (const item of secrets) {
            const url = peerUrl(scheme, host, candidate.port, `${PEER}/hello`);
            try {
              const response = await fetch(url, {
                headers: { authorization: `Bearer ${item.secret}` },
                signal: AbortSignal.timeout(probeTimeout),
              });
              if (response.status === 401) {
                lastError = "共享密钥不一致";
                continue;
              }
              if (!response.ok) {
                lastError = `HTTP ${response.status}`;
                continue;
              }
              const hello = await response.json();
              candidate.online = true;
              candidate.reachable = true;
              candidate.matchedHost = host;
              candidate.matchedSecretMode = item.mode;
              candidate.machine = String(hello?.machine ?? candidate.machine);
              candidate.instanceId = String(hello?.instanceId ?? candidate.instanceId);
              candidate.version = String(hello?.version ?? "");
              candidate.account = hello?.account ?? null;
              candidate.sessionCount = Number(hello?.sessionCount) || 0;
              candidate.runningCount = Number(hello?.runningCount) || 0;
              candidate.note = candidate.self ? "本机" : "";
              lastError = "";
              return;
            } catch (err) {
              lastError = String(err?.message ?? err);
            }
          }
        }
        if (!candidate.self) {
          candidate.reachable = false;
          candidate.online = false;
          candidate.note = lastError || candidate.note;
        } else if (lastError) {
          candidate.reachable = false;
          candidate.note = `本机端口自检失败：${lastError}`;
        }
      }),
    );

    return {
      at: Date.now(),
      self: {
        machine,
        instanceId: state.instanceId,
        port: config.port,
        hostname: hostname(),
        platform: platform(),
        // 面板直接把这一行显示成「另一台机器该填的地址」
        addresses: localAddresses(),
      },
      account,
      secret: {
        mode: secret.mode,
        fingerprint: sha256(secret.secret).toString("hex").slice(0, 8),
        value: secret.secret,
        // 本机同时认可的全部配对方式（同账号派生 / 手工共享密钥 / 配置手写），
        // 面板据此提示「同账号是否已经能直连」，而不是只看主密钥那一条。
        modes: (secret.all ?? []).map((item) => item.mode),
      },
      mesh: { ok: mesh.ok, error: mesh.error, count: mesh.peers.length, port: config.meshPort },
      extraPeers: [...state.extraPeers],
      peers: candidates,
    };
  }

  function refreshPeers(force = false) {
    const stale = force || !peerCache.value || Date.now() - peerCache.at > 8000;
    if (!stale && peerCache.value) return Promise.resolve(peerCache.value);
    if (peerCache.inflight) return peerCache.inflight;
    peerCache.inflight = computePeers()
      .then((value) => {
        peerCache.value = value;
        peerCache.at = Date.now();
        return value;
      })
      .catch((err) => {
        if (peerCache.value) return peerCache.value;
        throw err;
      })
      .finally(() => {
        peerCache.inflight = null;
      });
    return peerCache.inflight;
  }

  async function resolveTarget(target) {
    if (!target || target === "self") return { kind: "self" };
    const overview = await refreshPeers();
    const peer = overview.peers.find((item) => item.key === target || item.instanceId === target || item.machine === target);
    if (!peer) throw new Error(`找不到目标机器：${target}`);
    if (peer.self) return { kind: "self" };
    const host = peer.matchedHost || peer.hosts[0];
    if (!host) throw new Error(`目标机器 ${peer.machine} 没有可用地址`);
    return {
      kind: "remote",
      peer,
      host,
      port: peer.port,
      scheme: peer.scheme === "https" ? "https" : "http",
      secretMode: peer.matchedSecretMode ?? "",
    };
  }

  async function callRemote(host, port, path, options = {}) {
    const primary = await currentSecret();
    // 先试探活时真正对上的那把钥匙，再退回其余候选
    const ordered = [];
    const push = (item) => {
      if (item && !ordered.some((x) => x.secret === item.secret)) ordered.push(item);
    };
    if (options.secretMode) push((primary.all ?? []).find((item) => item.mode === options.secretMode));
    push(primary);
    for (const item of primary.all ?? []) push(item);

    let lastError = null;
    const timeoutMs = options.scheme === "https" ? config.tunnelTimeoutMs : config.requestTimeoutMs;
    for (const item of ordered) {
      const url = peerUrl(options.scheme, host, port, path);
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${item.secret}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) {
        lastError = new Error("对端拒绝访问：两端共享密钥不一致。请确认两台机器登录同一个 DeepSeek 账号，或在两端配置里写同一个 secret。");
        continue;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error(payload?.error ?? `对端返回 HTTP ${response.status}`);
      return payload ?? {};
    }
    throw lastError ?? new Error("对端拒绝访问");
  }

  // ── 对端端口 ──
  // 会话总览在 434 个会话时要 1~3 秒，而 hello 会被别的机器频繁探测，
  // 所以给它一个短缓存 + 短预算：拿不到就不报数字，绝不把探测拖成超时。
  const listCache = { at: 0, value: null, inflight: null };
  function listSessionsCached(maxWaitMs = 2500) {
    if (listCache.value && Date.now() - listCache.at < 5000) return Promise.resolve(listCache.value);
    if (!listCache.inflight) {
      listCache.inflight = listSessionsLocal()
        .then((value) => {
          listCache.value = value;
          listCache.at = Date.now();
          return value;
        })
        .finally(() => {
          listCache.inflight = null;
        });
    }
    if (!maxWaitMs) return listCache.inflight;
    return Promise.race([
      listCache.inflight,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), maxWaitMs);
        timer.unref?.();
      }),
    ]);
  }

  /** 按组统计，前端直接用来渲染分组标题 */
  function groupCounts(rows) {
    const counts = { workspace: 0, subagent: 0, blank: 0, archived: 0 };
    for (const row of rows) {
      const key = row.group || "workspace";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  async function peerSessions() {
    const { rows, notes } = (await listSessionsCached(0)) ?? { rows: [], notes: [] };
    return {
      ok: true,
      machine,
      generatedAt: Date.now(),
      sessions: rows,
      counts: groupCounts(rows),
      notes,
      account: await accountSnapshot(),
    };
  }

  async function handlePeer(req, res, url) {
    const path = url.pathname;
    if (path === `${PEER}/hello`) {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const account = await accountSnapshot();
      const cached = listCache.value;
      // 缓存冷时顺手预热，下次探测就能带上任务数；绝不在这里等
      if (!cached) listSessionsCached(0).catch(() => {});
      return send(res, 200, {
        ok: true,
        app: "dsh-plugin-fleet",
        v: 1,
        version: VERSION,
        instanceId: state.instanceId,
        machine,
        hostname: hostname(),
        platform: platform(),
        port: config.port,
        account: { signedIn: account.signedIn, userId: account.userId, name: account.name },
        sessionCount: cached ? cached.rows.length : null,
        runningCount: cached ? cached.rows.filter((row) => row.running).length : null,
        secretMode: (await currentSecret()).mode,
      });
    }

    if (path === `${PEER}/sessions`) {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      return send(res, 200, await peerSessions());
    }

    if (path === `${PEER}/transcript`) {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!sessionId) return send(res, 400, { ok: false, error: "缺少 sessionId" });
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0) || 0;
      try {
        const payload = await transcriptLocal(sessionId, afterSeq);
        return send(res, 200, { ok: true, machine, ...payload });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    if (path === `${PEER}/prompt`) {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      const sessionId = String(body?.sessionId ?? "");
      if (!sessionId) return send(res, 400, { ok: false, error: "缺少 sessionId" });
      try {
        const result = await promptLocal(sessionId, body?.text, body?.mode);
        return send(res, 200, { ok: true, machine, ...result });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    return send(res, 404, { ok: false, error: `未知路径 ${path}` });
  }

  function startPeerServer() {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      try {
        if (!url.pathname.startsWith(PEER)) return send(res, 404, { ok: false, error: "未知路径" });
        // 健康探测也带鉴权：不给密钥的人连"这台机器在跑 fleet"都不该知道
        if (!(await authOk(req))) return send(res, 401, { ok: false, error: "共享密钥不匹配" });
        await handlePeer(req, res, url);
      } catch (err) {
        warn(`对端请求失败 ${url.pathname}：${String(err?.message ?? err)}`);
        if (!res.headersSent) send(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    });

    server.on("error", (err) => {
      warn(`对端端口 ${config.port} 启动失败：${String(err?.message ?? err)}（其它机器将看不到本机）`);
    });

    server.listen(config.port, "0.0.0.0", () => {
      log(`对端端口已监听 0.0.0.0:${config.port}，机器名=${machine}`);
    });
    server.unref?.();

    ctx.effect(() => () => {
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    });
  }

  // ── UI 路由（同源，浏览器直接 fetch）──
  function registerUi() {
    const route = (path, handler) =>
      ctx.effect(() =>
        ctx.webServer.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res);
            } catch (err) {
              warn(`UI 接口 ${path} 失败：${String(err?.message ?? err)}`);
              if (!res.headersSent) send(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        }),
      );

    // 两端密钥对齐：在面板里把 A 机生成的密钥填到 B 机，写进 state.json，重启后仍在
    route(`${API}/secret`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      try {
        const result = setSharedSecret(body?.secret);
        const secret = await currentSecret();
        log(`共享密钥已更新（mode=${secret.mode}）`);
        return send(res, 200, { ok: true, ...result, fingerprint: sha256(secret.secret).toString("hex").slice(0, 8) });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
    });

    route(`${API}/secret/generate`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      const generated = randomBytes(18).toString("base64url");
      state.sharedSecret = generated;
      saveState();
      log("已生成新的共享密钥");
      return send(res, 200, { ok: true, secret: generated, mode: "shared" });
    });

    // 手工添加 / 移除机器：mesh 组播被挡、或跨网段跨公网时用这个
    route(`${API}/peers/add`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      const raw = typeof body?.entry === "string" ? body.entry.trim() : "";
      const parsed = parseTarget(raw);
      if (!parsed) {
        return send(res, 400, {
          ok: false,
          error: "地址格式不认识：写成 192.168.1.5、192.168.1.5:45940，或 https://xxx.cpolar.cn 这样的隧道域名",
        });
      }
      if (parsed.host === "127.0.0.1" || parsed.host === "localhost") {
        return send(res, 400, { ok: false, error: "127.0.0.1 就是本机，不用添加" });
      }
      const entry = formatTarget(parsed, config.port);
      // 同 host 只保留一条：用户可能先填 IP 后填隧道域名，指向同一台机器时不该堆两行
      const already = state.extraPeers.some((item) => {
        const itemParsed = parseTarget(item);
        return (itemParsed ? itemParsed.host : item) === parsed.host;
      });
      if (!already) {
        state.extraPeers.push(entry);
        saveState();
      }
      peerCache.at = 0;
      log(`已添加机器 ${entry}`);
      const overview = await refreshPeers(true);
      return send(res, 200, { ok: true, entry, ...overview });
    });

    route(`${API}/peers/remove`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      const raw = typeof body?.entry === "string" ? body.entry.trim() : "";
      // entry 可能是 "manual:host"、"host"、"host:port" 或 "https://host"，
      // 统一解析出 host 再按 host 前缀匹配，避免带协议的地址删不掉。
      const bare = raw.replace(/^manual:/, "");
      const parsed = parseTarget(bare);
      const host = parsed ? parsed.host : bare.split(":")[0];
      const before = state.extraPeers.length;
      state.extraPeers = state.extraPeers.filter((item) => {
        if (item === raw || item === bare || item === host) return false;
        const itemParsed = parseTarget(item);
        return (itemParsed ? itemParsed.host : item) !== host;
      });
      if (state.extraPeers.length !== before) saveState();
      peerCache.at = 0;
      const overview = await refreshPeers(true);
      return send(res, 200, { ok: true, removed: before - state.extraPeers.length, ...overview });
    });

    route(`${API}/overview`, async (req, res) => {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const overview = await refreshPeers(true);
      return send(res, 200, { ok: true, ...overview });
    });

    route(`${API}/sessions`, async (req, res) => {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const target = url.searchParams.get("target") ?? "self";
      const resolved = await resolveTarget(target);
      if (resolved.kind === "self") {
        const value = await peerSessions();
        return send(res, 200, { ok: true, target: "self", ...value });
      }
      const value = await callRemote(resolved.host, resolved.port, `${PEER}/sessions`, {
        secretMode: resolved.secretMode,
        scheme: resolved.scheme,
      });
      return send(res, 200, { ok: true, target: resolved.peer.key, machine: resolved.peer.machine, ...value });
    });

    route(`${API}/transcript`, async (req, res) => {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const target = url.searchParams.get("target") ?? "self";
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0) || 0;
      if (!sessionId) return send(res, 400, { ok: false, error: "缺少 sessionId" });
      const resolved = await resolveTarget(target);
      if (resolved.kind === "self") {
        const payload = await transcriptLocal(sessionId, afterSeq);
        return send(res, 200, { ok: true, target: "self", machine, ...payload });
      }
      const value = await callRemote(
        resolved.host,
        resolved.port,
        `${PEER}/transcript?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${afterSeq}`,
        { secretMode: resolved.secretMode, scheme: resolved.scheme },
      );
      return send(res, 200, { ...value, target: resolved.peer.key });
    });

    route(`${API}/prompt`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      const sessionId = String(body?.sessionId ?? "");
      if (!sessionId) return send(res, 400, { ok: false, error: "缺少 sessionId" });
      const resolved = await resolveTarget(String(body?.target ?? "self"));
      if (resolved.kind === "self") {
        const result = await promptLocal(sessionId, body?.text, body?.mode);
        return send(res, 200, { ok: true, target: "self", ...result });
      }
      const value = await callRemote(resolved.host, resolved.port, `${PEER}/prompt`, {
        method: "POST",
        body: { sessionId, text: body?.text, mode: body?.mode },
        secretMode: resolved.secretMode,
        scheme: resolved.scheme,
      });
      return send(res, 200, { ...value, target: resolved.peer.key });
    });

    // 一次性自检：新建一个会话 → 发一条消息 → 读回投影，验证「远程继续对话」整条链路。
    // 只在手动 POST 时执行，会真实消耗一次 agent 调用。
    route(`${API}/selftest`, async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "只支持 POST" });
      const out = { ok: true, steps: [] };
      const sc = svc("sessionController");
      if (!sc || typeof sc.create !== "function") {
        return send(res, 200, { ...out, ok: false, error: "本机 sessionController 没有 create" });
      }
      let sessionId = "";
      try {
        const created = await sc.create({}, AbortSignal.timeout(30_000));
        const flat = created && typeof created === "object" ? JSON.stringify(created).slice(0, 600) : String(created);
        out.steps.push({ step: "create", ok: true, result: flat });
        sessionId =
          created?.sessionId ??
          created?.session?.sessionId ??
          created?.session?.id ??
          created?.id ??
          created?.value?.sessionId ??
          "";
      } catch (err) {
        out.steps.push({ step: "create", ok: false, error: String(err?.message ?? err) });
      }
      if (!sessionId) return send(res, 200, { ...out, ok: false, error: "create 没有返回 sessionId", sessionId });
      out.sessionId = sessionId;

      try {
        const sent = await promptLocal(sessionId, "编队自测：请只回复「ok」，不要调用任何工具。");
        out.steps.push({ step: "prompt", ok: true, result: sent });
      } catch (err) {
        out.steps.push({ step: "prompt", ok: false, error: String(err?.message ?? err) });
      }

      const snapshots = [];
      for (const waitMs of [1200, 6000]) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
        try {
          const snapshot = await transcriptLocal(sessionId, 0);
          snapshots.push({
            afterMs: waitMs,
            items: snapshot.items.map((item) => ({ kind: item.kind, text: String(item.text ?? "").slice(0, 120) })),
            cursor: snapshot.cursor,
          });
        } catch (err) {
          snapshots.push({ afterMs: waitMs, error: String(err?.message ?? err) });
        }
      }
      out.snapshots = snapshots;
      return send(res, 200, out);
    });

    route(`${API}/debug`, async (req, res) => {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "只支持 GET" });
      const out = {
        ok: true,
        version: VERSION,
        moduleLoadedAt: MODULE_LOADED_AT,
        machine,
        instanceId: state.instanceId,
        port: config.port,
        services: {
          webServer: Boolean(svc("webServer")),
          sessionController: Boolean(svc("sessionController")),
          sessionControllerList: typeof svc("sessionController")?.list === "function",
          sessionControllerPrompt: typeof svc("sessionController")?.prompt === "function",
          sessionQuery: Boolean(svc("sessionQuery")),
          sessionQueryReadSurface: typeof svc("sessionQuery")?.readSurface === "function",
          sessionQueryReadTitleSnapshots: typeof svc("sessionQuery")?.readTitleSnapshots === "function",
          deepseekAccount: Boolean(svc("deepseekAccount")),
          agents: Boolean(svc("agents")),
          agentsResume: typeof svc("agents")?.resume === "function",
        },
      };
      try {
        out.account = await accountSnapshot(true);
      } catch (err) {
        out.accountError = String(err?.message ?? err);
      }
      try {
        // 配对诊断：本机认可的每把钥匙（只报 mode + 指纹，绝不回显密钥本身）
        const list = await candidateSecrets();
        out.secrets = list.map((item) => ({
          mode: item.mode,
          fingerprint: sha256(item.secret).toString("hex").slice(0, 8),
        }));
        const acct = await accountSnapshot();
        out.accountDerive = {
          salt: ACCOUNT_SALT,
          userId: acct.userId,
          userIdType: typeof acct.userId,
          joinedLength: `${ACCOUNT_SALT}${acct.userId}`.length,
          probeFingerprint: sha256(`${ACCOUNT_SALT}${acct.userId}`).toString("hex").slice(0, 8),
        };
      } catch (err) {
        out.secretsError = String(err?.message ?? err);
      }
      try {
        const raw = await svc("deepseekAccount")?.getState?.();
        out.accountRaw = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
      } catch (err) {
        out.accountRawError = String(err?.message ?? err);
      }
      try {
        const value = await svc("sessionController")?.list?.({}, AbortSignal.timeout(10_000));
        const items = Array.isArray(value?.items) ? value.items : [];
        // projections 很大（每个会话几 KB），诊断只看结构
        out.controllerItems = items.slice(0, 3).map((item) => {
          const lean = { ...item };
          if (lean.projections) lean.projections = `[${lean.projections.kind ?? "?"}]`;
          return lean;
        });
        out.controllerItemCount = items.length;
      } catch (err) {
        out.controllerError = String(err?.message ?? err);
      }
      try {
        const { rows, notes } = await listSessionsLocal();
        out.sessionCount = rows.length;
        out.runningCount = rows.filter((row) => row.running).length;
        out.sessionCounts = groupCounts(rows);
        out.archivedIds = await readArchivedIds();
        out.sessionSample = rows.slice(0, 2).map((row) => ({ id: row.sessionId, title: row.title, running: row.running }));
        out.notes = notes;
      } catch (err) {
        out.listError = String(err?.message ?? err);
      }
      try {
        out.peers = (await refreshPeers(true)).peers.map((peer) => ({
          key: peer.key,
          machine: peer.machine,
          hosts: peer.hosts,
          online: peer.online,
          reachable: peer.reachable,
          note: peer.note,
        }));
      } catch (err) {
        out.peersError = String(err?.message ?? err);
      }
      return send(res, 200, out);
    });
  }

  // ── 启动 ──
  try {
    startPeerServer();
    registerUi();
    log(
      `已就绪 机器=${machine} 实例=${state.instanceId} 对端端口=${config.port} mesh端口=${config.meshPort}` +
        `（${config.extraPeers.length} 个手工地址）`,
    );
    // 预热一次机器列表，侧栏打开时就有数据
    refreshPeers(true).catch(() => {});
  } catch (err) {
    warn(`初始化失败：${String(err?.message ?? err)}`);
  }

  ctx.effect(() => () => {
    log("已停止");
  });
}
