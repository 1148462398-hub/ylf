# dsh-plugin-fleet · 编队

在自己的多台电脑之间共享 DSH 的任务视图：在 A 机的侧栏点开「编队」，就能看到 B 机正在跑什么任务、把 B 机的对话投影过来，并继续往里发消息。

- 机器发现：复用 [dsh-plugin-mesh](https://www.npmjs.com/package/dsh-plugin-mesh) 的局域网 / tailnet 列表；没装也能用「手工添加机器」直接填 IP。
- 任务总览：每台机器上所有会话（标题、是否在跑、最后更新时间、工作目录、是不是子代理）。
- 任务分组：默认分「工作区任务 / 子智能体 / 空白会话 / 已归档」四组，
  工作区任务默认展开、其余默认折叠——子代理动辄几百条，不再把真正的活儿淹掉。
  选中折叠组里的任务会自动展开该组。
- 对话投影：把对方会话的 user / assistant / 工具调用 / 工具结果按顺序渲染，增量拉取，不重复、不整段重刷。
- 远程续聊：直接在投影下方输入框发消息，走对方机器的 `sessionController.prompt`，对方已有上下文继续用。

## 装

```powershell
# 在本插件目录的上一级执行
#   plugin_manager install_bundle  target = <本目录绝对路径>
```

或在任意 DSH 里：

```
plugin_manager(action="install_bundle", target="C:\path\to\dsh-plugin-fleet")
```

装完 DSH 会自动重启该 bundle，侧栏出现「编队」图标（order 60）。

从 npm / 插件市场装（发布后可用）：

```
plugin_manager(action="install_bundle", target="dsh-plugin-fleet")
```

依赖可选：装了 `dsh-plugin-mesh` 会自动发现机器；没装就用面板里的「手工添加机器」。

## 两台机器配对（三选一，也可同时生效）

1. **同一个 DeepSeek 账号**（最省事）：两台机器都登录同一个 DeepSeek 账号，密钥由账号 userId 派生，自动一致。
2. **面板里复制密钥**：A 机「编队 → 两端密钥 → 随机生成」，把那一串填到 B 机的同一输入框，两边点保存。
3. **配置里写死**：两台机器的 `cordis.patch.yml` 里 `config.secret` 填同一个字符串（≥12 字符）。

**这三种方式不是互斥的。** 插件在同一时刻认可一组密钥（`config` / `shared` / `account` / `account-legacy` / `local`），
入站校验和出站探测都会逐条尝试，任意一条对上就算配对成功：

- 你在面板里填过共享密钥之后，**同账号派生那条依然可用**——另一台只登录了同一个账号、什么都没配的机器照样能连上来。
- 反过来，只靠账号配对的两台机器，也可以随时再用共享密钥把第三台不同账号的机器拉进来。
- 面板头部会显示主密钥来源（「账号派生 / 面板共享 / 手写配置 / 本机随机」），
  并在同账号通道同时可用时额外标注「同账号直连同时可用」。

配对成功后，双方的 `hello` 会互相返回 200，机器列表里出现对方；所有密钥都不匹配时对端返回 401，插件会提示「两端共享密钥不一致」。

> 换过 DeepSeek 账号（userId 变了）后，账号派生这把钥匙会跟着变，另一台机器需要重新登录同账号，或改用共享密钥配对。

## 网络

| 场景 | 做法 |
| --- | --- |
| 同一局域网 | mesh 组播自动发现，什么都不用配 |
| 组播被路由器挡住 | 面板「手工添加机器」填 `192.168.1.5`（端口默认 45940） |
| 跨公网 | 用 Tailscale / cpolar 之类打通二层，再填对方的 tailnet IP；或把 45940 端口映射出去（**必须**先设好共享密钥） |

对端端口固定是 `config.port`（默认 **45940**），只服务 `/fleet/v1/*`；UI 接口 `/fleet/api/*` 挂在 DSH 自己的 web 端口上，浏览器同源访问，不额外开端口。

## 接口（给排查用）

对端（Bearer `Authorization`，密钥见上）：

```
GET  /fleet/v1/hello        # 机器名 / 账号 / 会话数 / 运行中数量
GET  /fleet/v1/sessions     # 全部会话
GET  /fleet/v1/transcript?sessionId=...&afterSeq=0
POST /fleet/v1/prompt       # {sessionId, text, mode:'queue'|'steer'}
```

UI（同源，无鉴权，只有本机浏览器能访问）：

```
GET  /fleet/api/overview
GET  /fleet/api/sessions?target=self|<peerKey>
GET  /fleet/api/transcript?target=...&sessionId=...&afterSeq=...
POST /fleet/api/prompt      # {target, sessionId, text, mode}
POST /fleet/api/secret       {secret}          # 空串 = 清掉共享密钥
POST /fleet/api/secret/generate
POST /fleet/api/peers/add    {entry:"192.168.1.5:45940"}
POST /fleet/api/peers/remove {entry:"192.168.1.5"}
GET  /fleet/api/debug
```

## 状态与文件

- `~/.dsh/fleet/state.json`（0600）：`instanceId`、`localSecret`、`sharedSecret`、`extraPeers`。
- 密钥**同时认可一组**，按优先级排列：`config.secret` > 面板保存的 `sharedSecret` > 账号 userId 派生（新旧两种前缀）> 本机随机。
  入站 `authOk` 与出站 `callRemote` 都遍历整张表，任意一条命中即通过；第一项是该机的「主密钥」。
  本机随机那把只适合本机自测——两台机器各随机一份，必然 401。
- 指纹口径：面板/`/debug` 报的 `fingerprint` 是 `sha256(密钥)` 的前 8 位十六进制，**不是**密钥明文的前 8 位。

## 自测脚本

```powershell
node _selftest-client.mjs        # 浏览器 bundle：插槽注册 + 首屏渲染 + 四个分组
node _selftest-remote.mjs        # 远程链路：假对端 → 发现 / 列表 / 投影 / 发消息 / 移除
node _selftest-crosssecret.mjs   # 同账号零配置：假对端只认账号派生密钥，验证不靠共享密钥也能通
```

`_selftest-remote.mjs` 会在 `127.0.0.2:45941` 起一个假对端，用本机真实数据回放，验证完自动移除，不改动真实配置。
`_selftest-crosssecret.mjs` 用 `127.0.0.2:45943`，专门证明「本机存了共享密钥时，同账号通道仍然打得通」。

## 已知边界

- 投影是**只读镜像 + 发消息**：不转发审批、不打断、不换模型。
- 大历史只回最后 400 条（`truncated: true`），继续往上翻的能力还没做。
- 只有文本进投影：图片 / 附件只显示占位，不能点开。

## 更新日志

### 1.1.0

- **修复：「另一台登录同一个 DeepSeek 账号的电脑连不上这台」。**
  旧实现里 `currentSecret()` 只返回**一把**密钥，优先级是
  `config.secret > sharedSecret > 账号派生 > 本机随机`。只要在本机面板上填过一次共享密钥，
  账号派生那条分支就永远走不到，另一台同账号、没填过密钥的机器只能拿账号钥匙敲门 → 401。
  现在改为 `candidateSecrets()` 返回**整张候选表**，入站 `authOk`、出站 `callRemote`、
  探活 `computePeers` 三处都逐条尝试，命中后记录 `matchedSecretMode` 并在后续请求里沿用。
  同时保留旧前缀 `dsh-fleet/v1/` 的派生（`account-legacy`），兼容还没升级的对端。
- 面板密钥卡文案改为「同一 DeepSeek 账号的两台机器会自动互通，这一串只用于跨账号或不想依赖账号时的手工配对」，
  头部会标注主密钥来源，同账号通道同时可用时附「同账号直连同时可用」。
- `/fleet/api/debug` 增加 `secrets`（只报 mode + 指纹，不回显明文）与 `accountDerive`（salt / userId / 探测指纹）。
- 新增 `_selftest-crosssecret.mjs`。

### 1.0.1

- **修复：登录了账号仍显示「未登录 DeepSeek 账号」。**
  dsh 的账号服务 `deepseekAccount.getState()` 返回的是 `AccountView`——
  `{ status: "signed-out" | "credential-stored", links, attempt }`，
  其中**没有** `userId` / `signedIn` 字段。旧代码只认 `status === "signed-in"`，
  于是恒判为未登录，账号派生密钥那条路也永远走不到。
  现在按 `credential-stored`（以及 `attempt.phase === "succeeded"`）判定，
  昵称缺失时再调 `getProfile()` 补一次（3 秒超时，失败静默）。
