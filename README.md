# dsh-plugin-fleet · 编队

在自己的多台电脑之间共享 DSH 的任务视图：在 A 机的侧栏点开「编队」，就能看到 B 机正在跑什么任务、把 B 机的对话投影过来，并继续往里发消息。

- 机器发现：复用 [dsh-plugin-mesh](https://www.npmjs.com/package/dsh-plugin-mesh) 的局域网 / tailnet 列表；没装也能用「手工添加机器」直接填 IP。
- 任务总览：每台机器上所有会话（标题、是否在跑、最后更新时间、工作目录、是不是子代理）。
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

## 两台机器配对（三选一）

1. **同一个 DeepSeek 账号**（最省事）：两台机器都登录同一个 DeepSeek 账号，密钥由账号 userId 派生，自动一致。
2. **面板里复制密钥**：A 机「编队 → 两端密钥 → 随机生成」，把那一串填到 B 机的同一输入框，两边点保存。
3. **配置里写死**：两台机器的 `cordis.patch.yml` 里 `config.secret` 填同一个字符串（≥12 字符）。

配对成功后，双方的 `hello` 会互相返回 200，机器列表里出现对方；密钥不一致时对端返回 401，插件会提示「两端共享密钥不一致」。

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
- 密钥优先级：`config.secret` > 面板保存的 `sharedSecret` > 账号 userId 派生 > 本机随机。
  最后一种只适合本机自测——两台机器各随机一份，必然 401。

## 自测脚本

```powershell
node _selftest-client.mjs   # 浏览器 bundle：插槽注册 + 首屏渲染
node _selftest-remote.mjs   # 远程链路：假对端 → 发现 / 列表 / 投影 / 发消息 / 移除
```

`_selftest-remote.mjs` 会在 `127.0.0.2:45941` 起一个假对端，用本机真实数据回放，验证完自动移除，不改动真实配置。

## 已知边界

- 投影是**只读镜像 + 发消息**：不转发审批、不打断、不换模型。
- 大历史只回最后 400 条（`truncated: true`），继续往上翻的能力还没做。
- 只有文本进投影：图片 / 附件只显示占位，不能点开。
