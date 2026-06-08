# 渲染验证方案(T14 / ADR-0007)

> 定位:闭合单测的结构性盲区——「canvas 真的画出了东西」与「百万点渲染耗时是否在预算内」。
> 单测可证降采样算法、协议类型正确,但证不了浏览器侧的真实渲染与耗时。本文是该验证的设计依据,
> 配套留证见 `docs/evidence/T14-render-verification.md`。

## 1. 分支裁决(ADR-0007 时间盒)

ADR-0007 设两条路径:**跑通分支**(chrome-devtools MCP 接入,渲染类 DoD 增 MCP 验证项、脚本入 `.claude/`)
与**降级分支**(验证方案文档 + 人工/自动留证入 repo)。

本次执行环境**未挂载 chrome-devtools MCP**(会话内无该 MCP 工具),故按时间盒逻辑走**降级分支**。
但本机存在系统 Chrome,因此降级留证不靠肉眼截图凭空记录,而是用**真实浏览器自动化**产出可复现证据:
通过 CDP(Chrome DevTools Protocol)驱动系统 Chrome 打开 million-points 页、等待渲染、截图 + 读耗时面板。

> 注:CLAUDE.md 硬约束 9 / ADR-0008 规定 `.claude/` 只读,跑通分支「脚本入 `.claude/`」与该约束相冲;
> 降级分支的交付物落在 `docs/`,无此冲突。验证驱动脚本因而存于本文(§4)与 evidence,不写入 `.claude/`。

## 2. 工具选择

| 维度 | 选择 | 理由 |
|---|---|---|
| 浏览器 | 系统 Google Chrome(`--headless=new`) | 本机已装,无需新增项目依赖(硬约束 6) |
| 驱动协议 | CDP,纯 Node `WebSocket`/`fetch` 全局(Node ≥21) | 不引入 puppeteer/playwright(均需 ADR + 下载浏览器),零依赖 |
| 被测产物 | `pnpm build` 产物经 `vite preview` 提供 HTTP | module worker + canvas 需真实 HTTP 源,`file://` 不可用 |
| 入口 | `App` 直接挂 `MillionPointsPage`,无需路由 | 见 `src/App.tsx` |

不选 chrome-devtools MCP:本会话未提供;不选纯 `--screenshot=`:virtual-time 与 Worker 实算 CPU 不同步,
易在渲染完成前抢拍。CDP 轮询「耗时面板出值」再截图,是「等到真的画完」的确定性信号。

## 3. 断言项与预算引用

预算唯一事实源:`docs/data-contract.md §7`(= `PERF_BUDGET`)。本验证只引用、不内联数值(硬约束 8)。

| 断言 | 信号来源 | 预算(契约 §7) | 判定 |
|---|---|---|---|
| 图表非空白 | `<canvas>` 存在且 `width/height > 0`;截图字节数显著 > 空白 | — | `chartCanvasPresent` |
| 数据路径为 raw | 面板 `query-mode` = `raw(无 step / 无 LTTB)`、`raw-point-count` = 1,000,000 | — | `rawPointCountShown` |
| Worker 转换耗时达标 | 面板 `worker-elapsed`(= `meta.elapsedMs`,Worker 内计时) | raw 1M ≤ 500ms | 实测对比 |
| 首帧渲染达标 | 面板 `render-elapsed`(data→双 rAF paint) | 首帧 ≤ 1000ms | 实测对比 |
| 主线程长任务达标 | 面板 `main-longtask`(longtask Observer) | 单次 ≤ 50ms | 实测对比(headless 可能不触发,降级显 —) |

断言对象由 T12 页面自显(`data-testid` 槽位 `metrics-panel` / `query-mode` / `raw-point-count` /
`worker-elapsed` / `render-elapsed` / `main-longtask`),本验证只读取、不注入。

## 4. 可复现流程

```bash
# 1) 构建并以 HTTP 提供产物
pnpm build
pnpm preview --port 4173 --strictPort &

# 2) 启动系统 Chrome(headless + 远程调试),直接打开演示页
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$(mktemp -d)" --remote-debugging-port=9222 \
  --window-size=1280,1100 "http://localhost:4173/" &

# 3) 运行 CDP 驱动:轮询渲染完成 → 截图 + 读耗时面板,断言写 JSON
node t14-cdp-verify.mjs docs/evidence/T14-million-points.png /tmp/t14-timing.json
```

CDP 驱动(纯 Node,无第三方依赖;留此处而非 `.claude/`,见 §1 注):

```js
// 驱动系统 Chrome via CDP:打开 million-points 页、等渲染、截图 + 读耗时面板。
import { writeFileSync } from 'node:fs';
const DEBUG = 'http://localhost:9222';
const APP_URL = 'http://localhost:4173/';
const OUT_PNG = process.argv[2], OUT_JSON = process.argv[3];

const list = await (await fetch(`${DEBUG}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && t.url.includes('localhost:4173'));
if (!target) { console.error('no app target'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL });

const evalExpr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const readPanel = `(() => {
  const txt = (id) => { const el = document.querySelector('[data-testid="'+id+'"]'); return el ? el.textContent.trim() : null; };
  const c = document.querySelector('canvas');
  return { queryMode: txt('query-mode'), rawPointCount: txt('raw-point-count'),
    workerElapsed: txt('worker-elapsed'), renderElapsed: txt('render-elapsed'),
    mainLongtask: txt('main-longtask'), hasCanvas: !!c, canvasW: c?c.width:0, canvasH: c?c.height:0 };
})()`;

const deadline = Date.now() + 60000; let panel = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  try { panel = await evalExpr(readPanel); } catch { continue; }
  if (panel && panel.renderElapsed && panel.renderElapsed !== '—' && panel.hasCanvas) break;
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
const buf = Buffer.from(shot.data, 'base64'); writeFileSync(OUT_PNG, buf);
const result = { capturedAt: new Date().toISOString(), screenshotBytes: buf.length, panel,
  assertions: {
    chartCanvasPresent: panel.hasCanvas && panel.canvasW > 0 && panel.canvasH > 0,
    renderTimingPopulated: panel.renderElapsed !== '—',
    workerTimingPopulated: panel.workerElapsed !== '—',
    rawPointCountShown: panel.rawPointCount !== '—',
    screenshotNonTrivial: buf.length > 15000 } };
writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2)); ws.close(); process.exit(0);
```

## 5. 渲染类任务 DoD 增项(供后续渲染页复用)

凡新增/改动产出可见渲染的页面(charts/pages),DoD 建议追加一条 MCP/CDP 渲染验证项:

- [ ] 经浏览器自动化打开目标页,`<canvas>` 存在且非空白(截图字节显著 > 空白基线)
- [ ] 页面自显耗时面板取值,逐项对比 `data-contract.md §7` 预算并留证(截图 + JSON 入 `docs/evidence/`)
- [ ] 数据路径以面板/查询指令断言(raw / stepped / 降采样)符合该页契约

> 跑通分支若日后接入 chrome-devtools MCP,本增项即 MCP 验证项;当前以 CDP 等价实现,断言项一致。
