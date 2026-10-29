// 离线自测：用桩 React 把 client.js 跑起来，检查注册与首屏渲染不崩。
// 用途：改完 client.js 后 `node _selftest-client.mjs`，比反复刷新浏览器快得多。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'client.js'), 'utf8');

const problems = [];
const hooks = { effects: 0, states: 0 };

// 简易状态存储：让 useState 跨渲染保留值，这样第二轮渲染能拿到 fetch 回来的数据，
// 从而真正跑到 SessionRow / GroupSection（否则永远是空列表，等于没测）。
const stateStore = {};
let stateIndex = 0;
const resetStateIndex = () => {
  stateIndex = 0;
};

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: 'Fragment',
  useState: (init) => {
    hooks.states += 1;
    const index = stateIndex++;
    if (!(index in stateStore)) stateStore[index] = typeof init === 'function' ? init() : init;
    const setter = (next) => {
      stateStore[index] = typeof next === 'function' ? next(stateStore[index]) : next;
    };
    return [stateStore[index], setter];
  },
  useRef: (init) => {
    const index = stateIndex++;
    if (!(index in stateStore)) stateStore[index] = { current: init };
    return stateStore[index];
  },
  useEffect: (fn, deps) => {
    hooks.effects += 1;
    const index = stateIndex++;
    const key = `effect:${index}`;
    const first = !(key in stateStore);
    const changed = first || JSON.stringify(stateStore[key]) !== JSON.stringify(deps ?? null);
    stateStore[key] = deps ?? null;
    if (!changed) return;
    try {
      const cleanup = fn();
      if (typeof cleanup === 'function') stateStore[`cleanup:${index}`] = cleanup;
    } catch (err) {
      problems.push(`useEffect 抛错: ${err?.message ?? err}`);
    }
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

const node = (tag, extra = {}) => ({
  tagName: tag,
  style: {},
  children: [],
  setAttribute() {},
  appendChild(child) {
    this.children.push(child);
  },
  remove() {},
  ...extra,
});

const documentStub = {
  getElementById: () => null,
  createElement: (tag) => node(tag),
  head: node('head'),
  body: node('body'),
};

const overview = {
  ok: true,
  self: { key: 'self', machine: 'DESKTOP-TEST', hosts: ['127.0.0.1'], online: true, reachable: true },
  peers: [
    { key: 'self', machine: 'DESKTOP-TEST', hosts: ['127.0.0.1'], online: true, reachable: true, self: true, account: { name: '测试账号' }, sessionCount: 12, runningCount: 2 },
    { key: 'abc123', machine: 'LAPTOP-NODE', hosts: ['192.168.1.20'], online: true, reachable: true, account: { name: '测试账号' }, sessionCount: 5, runningCount: 1 },
  ],
  secret: { mode: 'local', fingerprint: 'deadbeef' },
  notes: [],
};

const sessions = {
  ok: true,
  machine: 'DESKTOP-TEST',
  sessions: [
    { sessionId: 'session-a', title: '正在跑的任务', running: true, updatedAt: Date.now(), cwd: 'C:\\work', group: 'workspace', archived: false },
    { sessionId: 'session-b', title: '闲着的历史会话', running: false, updatedAt: Date.now() - 60000, cwd: 'C:\\work', group: 'workspace', archived: false },
    { sessionId: 'session-c', title: '子代理接线条', running: false, updatedAt: Date.now() - 120000, cwd: 'C:\\work', group: 'subagent', origin: 'subagent', parentSessionId: 'session-a', archived: false },
    { sessionId: 'session-d', title: '', running: false, updatedAt: Date.now() - 180000, cwd: 'C:\\work', group: 'blank', blank: true, archived: false },
    { sessionId: 'session-e', title: '归档过的老会话', running: false, updatedAt: Date.now() - 240000, cwd: 'C:\\work', group: 'archived', archived: true },
  ],
  counts: { workspace: 2, subagent: 1, blank: 1, archived: 1 },
  notes: [],
};

const transcript = {
  ok: true,
  sessionId: 'session-a',
  title: '正在跑的任务',
  cwd: 'C:\\work',
  cursor: 12,
  reset: false,
  truncated: false,
  items: [
    { seq: 1, kind: 'user', text: '帮我看下这个报错' },
    { seq: 2, kind: 'assistant', text: '这是原因。', calls: [{ name: 'pwsh', args: '{"command":"ls"}' }] },
    { seq: 3, kind: 'tool-result', text: 'file1.txt', name: 'pwsh' },
  ],
};

const fetchStub = async (url) => {
  const target = String(url);
  const body = target.includes('/transcript')
    ? transcript
    : target.includes('/sessions')
      ? sessions
      : target.includes('/overview')
        ? overview
        : { ok: true };
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

let registered = null;
const windowStub = {
  __ModuleLoader__: {
    load: (definition) => {
      registered = definition;
    },
  },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
};

const run = new Function(
  'window',
  'document',
  'fetch',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'console',
  code,
);
run(windowStub, documentStub, fetchStub, setTimeout, clearTimeout, () => 0, () => {}, console);

if (!registered) {
  console.error('❌ 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}
console.log(`✓ factory id = ${registered.id}`);

const mod = registered.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`意外的 require: ${name}`);
});

if (typeof mod.apply !== 'function') problems.push('模块没有导出 apply');

const registrations = [];
const ctx = {
  logger: { info: () => {}, warn: (msg) => problems.push(`warn: ${msg}`) },
  effect: (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanup();
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (registration, component) => {
      registrations.push({ name: registration.name, registration, component });
    },
  },
};

mod.apply(ctx);
console.log(`✓ inject = ${JSON.stringify(mod.inject)}`);
for (const item of registrations) {
  console.log(`✓ slot ${item.name} :: ${JSON.stringify(item.registration)}`);
  if (typeof item.component !== 'function') problems.push(`slot ${item.name} 的组件不是函数`);
}

// 递归渲染函数组件，检查首屏不崩
let rendered = 0;
const collected = [];
function walk(element, depth) {
  if (element == null || depth > 10) return;
  if (Array.isArray(element)) {
    for (const child of element) walk(child, depth);
    return;
  }
  if (typeof element !== 'object') return;
  if (typeof element.type === 'function') {
    rendered += 1;
    let output;
    try {
      output = element.type(element.props ?? {});
    } catch (err) {
      problems.push(`组件 ${element.type.name || '?'} 渲染抛错: ${err?.message ?? err}`);
      return;
    }
    collected.push(output);
    walk(output, depth + 1);
    return;
  }
  if (element.children) for (const child of element.children) walk(child, depth + 1);
  const props = element.props ?? {};
  for (const key of ['children', 'header', 'footer', 'icon', 'title', 'content', 'aside', 'empty']) {
    if (props[key] !== undefined) walk(props[key], depth + 1);
  }
}

const mainApp = registrations.find((item) => item.name === 'main');

/** 走一遍渲染；每次重置 hook 下标，让 stateStore 里的值被同一位置复用 */
function renderPass() {
  resetStateIndex();
  rendered = 0;
  collected.length = 0;
  if (mainApp) walk({ type: mainApp.component, props: {} }, 0);
  return collected.slice();
}

renderPass();

const iconReg = registrations.find((item) => item.name === 'sidebar.panellist');
if (iconReg) walk(iconReg.component({ size: 18 }), 0);

console.log(`✓ 组件渲染 ${rendered} 个 / 状态钩子 ${hooks.states} 个 / 副作用 ${hooks.effects} 个`);

// 等首轮 fetch（overview / sessions / transcript）落地
await new Promise((resolve) => setTimeout(resolve, 1200));

// 第二遍：此时 stateStore 里已经有 sessions，分组应真正渲染出来
renderPass();
console.log(`✓ 二次渲染 ${rendered} 个组件`);

// 把渲染树摊平成文本，检查四个分组标题都在
function flattenText(node, depth) {
  if (node == null || depth > 12) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((item) => flattenText(item, depth)).join(' ');
  if (typeof node !== 'object') return '';
  const bits = [flattenText(node.children, depth + 1)];
  const props = node.props ?? {};
  for (const key of ['children', 'header', 'footer', 'title', 'content', 'aside', 'empty']) {
    if (props[key] !== undefined) bits.push(flattenText(props[key], depth + 1));
  }
  return bits.join(' ');
}

const flat = collected.map((element) => flattenText(element, 0)).join(' ');
const expectedGroups = ['工作区任务', '子智能体', '空白会话', '已归档'];
for (const label of expectedGroups) {
  if (!flat.includes(label)) problems.push(`分组标题缺失：${label}`);
}
if (!flat.includes('正在跑的任务')) problems.push('工作区任务的会话没有渲染出来（默认分组应该展开）');
if (!flat.includes('已归档')) problems.push('已归档分组缺失');
// 折叠组默认不渲染会话行
if (flat.includes('子代理接线条')) problems.push('子智能体分组默认应折叠，却渲染了会话行');
if (problems.length === 0) console.log(`✓ 四个分组齐全，折叠态正确`);

if (problems.length > 0) {
  console.error('\n❌ 发现问题:');
  for (const item of problems) console.error('  - ' + item);
  process.exit(1);
}
console.log('\n✅ client 自测通过');
