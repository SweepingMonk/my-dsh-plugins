# Markdown Mermaid

本地 Harness 插件：把 Markdown 预览与聊天里**已经渲染出来**的 `mermaid` 代码块换成图表。

不接管、不替换内置 Markdown 渲染器——插件只观察渲染结果：找到代码块，读出它的语言，隐藏它，并在它旁边插入图表。正文排版、代码高亮、复制工具栏、脚注、分页与流式解析全部仍由内置渲染器负责。

## 识别

- 语言取自代码块对应的 React props（`lang`）。内置渲染器对无法高亮的语言只显示通用“代码块”标签，DOM 里查不到 `mermaid` 字样。
- 拿不到 props 时回退为按首行图表类型识别（`flowchart`、`sequenceDiagram`、`classDiagram`…）。
- 两者都不成立时不做任何改动，代码块原样保留。

## 行为

- 围栏内容完整后渲染；位于容器末尾、可能仍在分页或流式追加的围栏会等 250ms 静默再渲染，避免用半张源码报错。
- 图表以静态 SVG（Blob URL）显示：`securityLevel: 'strict'`、`htmlLabels: false`、单图 50,000 字符与 500 条边。
- 语法错误：显示错误说明与源码，隐藏的原代码块仍可恢复，正文其余部分不受影响。
- 点击图表或“放大预览”：10%–800% 缩放、适应窗口、原始大小、滚动平移、Ctrl/⌘ + 滚轮缩放；Esc、关闭按钮或遮罩关闭并恢复键盘焦点。
- 放大弹层通过 React portal 挂在 `body` 下，沿用原生模态对话框；遵循宿主的 `--dsh-frame-overlay-top` 安全间距并声明窗口拖拽排除，避免 Desktop 标题栏拖拽区域吞掉工具栏点击。
- 图表不启用 Mermaid 点击回调。
- 主题跟随：从 `--dsw-alias-*` 取色（含 `light-dark()`），主题切换后重渲染。
- 字体跟随：图表文字用正文实际渲染的字体（通用设置里的正文字体，经 `--dsw-font-family` 继承），不写死 `sans-serif`。
- 默认作用于所有 Markdown 渲染结果（含聊天）；`config: { scope: 'preview' }` 可限制为仅右侧文档预览。

## 已知限制

- 依赖宿主内部结构：`md-code-block` class、`data-code-block-content` 属性，以及渲染节点上的 React props。宿主改结构时插件会安静退化——图表不再出现，代码块照常显示。
- 图表是静态图片，不做 Mermaid 交互回调。
- 同一页面内的图表串行渲染（Mermaid 的配置是全局状态）。
- 客户端 bundle 约 2.7 MB（gzip 约 780 KB），其中 mermaid 占约 91%；后续可拆成 `require.async` 的懒加载 chunk。

## 构建与测试

```
node build.mjs
node test/enhancer.test.mjs
node test/zoom-contract.test.mjs
```

版本号由 `package.json` 注入（`__PLUGIN_VERSION__`），不需要在源码里同步。产物是可复现的：同样的源码与依赖得到同样的 `client.js`。

增强器测试直接加载构建产物 `client.js`（替换掉模块加载器、React 与 DOM），覆盖：识别、隐藏、插入门户、末尾围栏等待静默、流式更新重渲染、语言变化时撤销与重建、节点被移除时清理、插件卸载时清理。放大弹层测试静态检查 portal、Desktop 拖拽排除、顶部安全间距、原生模态与焦点恢复契约；不模拟浏览器命中测试，原生窗口按钮点击仍需在 Desktop 中验证。

## 示例

打开同目录的 `example.md`：流程图、时序图、引用内的图表、应当保持代码形态的 `text` 围栏，以及错误降级。
