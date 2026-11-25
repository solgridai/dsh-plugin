# Solgrid

在 DeepSeek Harness 中直接发现并调用 [Solgrid](https://solgrid.ai) 的第三方工具与创意 Skill——无需单独安装 CLI 或配置 Node.js，开箱即用。

## 你能做什么

- **社交媒体与结构化数据**：查询 Twitter/X、Instagram、LinkedIn 等平台的用户资料、帖文与检索结果。
- **图片、视频与音频生成**：调用主流生成与处理模型，安全上传本地素材，并将产出直接保存到当前工作区。
- **SkillHub 创意工作流**：浏览、下载并运行社区精选的创作 Skill。

## 开始使用

无需手动配置 API Key。安装并启用插件后，直接在对话中提需求即可：

> 「用 Solgrid 找一个获取 Twitter 用户信息的工具，先查一下价格。」
>
> 「用 Solgrid 生成一张夕阳下的赛博朋克小猫图片，保存为 `cat.png`。」
>
> 「用 Solgrid 看看 SkillHub 上最热门的 5 个 Skill。」

首次使用时，Agent 会给出一个 Solgrid 浏览器授权链接和短码。在浏览器中打开并确认登录，API Key 会自动保存到本地，Agent 随后继续完成你的任务——整个过程 Key 不会经过聊天记录。

## 费用与隐私说明

- 搜索工具、查看参数和单价、浏览 SkillHub 均免费。
- 运行付费工具将按次从你的 [Solgrid](https://solgrid.ai) 钱包扣除 **Spark**（1 USD = 100 Spark），Agent 会先查价再执行。
- 上传的本地文件默认私有，仅通过 24 小时有效的临时签名 URL 供工具读取。
- 凭证保存在本机 `~/.config/solgrid/cli/`，如你同时在终端使用独立版 `solgrid` CLI，登录态自动互通。

## 超时与计费安全

付费 run 提交后即使本地 CLI 被停止，也会继续在 Solgrid 侧运行并计费，因此插件不会让超时静默丢失一次 run。它使用捆绑的 `@solgridai/cli` 0.7.0+ 的包装器协议：

- 未显式传 `--idempotency-key` 的 `run` 使用插件通过 `SOLGRID_IDEMPOTENCY_KEY` 预置的 key；显式参数始终优先，agent 自己的 key 保持原有重试语义。
- 提交前，CLI 会向 stderr 写一行 `solgrid: idempotencyKey=<key> wait=<秒>`。这一行就是恢复锚点：stderr 不受缓冲，即使 SIGKILL 也会留存，且记录的是 CLI 自己解析出的最终 key——无论它来自显式参数、环境变量还是自动生成，都精确无误。
- 插件收到该行后会把自身超时对齐到报告的等待预算，agent 读到的是 CLI 原生的 `WAIT_TIMEOUT`（含 run ID、key 和后续命令）。若插件仍不得不杀掉进程，提示里给出报告的 key：按它执行 `runs get --idempotency-key <key> --wait` 即可取回已完成的 run，或用同一 key 重跑同一命令——Solgrid 会返回已有 run，不会二次扣费。
- 其余超时（`defaultTimeoutMs`、`timeoutMs`）仅是防挂死安全网（如大文件下载），不是对进行中 run 的截止时间。
