# @solgridai/dsh-plugin

[English](README.md) | 中文

[Solgrid](https://solgrid.ai) 的官方 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) 插件包。

插件内嵌 [`@solgridai/cli`](https://www.npmjs.com/package/@solgridai/cli)，自动注册 `solgrid-cli` Skill 和 `solgrid` 工具。无论是 DSH Web 还是官方 Desktop 桌面端用户，安装后即可直接发现、查价并调用 Solgrid 工具与 SkillHub 创意工作流，无需全局安装 CLI 或单独配置 Node.js。

## 安装

### 在 DSH Web / Desktop 界面安装

1. 打开侧边栏 **Plugins（插件）** 页面。
2. 点击 **安装**，输入包名：
   ```text
   @solgridai/dsh-plugin
   ```
3. 确认安装即可热加载生效。

### 通过 DSH CLI 安装

```sh
dsh plugin --profile web add @solgridai/dsh-plugin
```

也支持直接从 GitHub 安装（纯 ESM，无需构建脚本审批）：

```sh
dsh plugin --profile web add github:solgridai/dsh-plugin
```

## 使用示例

安装完成后，直接在对话中提需求即可：

- 「用 Solgrid 查一下我的钱包余额。」
- 「用 Solgrid 找一个获取 Twitter 用户资料的工具，看看价格。」
- 「用 Solgrid 生成一张夕阳下的赛博朋克小猫图片，保存为 `cat.png`。」

如果尚未登录，Agent 会自动发起设备码登录流程（`solgrid login`），非阻塞返回浏览器授权链接与短码；你在浏览器确认后，API Key 自动保存到本地 `~/.config/solgrid/cli/`（与终端独立版 `solgrid` CLI 互通），随后自动继续原任务。

## 可选配置

默认情况下，API 地址与语言完全遵循 `@solgridai/cli` 自身逻辑（默认连接生产环境 `https://api.solgrid.ai`，可通过环境变量 `SOLGRID_API_BASE_URL` / `SOLGRID_LANG` 覆盖）。

如需按 profile 覆盖，可在 `~/.dsh/profiles/<name>/cordis.patch.yml` 中配置：

```yaml
- id: solgrid
  config:
    apiBaseUrl: https://api.solgrid.ai   # 可选：覆盖 API 地址
    lang: zh                             # 可选："en" 或 "zh"
    defaultTimeoutMs: 300000             # 可选：默认命令超时毫秒数（默认 300000）
    maxOutputChars: 200000               # 可选：stdout/stderr 截断上限（默认 200000）
```

## 开发与检查

```sh
npm install
npm run check      # TypeScript checkJs 类型检查 + node:test 单元测试
```

本地调试安装到 DSH：

```sh
dsh plugin --profile web add .
```

## 协议

[MIT](LICENSE)
