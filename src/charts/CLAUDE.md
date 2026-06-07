# src/charts/ 规则

uPlot 封装规则,正确范式见 uplot-react skill,先读它再动手。

1. uPlot 实例每个图表组件只创建一次;数据更新一律走 setData,禁止因数据变更销毁重建
2. 尺寸变化走 ResizeObserver → setSize,禁止重建实例,禁止监听 window resize
3. 本目录只消费 ColumnarFrame(docs/data-contract.md §6),禁止任何数据加工:不降采样、
   不过滤、不排序。需要加工说明上游有缺口,提请改 worker,不在这里打补丁
4. 组件卸载必须:销毁 uPlot 实例 + 断开 ResizeObserver,无定时器残留
5. NaN 间隙表示是待验证假设(契约 §6):T10 第一件事是验证它,结论无论真假都要回写
   data-contract.md 待审定项(经人工),不许静默选一条路
6. options 对象在组件生命周期内保持引用稳定(useMemo 或模块常量),防止隐式重初始化
