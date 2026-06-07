# ADR-0002:图表主线选 uPlot 单库,ECharts 复杂图保留设计、不实现

状态:Accepted(范围按面试官说明修正:不要求代码生成效果,重点看上下文组织)

## 背景

题目硬指标:百万级数据渲染。通用图表库在此量级靠降采样掩盖性能问题,无法正面回应考点。同时 dashboard 还需要热力图、直方图等复杂图形。

## 备选与否决理由

- **ECharts 单库**:配置式 API,AI 生成正确率高,中文生态完善。否决为主线:ECharts 在百万点量级必须依赖降采样才能工作,无法在不降采样的前提下完成渲染,题目"百万级渲染"考点无法被正面验证。本方案的降采样是默认效率策略,raw 直渲是受控的能力证明,二者并存;ECharts 缺的是后者。
- **Canvas 自研渲染**:性能上限最高。否决:工期与正确性风险不可控,且重新发明 uPlot。
- **uPlot + ECharts 双库并行实现**:原方案。范围修正后,ECharts 部分的实现性价比为负,降级为设计保留。
- **uPlot 单库主线**:采纳。uPlot 为百万级时序点设计(单 canvas、无虚拟 DOM、列式数据输入)。README 基准:166,650 点冷启动渲染 25ms,线性扩展约 100k 点/ms;百万点为线性外推,以 T12 实测自显耗时为准。已知限制:流式更新下视图内超 10 万点时 60fps 可能吃力,与本方案契合(常规页走两级降采样,raw 仅限受控演示)。

## 决议

uPlot 承担全部已实现图表(dashboard 折线 + million-points 页)。ECharts 接入设计保留于本 ADR,不实现:

- 挂载点:`src/charts/` 内与 uPlot wrapper 平级的独立 wrapper,互不感知
- 按需动态 import,不进首屏 bundle
- 数据输入同样消费列式 store 快照,转换适配器放 `src/charts/adapters/`

## 后果

- uPlot 语料稀少,是全项目 AI 生成错误率最高区域:由 `uplot-react` skill 与 `src/charts/CLAUDE.md` 对冲(见 architecture.md §6)
- 复杂图能力缺位是已知且被接受的范围裁剪,非遗漏
- 实例复用 + setData 增量更新成为硬约束,防止高频更新触发图表重建
