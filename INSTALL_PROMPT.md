# 给另一台 DSH 的安装 prompt

把下面整段复制给目标机器上的 DSH agent。

---

## 任务：给这台 DSH 安装 `dsh-everos-memory` 插件

这是一个 DSH bundle 插件，做两件事：

1. 会话静默 5 分钟后，把这段对话写到 EverOS 记忆服务（`add` + `flush`）；
2. 用户提问时检索相关记忆（相关性 ≥ 0.3），作为一段带边界标记的上下文注入当前轮。

**召回是 fail-soft 的**：2 秒超时、失败静默，任何异常都不会影响这一轮对话。

仓库：<https://github.com/DaneelOlivaw1/dsh-everos-memory>（public，版本 `v0.2.0`）

### 步骤

**1. 定位 profile**

```bash
echo "${DSH_HOME:-$HOME/.dsh}"
ls "$HOME/.dsh/profiles"        # 默认 profile 通常是 web
```

下文用 `<profile>` 指代目标 profile 名。

**2. 备份（必须）**

```bash
cd "$HOME/.dsh/profiles/<profile>"
cp package.json "package.json.bak-everos-$(date +%Y%m%d%H%M)"
cp cordis.patch.yml "cordis.patch.yml.bak-everos-$(date +%Y%m%d%H%M)"
```

**3. 安装依赖**

```bash
cd "$HOME/.dsh/profiles/<profile>"
pnpm add github:DaneelOlivaw1/dsh-everos-memory#v0.2.0
```

没有 pnpm 就先装：`npm i -g pnpm`。装完确认模块能解析：

```bash
node -e "import('dsh-everos-memory').then(m=>console.log('ok',m.name))"
```

**4. 加进 bundles**

编辑 `$HOME/.dsh/profiles/<profile>/package.json`，在 `dsh.profile.bundles` 数组末尾追加：

```json
"dsh-everos-memory"
```

**5. 写配置**

在 `$HOME/.dsh/profiles/<profile>/cordis.patch.yml` **末尾追加**（注意是 YAML 数组的一项，缩进两级）：

```yaml
- id: everos-memory
  config:
    baseUrl: https://memory.mergio.app
    apiKey: <EVEROS_TOKEN>
    userId: daneel
    idleSeconds: 300
    minMessages: 1
    recall: true
    recallTopK: 3
    recallMinScore: 0.3
    recallTimeoutMs: 2000
```

`<EVEROS_TOKEN>` 向用户索取（这是**网关 token**，不是模型 key）。如果不想写进 YAML，也可以留空并改用环境变量 `EVEROS_API_KEY` / `EVEROS_BASE_URL`。

`userId` 必须与已有机器一致，否则不会共享同一份记忆。

**6. 重启**

服务端插件**不支持热加载**，必须重启宿主进程。macOS 上如果是 launchd 托管：

```bash
launchctl kickstart -k "gui/$(id -u)/app.mergio.dsh"
```

否则让用户手动重启其 DSH 进程。

**7. 验证（缺一不可）**

```bash
# a) 挂载日志：应看到 ready 行，且没有 TypeError
tail -5 "$HOME/.dsh/everos-memory.log"

# b) 端口活着
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
```

c) 让用户在会话里敲 `/everos`，应显示端点、归属、缓冲条数。
d) 用户随便说一句，再敲 `/everos flush`，应返回 `EverOS: flushed`。
e) 查线上是否落库：

```bash
curl -s -X POST https://memory.mergio.app/api/v2/memory/search \
  -H "Authorization: Bearer <EVEROS_TOKEN>" -H 'content-type: application/json' \
  -d '{"user_id":"daneel","query":"<刚才那句话里的关键词>","method":"hybrid","top_k":3}'
```

### 已知坑（照着避）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/everos` 不存在 | 插件在挂载时抛异常，命令没注册上 | 看 `everos-memory.log`；`config` 字段是 `.volatile()` 的引用对象，**不能当字符串直接用**（插件内部已用 `read()` 解包） |
| 有事件但从不写入 | `minMessages` 设成 2 | DSH 的助手消息在**整轮结束**才提交，静默时缓冲通常只有 1 条。保持 `minMessages: 1` |
| 改了配置没反应 | 服务端插件不热加载 | 重启宿主 |
| `Could not resolve host` | macOS 负缓存 | `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` |

### 不要做的事

- 不要动其他插件的 bundle 顺序
- 不要改 `~/.dsh/profiles/<profile>/cordis.yml`（它是空数组，只由 patch 层组合）
- 不要把 token 提交进任何仓库
