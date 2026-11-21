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
pnpm add github:DaneelOlivaw1/dsh-everos-memory#v0.3.0
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

## 何时调用 LLM（v0.4）

**默认只在会话结束时抽取一次**：

| 时机 | 是否调 LLM | 说明 |
| --- | --- | --- |
| 用户发一条消息 | ❌ | 只有 recall 检索（embedding，不是 LLM） |
| 聊天过程中停顿 | ❌ | `flushOnIdle: false` 时不触发 |
| 会话被销毁（`session/disposed`） | ✅ | 一次抽取，整段对话 |
| 会话极久未销毁 | ✅ | `safeIdleSeconds` 安全网（默认 30 分钟），设 `0` 关闭 |
| 手动 `/everos flush` | ✅ | 你说了算 |

想让它在每次静默后都写（v0.3 的行为）：`flushOnIdle: true`。

**并发**由服务端队列约束：写入走 `async_mode`，`[memorize.async_queue] max_concurrency = 1`
时全局串行。同步 `/flush` **不受该限制**——这点实测确认过，所以 `asyncWrite` 默认开启。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `flushOnIdle` | `false` | 静默后是否抽取 |
| `safeIdleSeconds` | `1800` | `flushOnIdle:false` 时的兜底窗口，`0` 关闭 |
| `asyncWrite` | `true` | 走服务端队列，接受其并发上限 |
| `maxConcurrentWrites` | `1` | 本机同时写几个（与队列互为保险） |
| `maxBatchMessages` | `60` | 每次 `/add` 最多几条消息；整场对话一次性提交会超时失败 |

## 只记真实发言（v0.4.2）

DSH 会以**用户角色**注入自己的消息（时间采样 `source.kind = "time-context"`、本插件的召回提示
`everos-memory`）。它们都不是你说的话，却会被当成用户发言写进记忆，产出一堆
"daneel 注明浏览器时区为 Asia/Shanghai" 式的噪音。

现在只收 `source.kind` 缺省或等于 `user` 的消息，其余跳过并记一行审计。

## 项目分区（v0.3）

EverOS 的 `app_id` / `project_id` 在磁盘层隔离记忆。插件默认**按会话的工作目录派生 `project_id`**：

```
/Users/daneel/project/everos-memory-deploy  ->  project_id = everos-memory-deploy
```

规则：
- 取 cwd 的目录名，转小写，非法字符折成 `-`，截断 64 字符——满足 EverOS 的 `^[a-zA-Z0-9_.-]+$`
- 拿不到 cwd 时回落到配置里的 `projectId`（默认 `default`）

写入落在 `<app>/<project>/users/<user>/`，检索时**项目内 + 全局两个作用域合并**：

1. 先搜当前 `project_id`
2. 再搜配置里的回落 `project_id`（跨项目通用事实）
3. 按 `id` 去重、按分数排序、截到 `recallTopK`

所以你在 A 项目里聊的构建命令，只会在 A 项目里被召回；而"我喜欢 vim 键位"这种通用偏好，任何项目里都能召回。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `projectFromCwd` | `true` | 用 cwd 派生 project_id；关掉则全用 `projectId` |
| `recallGlobal` | `true` | 召回时是否并查回落作用域 |

> 历史记忆（v0.3 之前在 `default` 作用域里写的）不会自动迁移，它们作为"全局记忆"继续可被召回。

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
