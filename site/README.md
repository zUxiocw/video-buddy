# 喵喵陪你刷 · 公开版 UI（BYOK · 自带 API）

这是公开下载方向的前端原型，对应插件的 BYOK（Bring Your Own Key）方向：

- Chrome Manifest V3 + 原生 JS
- 用户自己开通 DeepSeek API，用自己的 Key
- Key 存在扩展的 `chrome.storage.local`，不写进网页
- 请求从浏览器扩展直接发往模型服务，不经过我们的服务器
- 不需要 Node.js / Fastify；原有本地服务模式保留给开发者

## 页面

- `index.html` — 产品首页：定位、双计时器 + 催促上限（首次报额度 / 1–10 分钟沉默催促 / 催满关页 / 到点关视频不可关闭）、9 种情绪、BYOK、隐私、FAQ
- `demo.html` — 交互 Demo：手机框里演示聊天/拖拽/情绪，以及首次报额度、1–10 分钟沉默催促、催满计数；到点关页另用桌面浏览器窗口示意，不在手机框里假装关页
- `404.html` — 顶层 404 页；Cloudflare Pages 只有看到它才会关闭 SPA 回退
- `setup.html` — BYOK 三步：开通 API / 安装扩展 / 在扩展里填 Key
- `install.html` — 扩展加载、DeepSeek API 开通、Key 填写与常见卡点；含 Chrome / Edge 扩展设置位置示意图

## BYOK 流程

1. 用户到 DeepSeek 开放平台注册、充值、创建 API Key。
2. 下载并加载扩展。
3. 打开扩展设置，在「方式」里选择「直接用 API Key」，粘贴 Key，测试连接后保存。
4. 费用由用户和 DeepSeek 结算；插件不卖 Key、不代收、不共享额度。

## 本地预览

```powershell
cd D:\code\video-buddy\site
node serve.mjs
```

打开 `http://127.0.0.1:4173`。`serve.mjs` 只是静态预览，不参与正式运行。

方便检查特定状态：

- `demo.html?open=1` — 直接打开聊天面板
- `setup.html?step=2` — 直接看安装扩展
- `setup.html?step=3` — 直接看填 Key

## 发布到 Cloudflare Pages

```powershell
cd D:\code\video-buddy
node extension/tools/pack-extension.mjs --out site/download   # 产出安装包
node tools/pack-site.mjs --zip                                 # 产出 site-dist/ 和 site-dist.zip
```

然后 Cloudflare Dashboard → Workers & Pages → Create → Pages → **Upload assets**，二选一：

- 把 **`site-dist/` 文件夹本身**拖进去；
- 或者上传 **`site-dist.zip`**。

Cloudflare 的提示是「The contents of your zip file or folder will be used to deploy your project」——它取的是**内容**作为站点根目录，所以拖文件夹本身是对的，不需要进去全选再拖。zip 里的条目也直接位于归档根部（不带 `site-dist/` 前缀），`index.html` 就在 `/`。

**不要**只上传 `index.html` 一个文件：那会是一张没有样式和脚本的裸页面。

`tools/pack-site.mjs` 是白名单：只复制 5 个页面、`styles.css`、`app.js`、`assets/**/*.png` 和 `download/*.zip`。`README.md`（含内部决策）和 `serve.mjs` 不会进发布目录。它会在以下四件事上直接失败退出：

1. `site/download/` 里没有 zip —— 否则下载按钮永远只显示回退弹窗，站点看着正常但下不到扩展。
2. `site/app.js` 的 `DOWNLOAD_URL` 与 zip 文件名不一致 —— 改了 `manifest.json` 版本却没同步这个常量时会发生。
3. 页面引用了没被复制的文件 —— 新增页面要显式加进脚本的 `PAGES` 列表。
4. 顶层 `404.html` 缺失 —— 没有它，Cloudflare Pages 会把未知路径回退成首页 200（soft 404）。

`site-dist/` 是构建产物，已被 `.gitignore` 忽略。

## 技术栈边界

- `site/` 是独立静态目录，不引用 `extension/` 的运行时代码。
- 只复制了 9 张情绪图作为设计资产，原图未改。
- 不改 `extension/manifest.json`、content scripts、background、server 或现有测试。
- 网站不接收、不测试、不保存真实 API Key；真正的输入框只在扩展 popup。
- Key 在 `chrome.storage.local`，抖音页面脚本读不到；它不是加密保险箱，设备被读取时仍可能泄露。
- 原有 `serverUrl` + `APP_TOKEN` 本地 Fastify 模式仍保留给开发者，但不是公开用户的必选项。
- 截图会随请求发到用户配置的模型服务；关闭截图后只使用文案和标签。

## 说明

- Demo 回复是本地写死的，不调用模型，也不需要 Key。
- 下载按钮会先 `HEAD` 一下 `site/download/shangtou-miaomiao-v<version>.zip`：文件在就直接给下载，不在就退回说明弹窗，不会发一个 404 链接。发布时把安装包放进 `site/download/`：

  ```powershell
  node extension/tools/pack-extension.mjs --out site/download
  ```

  ZIP 是构建产物，被 `.gitignore` 的 `*.zip` 规则挡在仓库外，所以 `site/download/` 只保留一个 `.gitkeep`；打包脚本要手动跑，或者在部署流程里跑。

## 浏览器支持

只支持 **Chromium 内核**的桌面浏览器：Chrome 116+、Edge 116+、Brave、Opera、Vivaldi。

- **Firefox 不支持**：它的 Manifest V3 还没有 `background.service_worker`，而本插件的所有请求和截图都在 service worker 里。
- **Safari 不支持**：需要另行封装，暂无计划。

网站首页 hero、`install.html` 的 FAQ、`setup.html` 第 2 步都已写明这一点。**不要改成「主流浏览器」这类含糊说法**——用户在 Firefox 里会看不到悬浮球，而页面没给任何解释。

## 分发方式

暂不上架浏览器商店，安装走开发者模式加载。这是当前正式路径，不是临时方案，所以页面必须如实说明代价：Chrome 每次启动提示「请停用开发者模式扩展程序」，且没有自动更新（换版本要重新下载 zip 替换目录）。
