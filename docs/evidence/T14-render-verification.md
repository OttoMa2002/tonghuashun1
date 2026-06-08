# T14 留证:million-points 渲染验证(ADR-0007 降级分支)

走的分支:**降级分支**。本会话未挂载 chrome-devtools MCP,按 ADR-0007 时间盒逻辑降级;
方案设计见 `docs/mcp-render-verification.md`,本文为留证(截图 + 耗时)。

降级留证用**真实浏览器自动化**(CDP 驱动系统 Chrome),非肉眼记录,可复现。

## 环境

- 浏览器:Google Chrome 149.0.7827.53(`--headless=new`,系统已装,无新增依赖)
- 产物:`pnpm build` → `vite preview --port 4173`
- 驱动:纯 Node CDP(`docs/mcp-render-verification.md §4`)
- 捕获时刻:2026-06-08T03:32:21Z

## 截图(非空白断言)

`docs/evidence/T14-million-points.png`(1280×1013,218,731 字节)。

画面含:标题、耗时面板(各槽位出值)、以及铺满画布的百万点蓝色折线(`<canvas>` 1201×778)。
空白页同尺寸 PNG 仅数 KB;本图 ~214KB 且 canvas 维度 > 0 → 真实绘制,非空白。

## 耗时对比预算(契约 §7 / `PERF_BUDGET`)

| 项 | 面板槽位 | 实测 | 预算(契约 §7) | 结论 |
|---|---|---|---|---|
| 查询模式 | `query-mode` | raw(无 step / 无 LTTB) | — | 符合 ADR-0004 raw 路径 |
| 原始点数 | `raw-point-count` | 1,000,000 | — | 百万点取回 |
| Worker 转换 | `worker-elapsed` | **319.7 ms** | ≤ 500 ms | ✅ 达标 |
| 首帧渲染 | `render-elapsed` | **18.0 ms** | ≤ 1000 ms | ✅ 达标 |
| 主线程最长任务 | `main-longtask` | — | ≤ 50 ms | ⓘ headless 未触发 longtask,显 —;转换在 Worker,主线程无 >50ms 任务与之一致 |

## 断言汇总(驱动输出)

```json
{
  "chartCanvasPresent": true,
  "renderTimingPopulated": true,
  "workerTimingPopulated": true,
  "rawPointCountShown": true,
  "screenshotNonTrivial": true
}
```

全部 true:canvas 非空白、raw 路径与百万点确认、Worker 转换与首帧渲染均在预算内。
单测覆盖不到的「真渲染 + 真耗时」盲区由此闭合(ADR-0007 目标达成)。

## 与 T12 的衔接

T12 交付页面与自显耗时面板并标注「截图待 T14 捕获」(`docs/evidence/T12-million-points.md`)。
本任务即完成该捕获:T12 自显的 `render-elapsed` / `worker-elapsed` / `raw-point-count` 槽位
作为断言对象,被本验证读取并对比预算。
