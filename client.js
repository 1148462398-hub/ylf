/**
 * dsh-plugin-fleet —— Client 侧（手写 bundle，只依赖 react）。
 *
 * 三个竖栏：
 *   机器    —— mesh 发现的对端 + 本机（在线状态、账号、会话数）
 *   任务    —— 选中机器上的会话列表（运行中 / 空闲、最后活动时间、工作目录）
 *   投影    —— 选中会话的对话内容 + 底部「继续发消息」
 *
 * 数据全部走同源 /fleet/api/*，由 Host 侧负责本机直读 or 转发到对端端口。
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-fleet",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = react;

    const PANEL_ID = "fleet";
    const API = "/fleet/api";
    const inject = ["slots"];
    const MAX_RENDERED = 400;

    let pluginCtx = null;

    // ─────────────────────────── 数据 ───────────────────────────

    async function apiJson(path, options) {
      const init = { method: (options && options.method) || "GET", headers: {} };
      if (options && options.body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      let response;
      try {
        response = await fetch(API + path, init);
      } catch (err) {
        return { ok: false, error: `连不上本机 Host：${String((err && err.message) || err)}` };
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!payload) return { ok: false, error: `Host 返回了非 JSON 响应（HTTP ${response.status}）` };
      if (!response.ok && payload.ok !== false) payload.ok = false;
      return payload;
    }

    function timeAgo(ms) {
      const value = Number(ms) || 0;
      if (!value) return "—";
      const delta = Date.now() - value;
      if (delta < 0) return "刚刚";
      const minute = 60_000;
      if (delta < minute) return `${Math.max(1, Math.round(delta / 1000))} 秒前`;
      if (delta < 60 * minute) return `${Math.round(delta / minute)} 分钟前`;
      if (delta < 24 * 60 * minute) return `${Math.round(delta / (60 * minute))} 小时前`;
      return `${Math.round(delta / (24 * 60 * minute))} 天前`;
    }

    function clockOf(ms) {
      const value = Number(ms) || 0;
      if (!value) return "";
      try {
        return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    function baseName(path) {
      const text = String(path || "");
      if (!text) return "";
      const parts = text.split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : text;
    }

    function mergeItems(previous, incoming) {
      if (!incoming || incoming.length === 0) return previous;
      const bySeq = new Map();
      for (const item of previous) bySeq.set(`${item.kind}:${item.seq}`, item);
      for (const item of incoming) bySeq.set(`${item.kind}:${item.seq}`, item);
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq || String(a.kind).localeCompare(String(b.kind)));
      if (merged.length <= MAX_RENDERED) return merged;
      return merged.slice(merged.length - MAX_RENDERED);
    }

    // ─────────────────────────── 图标 ───────────────────────────

    function FleetIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("circle", { cx: 12, cy: 5, r: 2.4 }),
        h("circle", { cx: 5, cy: 17, r: 2.4 }),
        h("circle", { cx: 19, cy: 17, r: 2.4 }),
        h("path", { d: "M10.6 6.9 6.4 14.8" }),
        h("path", { d: "M13.4 6.9 17.6 14.8" }),
        h("path", { d: "M7.4 17h9.2" }),
      );
    }

    // ─────────────────────────── 子组件 ───────────────────────────

    function MachineRow(props) {
      const peer = props.peer;
      const active = props.active;
      const running = Number(peer.runningCount) || 0;
      const total = Number(peer.sessionCount) || 0;
      return h(
        "button",
        {
          type: "button",
          className: `fleet-row${active ? " is-active" : ""}`,
          onClick: () => props.onSelect(peer.key),
          title: peer.reachable === false ? peer.note || "无法连接" : peer.note || "",
        },
        h("span", { className: `fleet-dot${peer.online ? " is-online" : ""}${peer.reachable === false ? " is-bad" : ""}` }),
        h(
          "span",
          { className: "fleet-row-main" },
          h("span", { className: "fleet-row-name" }, peer.machine || peer.key),
          h(
            "span",
            { className: "fleet-row-sub" },
            peer.self ? "本机" : peer.online ? "在线" : "离线/不可达",
            total ? ` · ${total} 个任务` : "",
            running ? ` · ${running} 个在跑` : "",
          ),
        ),
        running > 0 ? h("span", { className: "fleet-badge is-running" }, "运行中") : null,
      );
    }

    // 分组定义：顺序即渲染顺序；defaultOpen 决定初始是否展开
    const GROUPS = [
      { key: "workspace", label: "工作区任务", hint: "默认工作区里自己开的会话", defaultOpen: true },
      { key: "subagent", label: "子智能体", hint: "由主会话派生出来的子任务", defaultOpen: false },
      { key: "blank", label: "空白会话", hint: "还没开始过的空会话", defaultOpen: false },
      { key: "archived", label: "已归档", hint: "在 DSH 里归档过的会话", defaultOpen: false },
    ];

    function SessionRow(props) {
      const session = props.session;
      const active = props.active;
      const label = session.title || "（未命名会话）";
      const tags = [];
      if (session.archived) tags.push("已归档");
      if (session.parentSessionId) tags.push("子任务");
      return h(
        "button",
        {
          type: "button",
          className: `fleet-session${active ? " is-active" : ""}${session.archived ? " is-archived" : ""}`,
          onClick: () => props.onSelect(session.sessionId),
          title: session.cwd || session.sessionId,
        },
        h(
          "span",
          { className: "fleet-session-top" },
          session.running ? h("span", { className: "fleet-pulse" }) : h("span", { className: "fleet-idle" }),
          h("span", { className: "fleet-session-title" }, label),
          tags.length ? h("span", { className: "fleet-tag is-dim" }, tags.join(" · ")) : null,
        ),
        h(
          "span",
          { className: "fleet-session-meta" },
          session.running ? "运行中" : "空闲",
          " · ",
          timeAgo(session.updatedAt),
          session.cwd ? ` · ${baseName(session.cwd)}` : "",
        ),
      );
    }

    /** 一个可折叠分组：标题 + 计数，展开后才渲染里面的会话 */
    function GroupSection(props) {
      const group = props.group;
      const rows = props.rows;
      const open = props.open;
      const running = rows.filter((row) => row.running).length;
      return h(
        "div",
        { className: `fleet-group${open ? " is-open" : ""}` },
        h(
          "button",
          { type: "button", className: "fleet-group-head", onClick: () => props.onToggle(group.key) },
          h("span", { className: "fleet-group-caret" }, open ? "▾" : "▸"),
          h("span", { className: "fleet-group-label" }, group.label),
          h("span", { className: "fleet-group-count" }, String(rows.length)),
          running > 0 ? h("span", { className: "fleet-badge is-running" }, `${running} 在跑`) : null,
        ),
        open
          ? h(
              "div",
              { className: "fleet-group-body" },
              rows.length === 0
                ? h("div", { className: "fleet-group-empty" }, "（空）")
                : rows.map((session) =>
                    h(SessionRow, {
                      key: session.sessionId,
                      session,
                      active: session.sessionId === props.activeId,
                      onSelect: props.onSelect,
                    }),
                  ),
            )
          : null,
      );
    }

    function Bubble(props) {
      const item = props.item;
      const kind = item.kind;

      if (kind === "user") {
        return h(
          "div",
          { className: "fleet-msg is-user" },
          h("div", { className: "fleet-msg-head" }, h("span", { className: "fleet-who" }, "用户"), h("span", { className: "fleet-time" }, clockOf(item.time))),
          h("div", { className: "fleet-bubble" }, item.text),
        );
      }

      if (kind === "assistant") {
        return h(
          "div",
          { className: "fleet-msg is-assistant" },
          h(
            "div",
            { className: "fleet-msg-head" },
            h("span", { className: "fleet-who" }, props.machineName || "助手"),
            h("span", { className: "fleet-time" }, clockOf(item.time)),
            item.interrupted ? h("span", { className: "fleet-tag is-warn" }, "已中断") : null,
          ),
          item.text ? h("div", { className: "fleet-bubble" }, item.text) : null,
          (item.calls || []).map((call, index) =>
            h(
              "div",
              { key: `call-${item.seq}-${index}`, className: "fleet-call" },
              h("span", { className: "fleet-call-name" }, call.name),
              call.args ? h("code", { className: "fleet-call-args" }, String(call.args).slice(0, 600)) : null,
            ),
          ),
        );
      }

      if (kind === "tool-call") {
        return h(
          "div",
          { className: "fleet-call" },
          h("span", { className: "fleet-call-name" }, item.name || "tool"),
          item.args ? h("code", { className: "fleet-call-args" }, String(item.args).slice(0, 600)) : null,
        );
      }

      if (kind === "tool-result") {
        return h(
          "details",
          { className: `fleet-tool${item.error ? " is-error" : ""}` },
          h(
            "summary",
            {},
            h("span", { className: "fleet-tool-name" }, item.name || "工具结果"),
            h("span", { className: "fleet-time" }, clockOf(item.time)),
            item.error ? h("span", { className: "fleet-tag is-warn" }, "出错") : null,
          ),
          h("pre", { className: "fleet-tool-body" }, item.text || "（空）"),
        );
      }

      return null;
    }

    // ─────────────────────────── 主组件 ───────────────────────────

    function FleetApp() {
      const [overview, setOverview] = useState(null);
      const [overviewError, setOverviewError] = useState("");
      const [target, setTarget] = useState("self");
      const [sessions, setSessions] = useState([]);
      const [sessionsNote, setSessionsNote] = useState("");
      const [sessionsError, setSessionsError] = useState("");
      const [sessionId, setSessionId] = useState("");
      const [items, setItems] = useState([]);
      const [cursor, setCursor] = useState(0);
      const [title, setTitle] = useState("");
      const [transcriptError, setTranscriptError] = useState("");
      const [draft, setDraft] = useState("");
      const [sending, setSending] = useState(false);
      const [notice, setNotice] = useState("");
      const [showReasoningHint, setShowReasoningHint] = useState(false);
      const [secretDraft, setSecretDraft] = useState("");
      const [secretBusy, setSecretBusy] = useState(false);
      const [secretNotice, setSecretNotice] = useState("");
      const [peerDraft, setPeerDraft] = useState("");
      const [peerBusy, setPeerBusy] = useState(false);
      const [peerNotice, setPeerNotice] = useState("");
      // 分组展开状态：默认只展开「工作区任务」，其余折叠（434 个会话时这是必需的）
      const [openGroups, setOpenGroups] = useState(() => {
        const init = {};
        for (const group of GROUPS) init[group.key] = Boolean(group.defaultOpen);
        return init;
      });

      const cursorRef = useRef(0);
      const aliveRef = useRef(true);
      const scrollRef = useRef(null);
      const stickRef = useRef(true);
      const targetRef = useRef("self");
      const sessionRef = useRef("");

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      targetRef.current = target;
      sessionRef.current = sessionId;

      // 机器列表
      const loadOverview = useCallback(async () => {
        const payload = await apiJson("/overview");
        if (!aliveRef.current) return;
        if (!payload.ok) {
          setOverviewError(payload.error || "读取机器列表失败");
          return;
        }
        setOverviewError("");
        setOverview(payload);
      }, []);

      useEffect(() => {
        loadOverview();
        const timer = setInterval(loadOverview, 10_000);
        return () => clearInterval(timer);
      }, [loadOverview]);

      // 机器列表就绪后，修正 target（原 target 消失时退回 self）
      useEffect(() => {
        if (!overview || !Array.isArray(overview.peers)) return;
        const exists = overview.peers.some((peer) => peer.key === target);
        if (!exists) {
          setTarget("self");
          setSessionId("");
        }
      }, [overview, target]);

      // 会话列表
      const loadSessions = useCallback(async (machineKey) => {
        const payload = await apiJson(`/sessions?target=${encodeURIComponent(machineKey)}`);
        if (!aliveRef.current) return;
        if (!payload.ok) {
          setSessionsError(payload.error || "读取任务列表失败");
          return;
        }
        setSessionsError("");
        setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
        setSessionsNote(Array.isArray(payload.notes) && payload.notes.length ? payload.notes.join("；") : "");
      }, []);

      useEffect(() => {
        setSessions([]);
        setSessionId("");
        loadSessions(target);
        const timer = setInterval(() => loadSessions(target), 5000);
        return () => clearInterval(timer);
      }, [target, loadSessions]);

      // 会话被移除时清理选中
      useEffect(() => {
        if (!sessionId) return;
        if (sessions.length === 0) return;
        if (!sessions.some((session) => session.sessionId === sessionId)) setSessionId("");
      }, [sessions, sessionId]);

      // 投影
      useEffect(() => {
        cursorRef.current = 0;
        setItems([]);
        setCursor(0);
        setTitle("");
        setTranscriptError("");
        if (!sessionId) return undefined;

        let cancelled = false;
        const mine = sessionId;
        const machineKey = target;

        const pull = async () => {
          const after = cursorRef.current;
          const query =
            `/transcript?target=${encodeURIComponent(machineKey)}&sessionId=${encodeURIComponent(mine)}` +
            (after > 0 ? `&afterSeq=${after}` : "");
          const payload = await apiJson(query);
          if (cancelled || !aliveRef.current) return;
          if (targetRef.current !== machineKey || sessionRef.current !== mine) return;
          if (!payload.ok) {
            setTranscriptError(payload.error || "读取对话失败");
            return;
          }
          setTranscriptError("");
          if (typeof payload.title === "string" && payload.title) setTitle(payload.title);
          if (payload.reset && after > 0) {
            cursorRef.current = 0;
            setItems([]);
            setCursor(0);
            return;
          }
          if (Number.isFinite(payload.cursor)) {
            cursorRef.current = Math.max(cursorRef.current, Number(payload.cursor) || 0);
            setCursor(cursorRef.current);
          }
          setItems((previous) => mergeItems(previous, payload.items || []));
          setShowReasoningHint(Boolean((payload.items || []).some((item) => item.hasReasoning)));
        };

        pull();
        const timer = setInterval(pull, 2200);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [target, sessionId]);

      // 自动滚动
      useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;
        if (stickRef.current) node.scrollTop = node.scrollHeight;
      }, [items]);

      const onScroll = useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }, []);

      const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || !sessionId || sending) return;
        setSending(true);
        setNotice("正在发送…");
        const payload = await apiJson("/prompt", {
          method: "POST",
          body: { target, sessionId, text, mode: "queue" },
        });
        if (!aliveRef.current) return;
        setSending(false);
        if (!payload.ok) {
          setNotice(payload.error || "发送失败");
          return;
        }
        setDraft("");
        stickRef.current = true;
        setNotice(`已发送${payload.via ? `（${payload.via}）` : ""}`);
        loadSessions(target);
      }, [draft, sending, sessionId, target, loadSessions]);

      const addPeer = useCallback(async () => {
        const text = peerDraft.trim();
        if (!text || peerBusy) return;
        setPeerBusy(true);
        const payload = await apiJson("/peers/add", { method: "POST", body: { entry: text } });
        if (!aliveRef.current) return;
        setPeerBusy(false);
        if (!payload.ok) {
          setPeerNotice(payload.error || "添加失败");
          return;
        }
        setPeerDraft("");
        setPeerNotice(`已添加 ${payload.entry}，正在探测…`);
        loadOverview();
      }, [peerDraft, peerBusy, loadOverview]);

      const removePeer = useCallback(
        async (entry) => {
          if (peerBusy) return;
          setPeerBusy(true);
          const payload = await apiJson("/peers/remove", { method: "POST", body: { entry } });
          if (!aliveRef.current) return;
          setPeerBusy(false);
          setPeerNotice(payload.ok ? `已移除 ${entry}` : payload.error || "移除失败");
          loadOverview();
        },
        [peerBusy, loadOverview],
      );

      const saveSecret = useCallback(async () => {
        const text = secretDraft.trim();
        if (secretBusy) return;
        setSecretBusy(true);
        const payload = await apiJson("/secret", { method: "POST", body: { secret: text } });
        if (!aliveRef.current) return;
        setSecretBusy(false);
        if (!payload.ok) {
          setSecretNotice(payload.error || "保存失败");
          return;
        }
        setSecretDraft("");
        setSecretNotice(text ? `已保存（指纹 ${payload.fingerprint}）` : "已清除，回到本机随机密钥");
        loadOverview();
      }, [secretDraft, secretBusy, loadOverview]);

      const rollSecret = useCallback(async () => {
        if (secretBusy) return;
        setSecretBusy(true);
        const payload = await apiJson("/secret/generate", { method: "POST", body: {} });
        if (!aliveRef.current) return;
        setSecretBusy(false);
        if (!payload.ok) {
          setSecretNotice(payload.error || "生成失败");
          return;
        }
        setSecretNotice("已生成新密钥，请复制到另一台机器");
        loadOverview();
      }, [secretBusy, loadOverview]);

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
          }
        },
        [send],
      );

      const peers = (overview && overview.peers) || [];
      const currentPeer = useMemo(() => peers.find((peer) => peer.key === target) || null, [peers, target]);
      const currentMachineName = currentPeer ? currentPeer.machine : "";
      const secretInfo = (overview && overview.secret) || null;
      const accountInfo = (overview && overview.account) || null;
      const meshInfo = (overview && overview.mesh) || null;
      const manualPeers = (overview && overview.extraPeers) || [];
      // 本机可被对端填写的地址（跨机配对时直接照抄这一行）
      const selfAddresses = (overview && overview.self && overview.self.addresses) || [];
      const selfPort = (overview && overview.self && overview.self.port) || 45940;
      const selfAddressText = selfAddresses.length ? `${selfAddresses[0].address}:${selfPort}` : "";
      const selectedSession = sessions.find((session) => session.sessionId === sessionId) || null;

      // 按组切分会话；组内保持 Host 给的 updatedAt 降序
      const grouped = useMemo(() => {
        const bucket = {};
        for (const group of GROUPS) bucket[group.key] = [];
        for (const session of sessions) {
          const key = bucket[session.group] ? session.group : "workspace";
          bucket[key].push(session);
        }
        return bucket;
      }, [sessions]);

      const toggleGroup = useCallback((key) => {
        setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
      }, []);

      // 选中的会话若落在折叠组里，自动把它展开——否则左侧看不到当前选中的那条
      useEffect(() => {
        if (!sessionId) return;
        const current = sessions.find((session) => session.sessionId === sessionId);
        if (!current || !current.group) return;
        setOpenGroups((prev) => (prev[current.group] ? prev : { ...prev, [current.group]: true }));
      }, [sessionId, sessions]);

      // 头部状态条
      const headerHints = [];
      if (accountInfo && !accountInfo.signedIn) headerHints.push("未登录 DeepSeek 账号：请用面板里的密钥配对两台机器");
      if (secretInfo) {
        const modeText =
          secretInfo.mode === "account"
            ? "账号派生"
            : secretInfo.mode === "config"
              ? "手写配置"
              : secretInfo.mode === "shared"
                ? "面板共享"
                : "本机随机";
        headerHints.push(`密钥：${modeText}（指纹 ${secretInfo.fingerprint}）`);
        // 同账号派生这条路现在永远保留：就算本机存了共享密钥，另一台同账号机器照样能连上
        const modes = Array.isArray(secretInfo.modes) ? secretInfo.modes : [];
        if (modes.includes("account") && secretInfo.mode !== "account") headerHints.push("同账号直连同时可用");
        if (!modes.includes("account") && accountInfo?.signedIn) headerHints.push("未取到账号 ID：只能靠共享密钥配对");
      }
      if (meshInfo && !meshInfo.ok) headerHints.push(`未读到 mesh（${meshInfo.error}），机器列表可能只有本机`);

      return h(
        "div",
        { className: "fleet-root" },
        h(
          "div",
          { className: "fleet-head" },
          h("span", { className: "fleet-title" }, "编队 · 远程任务"),
          h("span", { className: "fleet-head-sub" }, headerHints.join("　·　")),
          h(
            "button",
            {
              type: "button",
              className: "fleet-btn is-ghost",
              onClick: () => {
                loadOverview();
                loadSessions(target);
              },
            },
            "刷新",
          ),
        ),
        overviewError ? h("div", { className: "fleet-alert" }, overviewError) : null,
        h(
          "div",
          { className: "fleet-body" },
          // 机器
          h(
            "div",
            { className: "fleet-col is-machines" },
            h("div", { className: "fleet-col-head" }, `机器（${peers.length}）`),
            h(
              "div",
              { className: "fleet-scroll" },
              peers.length === 0
                ? h("div", { className: "fleet-empty" }, "还没发现其它机器。装好 dsh-plugin-mesh，或在本插件配置的 extraPeers 里填对方 IP。")
                : peers.map((peer) =>
                    h(MachineRow, {
                      key: peer.key,
                      peer,
                      active: peer.key === target,
                      onSelect: (key) => {
                        setTarget(key);
                        setSessionId("");
                      },
                    }),
                  ),
            ),
            h(
              "div",
              { className: "fleet-pair" },
              h(
                "div",
                { className: "fleet-pair-head" },
                h("span", null, "手工添加机器"),
                manualPeers.length > 0 ? h("span", null, `${manualPeers.length} 个`) : null,
              ),
              h(
                "div",
                { className: "fleet-pair-row" },
                h("input", {
                  className: "fleet-input is-compact",
                  placeholder: "对方 IP、IP:45940 或 https://xxx.cpolar.cn",
                  value: peerDraft,
                  disabled: peerBusy,
                  onInput: (event) => setPeerDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") addPeer();
                  },
                }),
                h("button", { type: "button", className: "fleet-btn is-mini", disabled: peerBusy, onClick: addPeer }, "添加"),
              ),
              manualPeers.length > 0
                ? h(
                    "div",
                    { className: "fleet-chips" },
                    manualPeers.map((entry) =>
                      h(
                        "div",
                        { className: "fleet-chip", key: entry },
                        h("span", null, entry),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "fleet-chip-x",
                            title: "移除",
                            disabled: peerBusy,
                            onClick: () => removePeer(entry),
                          },
                          "×",
                        ),
                      ),
                    ),
                  )
                : null,
              peerNotice
                ? h("div", { className: "fleet-pair-hint" }, peerNotice)
                : h(
                    "div",
                    { className: "fleet-pair-hint" },
                    "局域网自动发现靠 dsh-plugin-mesh；它被挡或跨公网时，填对方 IP 或隧道域名也能连。",
                  ),
              selfAddressText
                ? h(
                    "div",
                    { className: "fleet-pair-hint" },
                    "本机地址（填到另一台的输入框里）：",
                    h("code", { className: "fleet-secret" }, selfAddressText),
                  )
                : null,
            ),
            h(
              "div",
              { className: "fleet-pair" },
              h(
                "div",
                { className: "fleet-pair-head" },
                h("span", null, "两端密钥"),
                h(
                  "button",
                  { type: "button", className: "fleet-btn is-ghost is-mini", disabled: secretBusy, onClick: rollSecret },
                  "随机生成",
                ),
              ),
              secretInfo && secretInfo.value
                ? h("code", { className: "fleet-secret" }, secretInfo.value)
                : h("div", { className: "fleet-pair-hint" }, "读不到密钥值"),
              h("div", { className: "fleet-pair-hint" }, "同一 DeepSeek 账号的两台机器会自动互通，这一串只用于跨账号或不想依赖账号时的手工配对。"),
              h(
                "div",
                { className: "fleet-pair-row" },
                h("input", {
                  className: "fleet-input is-compact",
                  placeholder: "粘贴另一台机器的密钥",
                  value: secretDraft,
                  disabled: secretBusy,
                  onInput: (event) => setSecretDraft(event.target.value),
                }),
                h(
                  "button",
                  { type: "button", className: "fleet-btn is-mini", disabled: secretBusy, onClick: saveSecret },
                  "保存",
                ),
              ),
              secretNotice ? h("div", { className: "fleet-pair-hint" }, secretNotice) : null,
            ),
          ),
          // 任务
          h(
            "div",
            { className: "fleet-col is-sessions" },
            h("div", { className: "fleet-col-head" }, `任务（${sessions.length}）${currentMachineName ? ` · ${currentMachineName}` : ""}`),
            sessionsError ? h("div", { className: "fleet-alert" }, sessionsError) : null,
            h(
              "div",
              { className: "fleet-scroll" },
              sessions.length === 0
                ? h("div", { className: "fleet-empty" }, sessionsError ? "读不到任务列表" : "这台机器上没有会话")
                : GROUPS.map((group) =>
                    h(GroupSection, {
                      key: group.key,
                      group,
                      rows: grouped[group.key] || [],
                      open: Boolean(openGroups[group.key]),
                      onToggle: toggleGroup,
                      activeId: sessionId,
                      onSelect: setSessionId,
                    }),
                  ),
            ),
            sessionsNote ? h("div", { className: "fleet-foot-note" }, sessionsNote) : null,
          ),
          // 投影
          h(
            "div",
            { className: "fleet-col is-projection" },
            h(
              "div",
              { className: "fleet-proj-head" },
              h("span", { className: "fleet-proj-title" }, selectedSession ? selectedSession.title || "（未命名会话）" : "选一个任务"),
              sessionId
                ? h(
                    "span",
                    { className: "fleet-proj-sub" },
                    selectedSession && selectedSession.cwd ? selectedSession.cwd : "",
                    " · 序号 ",
                    String(cursor),
                  )
                : null,
            ),
            transcriptError ? h("div", { className: "fleet-alert" }, transcriptError) : null,
            h(
              "div",
              { className: "fleet-scroll is-projection", ref: scrollRef, onScroll },
              !sessionId
                ? h("div", { className: "fleet-empty" }, "左侧选一台机器，再选一个任务，就能在这里看到它的对话并继续发消息。")
                : items.length === 0
                  ? h("div", { className: "fleet-empty" }, "还没有可显示的消息（或正在读取）…")
                  : items.map((item) => h(Bubble, { key: `${item.kind}:${item.seq}`, item, machineName: currentMachineName })),
            ),
            showReasoningHint && items.length > 0
              ? h("div", { className: "fleet-foot-note" }, "这里只投影对话正文与工具调用，不显示思考过程。")
              : null,
            h(
              "div",
              { className: "fleet-composer" },
              h("textarea", {
                className: "fleet-input",
                value: draft,
                placeholder: sessionId ? "继续这个任务：写下要发的消息，Ctrl+Enter 发送" : "先选一个任务",
                disabled: !sessionId || sending,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown,
                rows: 3,
              }),
              h(
                "div",
                { className: "fleet-composer-side" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "fleet-btn is-primary",
                    disabled: !sessionId || sending || !draft.trim(),
                    onClick: send,
                  },
                  sending ? "发送中…" : "发送",
                ),
                notice ? h("span", { className: "fleet-notice" }, notice) : null,
              ),
            ),
          ),
        ),
      );
    }

    // ─────────────────────────── 样式 ───────────────────────────

    const CSS = `
.fleet-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px;
}
.fleet-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.fleet-title { font-weight: 600; font-size: 13px; }
.fleet-head-sub {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b6b6b); font-size: 12px;
}
.fleet-body { display: flex; flex: 1; min-height: 0; }
.fleet-col {
  display: flex; flex-direction: column; min-height: 0; min-width: 0;
  border-right: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
}
.fleet-col.is-machines { width: 210px; flex: 0 0 210px; background: var(--dsw-alias-bg-layer-1, #fafafa); }
.fleet-col.is-sessions { width: 260px; flex: 0 0 260px; }
.fleet-col.is-projection { flex: 1; border-right: none; }
.fleet-col-head {
  padding: 8px 12px; font-size: 11px; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fleet-scroll { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.fleet-scroll.is-projection { padding: 14px 16px; }
.fleet-row {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer; font: inherit;
}
.fleet-row:hover { background: var(--dsw-alias-bg-layer-2, #f0f0f0); }
.fleet-row.is-active { background: var(--dsw-alias-bg-layer-2, #eef2ff); border-color: var(--dsw-alias-border-l2, #d8def7); }
.fleet-row-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.fleet-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-row-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #c4c4c4); flex: 0 0 auto; }
.fleet-dot.is-online { background: var(--dsw-alias-state-success-primary, #22a06b); }
.fleet-dot.is-bad { background: var(--dsw-alias-state-error-primary, #d64545); }
.fleet-session {
  display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left;
  padding: 8px 9px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer; font: inherit;
}
.fleet-session:hover { background: var(--dsw-alias-bg-layer-1, #f5f5f5); }
.fleet-session.is-active { background: var(--dsw-alias-bg-layer-1, #eef2ff); border-color: var(--dsw-alias-border-l2, #d8def7); }
.fleet-session.is-archived .fleet-session-title { color: var(--dsw-alias-label-secondary, #8a8a8a); }
.fleet-group { margin-bottom: 2px; }
.fleet-group-head {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  padding: 5px 7px; border: 0; border-radius: 6px; cursor: pointer; font: inherit;
  font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); background: transparent;
}
.fleet-group-head:hover { background: var(--dsw-alias-bg-layer-1, #f5f5f5); }
.fleet-group-caret { width: 10px; flex: 0 0 auto; opacity: .8; }
.fleet-group-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-group-count {
  font-size: 10px; padding: 0 5px; border-radius: 999px; flex: 0 0 auto;
  background: var(--dsw-alias-bg-layer-2, #ececec); color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.fleet-group-body { padding: 2px 0 4px 6px; }
.fleet-group-empty { padding: 4px 10px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #a3a3a3); }
.fleet-tag.is-dim { background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); padding: 0; font-size: 10px; flex: 0 0 auto; }
.fleet-session-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fleet-session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-session-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-pulse {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  background: var(--dsw-alias-brand-primary, #4f6ef7);
  box-shadow: 0 0 0 0 var(--dsw-alias-brand-primary, #4f6ef7);
  animation: fleet-pulse 1.6s ease-out infinite;
}
.fleet-idle { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary, #c4c4c4); }
@keyframes fleet-pulse {
  0% { box-shadow: 0 0 0 0 rgba(79, 110, 247, .45); }
  70% { box-shadow: 0 0 0 6px rgba(79, 110, 247, 0); }
  100% { box-shadow: 0 0 0 0 rgba(79, 110, 247, 0); }
}
@media (prefers-reduced-motion: reduce) { .fleet-pulse { animation: none; } }
.fleet-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; flex: 0 0 auto; }
.fleet-badge.is-running { background: var(--dsw-alias-bg-layer-2, #e8f0ff); color: var(--dsw-alias-brand-primary, #3b5bdb); }
.fleet-proj-head {
  display: flex; align-items: baseline; gap: 8px; padding: 9px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.fleet-proj-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-proj-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-msg { margin: 0 0 14px; }
.fleet-msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.fleet-who { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.fleet-time { font-size: 10px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.fleet-bubble {
  white-space: pre-wrap; word-break: break-word; line-height: 1.55;
  padding: 9px 11px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #f7f7f8);
  border: 1px solid var(--dsw-alias-border-l1, #ececec);
}
.fleet-msg.is-user .fleet-bubble { background: var(--dsw-alias-bg-secondary, #eef2ff); border-color: var(--dsw-alias-border-secondary, #dde4fb); }
.fleet-call {
  display: flex; align-items: baseline; gap: 8px; margin: 6px 0;
  padding: 6px 9px; border-radius: 8px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-1, #f7f7f8);
  border: 1px dashed var(--dsw-alias-border-l2, #dcdcdc);
}
.fleet-call-name { font-weight: 600; color: var(--dsw-alias-state-info-primary, #2f6feb); flex: 0 0 auto; }
.fleet-call-args { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #5f5f5f); font-size: 11px; }
.fleet-tool { margin: 6px 0; font-size: 12px; }
.fleet-tool > summary { cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.fleet-tool.is-error > summary { color: var(--dsw-alias-state-error-primary, #d64545); }
.fleet-tool-name { font-weight: 600; }
.fleet-tool-body {
  margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; overflow: auto; max-height: 260px;
  background: var(--dsw-alias-bg-layer-2, #f2f2f4); white-space: pre-wrap; word-break: break-word; font-size: 11px;
}
.fleet-tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; }
.fleet-tag.is-warn { background: var(--dsw-alias-bg-layer-2, #fff1e6); color: var(--dsw-alias-state-warn-primary, #b25e09); }
.fleet-alert {
  margin: 8px 12px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, #fff5f5); color: var(--dsw-alias-state-error-primary, #c92a2a);
  border: 1px solid var(--dsw-alias-border-l1, #f3d4d4);
}
.fleet-empty { padding: 20px 14px; color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; line-height: 1.6; }
.fleet-foot-note { padding: 5px 12px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.fleet-composer {
  display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.fleet-input {
  flex: 1; min-width: 0; resize: vertical; min-height: 58px; max-height: 200px;
  padding: 8px 10px; border-radius: 8px; font: inherit; line-height: 1.5;
  color: inherit; background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #dcdcdc);
}
.fleet-input:focus { outline: 2px solid var(--dsw-alias-border-l2, #c9d3f7); outline-offset: 0; border-color: var(--dsw-alias-border-l2, #b9c6f5); }
.fleet-input:disabled { opacity: .6; }
.fleet-composer-side { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; flex: 0 0 auto; }
.fleet-btn {
  border-radius: 8px; padding: 6px 14px; font: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #dcdcdc);
  background: var(--dsw-alias-bg-base, #fff); color: inherit;
}
.fleet-btn:hover { background: var(--dsw-alias-bg-layer-2, #f2f2f2); }
.fleet-btn.is-primary {
  background: var(--dsw-alias-brand-primary, #4f6ef7); color: #fff; border-color: transparent;
}
.fleet-btn.is-primary:disabled { opacity: .5; cursor: default; }
.fleet-btn.is-ghost { background: transparent; }
.fleet-notice { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); max-width: 180px; text-align: right; }
.fleet-pair {
  flex: 0 0 auto; display: flex; flex-direction: column; gap: 5px;
  padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
}
.fleet-pair-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.fleet-secret {
  display: block; padding: 4px 6px; border-radius: 6px; font-size: 10px; line-height: 1.4;
  word-break: break-all; user-select: all; cursor: text;
  background: var(--dsw-alias-bg-layer-2, #f2f2f2); border: 1px solid var(--dsw-alias-border-l1, #e6e6e6);
}
.fleet-pair-row { display: flex; gap: 6px; align-items: center; }
.fleet-pair-hint { font-size: 10px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #8a8a8a); }
.fleet-input.is-compact { min-height: 0; height: 28px; padding: 4px 8px; font-size: 11px; resize: none; }
.fleet-btn.is-mini { padding: 3px 9px; font-size: 11px; border-radius: 6px; }
.fleet-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.fleet-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 999px;
  font-size: 10px; background: var(--dsw-alias-bg-layer-2, #f2f2f2);
  border: 1px solid var(--dsw-alias-border-l1, #e6e6e6); color: var(--dsw-alias-label-primary, #1f1f1f);
}
.fleet-chip-x {
  border: 0; background: transparent; cursor: pointer; font-size: 12px; line-height: 1;
  padding: 0 1px; color: var(--dsw-alias-label-secondary, #8a8a8a);
}
.fleet-chip-x:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
`;

    function ensureStyle() {
      try {
        if (document.getElementById("dsh-fleet-style")) return;
        const style = document.createElement("style");
        style.id = "dsh-fleet-style";
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch (err) {
        pluginCtx?.logger?.warn?.(`fleet client: 样式注入失败 ${String((err && err.message) || err)}`);
      }
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ensureStyle();
      ctx.effect?.(() => () => {
        try {
          document.getElementById("dsh-fleet-style")?.remove();
        } catch {
          /* ignore */
        }
      });
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: "编队" }, FleetIcon),
      );
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, FleetApp));
      ctx.logger?.info?.("fleet client: 已注册「编队」工作台");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
