# T12 证据:million-points raw 演示

页面:`src/pages/MillionPointsPage.tsx`(入口 `App` 已挂载)。数据集:`src/worker/million-dataset.ts`
在固定 1s 栅格上产 1,000,000 点 gauge 序列;raw 整窗查询取回即百万点(ADR-0004 受控例外)。

## DoD 落地与断言来源

| DoD | 落地 | 断言/留痕 |
|---|---|---|
| 数据路径为 raw(无 step、无 LTTB) | `RAW_SPEC` 不含 `stepMillis`、不含 `downsample` | `MillionPointsPage.test.tsx` DoD1:断言 exec 指令 `stepMillis===undefined && downsample===undefined`,选择器/窗口命中 |
| 页面自显渲染耗时(T14 断言对象) | 耗时面板 `data-testid=metrics-panel`,槽位 `render-elapsed`/`worker-elapsed`/`raw-point-count`/`main-longtask`/`query-mode` | DoD2/DoD3:断言面板与槽位存在、出结果后显示 Worker 转换耗时与原始点数 |
| 主线程长任务不超预算(转换在 Worker 的运行时证据) | `meta.elapsedMs` 为 Worker 内 fetch+解析+列式化耗时;`PerformanceObserver({entryTypes:['longtask']})` 量主线程最长任务 | 运行时面板对比 `PERF_BUDGET`;浏览器截图见下「待 T14 捕获」 |

## 性能预算(契约 §7 / `PERF_BUDGET`)

- Worker 转换(raw 1M):≤ 500ms — 面板 `worker-elapsed`
- 首帧渲染 setData→paint:≤ 1000ms — 面板 `render-elapsed`
- 主线程单次长任务:≤ 50ms — 面板 `main-longtask`

## 测量方法(页面运行时)

- **Worker 转换耗时**:取 `query.result` 回执的 `meta.elapsedMs`。该值在 Worker 内计时,
  主线程从不接触 matrix,显示它即「转换在 Worker 完成」的运行时证据。
- **首帧渲染**:data 首次到达即在 render 内记起点(先于子组件 commit/setData),双 `requestAnimationFrame`
  后量到 paint 完成,含 uPlot 首次构造 + 绘制。
- **主线程最长任务**:longtask PerformanceObserver,取 duration 最大值;浏览器可用,jsdom/旧环境降级为 —。

## 截图(待 T14 捕获)

本任务在无浏览器的无人值守环境执行,无法捕获真实渲染截图。million-points 页正是 ADR-0007 / T14
chrome-devtools MCP 渲染验证的标的:由 T14 打开本页、截图断言非空白、读取上述面板耗时对比预算,
截图与耗时归档至本目录。本任务交付页面与自显耗时面板,作为 T14 的断言对象。
