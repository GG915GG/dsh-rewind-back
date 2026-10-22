# dsh-local-rewind

[English](README.md) | 中文

给 [DeepSeek Harness](https://deepseek-harness.github.io/) Web 用的本地**撤回 / 撤销**按钮。

鼠标移到任意一条消息上，点「撤回」，这条消息以及它之后的全部对话就会从聊天记录和模型可见上下文里一起消失——
不会在模型上下文里留下痕迹，也不会真正删掉底层 session 日志。

> 状态：实验性。基于 DSH `0.2.1-rc.2` 开发和测试。插件用到了 session/DOM 内部接口，DSH 升级后可能失效。

## 为什么

DSH 有压缩、分支和会话级操作，但没法快速收回一条说错的话以及它后面的全部内容。这个插件给每条消息加了一个按钮：

- 选中的消息和它之后的所有消息从聊天界面消失；
- 下一次请求时模型也看不到这些消息；
- 原话保留在命令回执里，可以复制重发；
- 底层日志仍然完整，事件没有被物理删除。

## 功能

- 在每条消息的复制/时间操作区旁注入「撤回」按钮（用户气泡和助手回合结尾都有）。
- 点击后撤回所选消息及其之后的全部消息。
- 用 surface replacement 截断模型上下文，撤回掉的消息不再计费。
- 命令回执和撤回标记本身不会进入模型上下文。
- 回执显示策略可选：`turn`（默认，只留一个回合）、`always`、`hidden`，见[配置](#配置)。
- 通过 session projection 恢复界面状态，刷新页面后被隐藏的消息仍然隐藏。
- 也支持命令：`/rewind <n>`（`1` = 最新一条用户消息）。

## 实现

**Host 半边**（`lib/index.js`）

- 注册 `/rewind` 命令。
- 追加一条空内容的 `system/message` 事件，带 `surfaceOp: { op: "replace", startSeq, endSeq }`，与 compaction
  使用同一套 surface replacement 机制。0.2.1 里 `assistant/message` 不允许携带 `sourceEventSeqs`，所以占位
  事件用 `system/message`；它内容为空，会被 `deriveEventMessage` 跳过，因此永远进不了模型上下文。消息必须
  带 producer-owned 的 `source.kind`（这里是 `"dsh-local-rewind"`）：session format v4 在加载历史时会拒绝
  `source.kind` 缺失、为空或等于 `"plugin"` 的消息。
- 把被隐藏的范围和回合记录在 `data.localRewind` 里，并通过 `localRewind` session projection 暴露给浏览器。

**浏览器半边**（`lib/client.js`）

- 用 `MutationObserver` 监听聊天区，注入按钮。
- 通过 `remote.commands.execute` 调用 host 命令（不额外开 HTTP 端点）。
- 读取 `localRewind` 投影，把命中的 flow 行（`[data-chat-anchor-key]`）和宿主明确记录的回合
  （`[data-chat-turn]`）设为 `display: none`。
- 按配置处理撤回回执：`command` 行里带撤回回执的，遇到更晚的用户行就隐藏（`turn`）、永远隐藏
  （`hidden`）或始终保留（`always`）。

只隐藏宿主明确记录的回合。**不要**用 `turn >= fromTurn` 隐藏整轮：turn 编号单调递增，这条规则会把撤回之后
新发的消息和助手回复也一起隐藏。

## 安装

要求：DSH Web `0.2.1-rc.2`（桌面版或 `dsh --profile web`），开发需要 Node.js 20+。

把仓库克隆到一个固定位置，然后链接进 DSH profile：

```powershell
git clone https://github.com/GG915GG/dsh-local-rewind.git C:\src\dsh-local-rewind

# Windows：在 profile 里建 junction
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-local-rewind" "C:\src\dsh-local-rewind"
```

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": {
    "dsh-local-rewind": "link:C:/src/dsh-local-rewind"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-local-rewind"
      ]
    }
  }
}
```

完全重启 DSH。Host 半边在启动时加载，浏览器半边由 web app 提供。

卸载：从 `dsh.profile.bundles` 和 `dependencies` 里删掉 `dsh-local-rewind`，然后重启 DSH。

## 用法

- 鼠标移到任意消息上，点「撤回」，撤回这条消息及其之后的全部对话。
- 或者输入命令：`/rewind 1`（最新一条用户消息）、`/rewind 3`。
- 命令回执会带上原话，方便复制重发；默认只保留到你发下一条消息为止。

被撤回的部分会从可见聊天记录和模型上下文里消失。因为 session 日志是 append-only 的，事件仍然保存在磁盘上；
如果确实想恢复，可以在 DSH 完全退出、做好备份之后，离线删除日志里的 replacement 事件。

## 配置

`> rewind · 已撤回 …` 这条命令回执支持三种显示策略：

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- id: local-rewind
  config:
    receipt: turn   # turn（默认）| always | hidden
```

- `turn` — 保留到下一个用户回合开始，然后隐藏（默认）；
- `always` — 一直保留在聊天记录里；
- `hidden` — 从不显示（原话仍然可以从 session 日志里找回）。

策略通过 `localRewind` session projection 传给浏览器。profile 开启 HMR 时，改完会在下一次重组时生效；
否则需要重启 DSH。

## 兼容性与已知限制

- 只针对 `0.2.1-rc.2` 构建，manifest 里精确声明兼容版本；其它版本未测试。
- 按钮依赖 DSH 当前的 DOM 结构（`div[data-clock]`、气泡层级）。前端改版会导致注入失效，需要同步修改
  `lib/client.js` 里的选择器。
- 浏览器通过消息文本的 base64 前缀调用 host 命令，重名消息可能命中较新的一条。
- 回合还在跑时不允许撤回，等回合结束再点。
- 目前没有内置的「撤销撤回」UI。

## 开发

没有构建步骤。`lib/client.js` 就是 DSH 客户端模块加载器直接使用的浏览器 bundle。

```bash
node test/run.mjs
# 或
npm test
```

测试不依赖 DSH 安装：`test/host.test.mjs` 使用伪造的 session，`test/client.test.cjs` 用最小伪造 DOM
运行客户端 bundle。

## 许可证

MIT，见 [LICENSE](LICENSE)。

与 DeepSeek 官方无关。
