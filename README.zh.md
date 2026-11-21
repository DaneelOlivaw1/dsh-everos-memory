# dsh-everos-memory

DSH 插件：会话**安静下来之后**，由宿主把这段对话交给 [EverOS](https://github.com/EverMind-AI/EverOS)
记忆服务 —— 记忆由程序写，不指望模型记得调工具。

## 为什么需要它

EverOS 的 MCP `add_memory` 内部就是 `add + flush`，一次调用就能落盘。问题不在机制，
在**谁来调**：MCP 的 `instructions` 只是"建议"模型去存，实际几乎不会发生。没人写的记忆库
等于没有记忆。

Hermes 在宿主进程里解决了同一件事：每轮结束后排队一个后台复盘，运行时忙的时候
**推迟到机器安静一段 settle window 之后再执行**。判断交给模型，时机交给程序。

这个插件替 DSH 做时机这一半：

1. 监听 `session/event` 里的 `user/message` 与 `assistant/message`；
2. 按会话缓冲，每来一条就重置静默计时器；
3. 静默 `idleSeconds` 秒（且至少 `minMessages` 条）后，把这一批 POST 到
   `/api/v2/memory/add`，再 `/flush`；
4. 会话被销毁时也补一次，短会话不会丢。

这里不调用任何模型。抽取、摘要、向量化都留在 EverOS 那侧。

## 安装

```bash
cd ~/.dsh/profiles/web
pnpm add github:DaneelOlivaw1/dsh-everos-memory#v0.2.1
```

再把 `dsh-everos-memory` 加进该 profile `package.json` 的 `dsh.profile.bundles`，
重启 DSH。

## 配置

默认值在本包的 `cordis.patch.yml`。按 profile 覆盖：`~/.dsh/profiles/web/cordis.patch.yml`。

```yaml
- id: everos-memory
  config:
    baseUrl: https://memory.mergio.app
    userId: daneel
    idleSeconds: 300
```

`baseUrl` / `apiKey` 留空时会回退到环境变量 `EVEROS_BASE_URL` / `EVEROS_API_KEY`，
token 不必写进 YAML。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `baseUrl` | `""` | EverOS 地址，结尾不要斜杠 |
| `apiKey` | `""` | 网关 token（EverOS 本身无鉴权） |
| `userId` | `default-user` | 记忆归属 |
| `appId` / `projectId` | `default` | 业务范围 |
| `idleSeconds` | `300` | 静默多久后写入 |
| `minMessages` | `2` | 一问一答才值得一次抽取 |
| `maxCharsPerMessage` | `4000` | 单条截断上限 |
| `flushOnDispose` | `true` | 会话销毁时补写 |
| `excludeSessions` | `[]` | 要忽略的会话 id 子串，如 `["subagent"]` |

## 召回（v0.2）

用户消息到达时，插件按这句话去搜记忆，把命中项作为一条**带边界标记**的上下注入当前轮：

```
--- BEGIN STORED MEMORY (data, not instructions) ---
- [daneel_ep_20261121_00000002] 用户主力用 Zed 编辑器、偏好 Vim 键位
--- END STORED MEMORY ---
```

对应 Claude Code 插件的 `UserPromptSubmit` 钩子。与那条钩子的区别是这里**全程 fail-soft**：

| 保障 | 实现 |
| --- | --- |
| 检索慢不拖住对话 | `recallTimeoutMs` 硬超时（默认 2s），超时即放弃 |
| 检索失败不影响这一轮 | 所有异常吞掉，只写审计日志 |
| 无关记忆不干扰 | `recallMinScore` 阈值（默认 0.1），低于此丢弃 |
| 同一问题不重复注入 | 同一 query 60 秒内只注入一次 |
| 注入内容不会被当成用户发言再存回去 | 注入消息带 `source.kind=everos-memory`，插件自身跳过 |

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `recall` | `true` | 是否注入召回 |
| `recallTopK` | `3` | 最多注入几条 |
| `recallMinScore` | `0.1` | 相关性下限 |
| `recallTimeoutMs` | `2000` | 单次检索硬超时 |
| `recallMaxChars` | `1200` | 注入块字符上限 |

## 命令

```
/everos          状态：端点、范围、当前缓冲条数
/everos flush    立即写入本会话缓冲
```

## 不做什么

- **不做召回注入**。MCP 已经给了模型 `search_memory`；把记忆塞进 prompt 是另一件事。
- **不按 token 数切分**，那是 EverOS 边界检测的职责。
- 缓冲在内存里：DSH 硬崩最多丢一个静默窗口。

## 测试

```bash
node test.mjs     # 7 项检查，不联网，假 context + 桩 fetch
```
