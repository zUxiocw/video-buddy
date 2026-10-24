# 上头了喵喵 · UI v1 设计说明

- 版本：`1.0.0`
- 日期：`2026-10-24`
- 状态：**用户已确认效果，冻结为 v1**
- 来源：`D:\code\video-buddy\site`
- 归档：`design/ui-v1/` + `design/shangtou-meowmeow-ui-v1.zip`
- 边界：这是独立静态 UI，不改 `extension/`、`server/` 或现有插件运行时。

## 1. 产品定位

**抖音网页里的 AI 陪刷搭子。**

不是视频总结，不是客服，不是桌面宠物。它是在用户刷抖音的当下，主动接一句话、陪聊两句、用 9 种情绪表达态度的浏览器悬浮角色。

主文案：

> 刷到上头，它陪你接一句。

产品原则：

> 它不是来替你省时间的，是来陪你浪费一点时间的。

## 2. 页面结构

| 页面 | 文件 | 目标 |
|---|---|---|
| 首页 | `index.html` | 解释定位、9 情绪、API 接入、隐私、FAQ |
| 交互 Demo | `demo.html` | 用假抖音页面测试悬浮球、聊天、换视频、情绪切换 |
| API 配置 | `setup.html` | 三步向导：连接模型 / 调教性格 / 安装扩展 |
| 安装说明 | `install.html` | Chrome / Edge 加载步骤、发布状态、常见卡点 |

快捷状态：

- `demo.html?open=1` 直接打开聊天面板
- `setup.html?step=2` 直接看性格设置
- `setup.html?step=3` 直接看安装步骤

## 3. 设计语言

### 颜色

| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `#f7f1e8` | 页面奶油底色 |
| `--paper-2` | `#fffaf3` | 卡片底色 |
| `--ink` | `#17131f` | 主文字 / 深色面板 |
| `--ink-2` | `#241b38` | 深色层 |
| `--lav` | `#7c5cff` | 主强调色 |
| `--lav-2` | `#b58cff` | 浅强调 |
| `--pink` | `#ffd9e4` | 角色底色 / 柔和强调 |
| `--peach` | `#ffb7a5` | 暖色强调 |
| `--blue` | `#b9d7ff` | 冷色辅助 |
| `--mint` | `#62d29b` | 成功 / 在线 |
| `--muted` | `#665c73` | 辅助文字 |

### 字体

- 正文：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`
- 展示标题：同字体，`font-weight: 900`，负字距，`clamp()` 控制大小
- 代码：`ui-monospace, SFMono-Regular, Consolas, monospace`

### 形状与层级

- 卡片圆角：18–38px
- 按钮：胶囊形，最小高度 46px
- 主按钮：深色底 + 奶油字；次按钮：描边
- 阴影：低对比、扩散型，不使用硬阴影
- 插件 Demo 使用手机外框 + 深色聊天面板，保持和真实抖音悬浮球一致的观感

## 4. 组件

### 导航

- 左侧：圆形角色图标 + 品牌名
- 中间：怎么用 / 9 种情绪 / 在线试玩 / 安装
- 右侧：接入我的 API
- 移动端：导航换行成可横向滚动的紧凑行

### 情绪卡

- 9 个情绪：委屈 / 开心 / 嫌弃 / 生气 / 大笑 / 兴奋 / 打招呼 / 疑惑 / 震惊
- 每张卡：128px 角色图 + 中文标签 + 一句示例台词
- 颜色只做轻量描边/光晕，不覆盖角色原图

### 交互 Demo

- 手机模拟器内是假抖音视频：画面、文案、右侧互动按钮、底部进度条
- 悬浮球点击打开聊天面板
- 聊天支持：Enter 发送、Shift+Enter 换行、Esc 关闭
- 9 个情绪按钮实时切换头像和示例
- “换一条视频”会更新画面/文案，并在自动搭话开启时显示气泡 + 追加一条 AI 消息
- 所有回复是本地写死的，不调用真实模型

### API 配置向导

三步：

1. **连接模型**：DeepSeek / OpenAI / 自定义；Base URL、API Key、模型名；测试连接
2. **调教性格**：直白朋友 / 温柔搭子 / 毒舌吐槽；回复长度；主动搭话；截图开关
3. **安装扩展**：四步安装说明 + 保存配置

演示页的“测试连接”只做格式校验，不发送密钥。正式扩展应由 background service worker 请求用户配置的 OpenAI-compatible API。

### 下载说明

- 首页 / 安装页的下载 CTA 打开 `<dialog>` 说明
- 当前不发未完成安装包，说明“安装包即将开放”
- 文案明确：正式包会在“自带 API Key”接入完成后发布

## 5. 文案规则

- 用具体动作和画面，不写“智能助手”“赋能”这类空词
- 先给判断，再补一句具体观察
- 猫娘口吻只加一个“喵”，不连续堆语气词
- 不把情绪名直接写进回复，让图标和语气表达
- 不在首屏写“永久免费”“最强”等不可验证承诺

## 6. 可访问性

- 每页有 skip link 和 `main` landmark
- 全局 `:focus-visible` 轮廓
- 按钮/输入最小触控高度约 44–46px
- 表单使用显式 label，不依赖 placeholder
- 聊天消息、连接状态、情绪切换使用 `aria-live`
- 关闭的聊天面板使用 `inert` + `aria-hidden="true"`，不进入键盘顺序
- 支持 `prefers-reduced-motion`
- 移动端用 390px 视口验证，导航和 hero 不横向溢出

## 7. 冻结与变更

- 本目录是 v1 冻结快照，不要直接改它。
- 后续设计改动在 `site/` 进行；确认后另存 `design/ui-v2/`。
- 代码层面的视觉 token 以 `styles.css` 顶部变量为准。
- Claude Code 对接前先读本文件和 `HANDOFF.md`；未获用户明确同意，不要开始对接。

## 8. 截图

- `screenshots/index.png` — 首页桌面
- `screenshots/demo.png` — 聊天面板打开的 Demo
- `screenshots/setup.png` — API 配置第一步
- `screenshots/install.png` — 安装页
- `screenshots/mobile.png` — 390px 移动端首页
