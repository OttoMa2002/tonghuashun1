---
name: uplot-react
description: 在 React 中正确使用 uPlot 的生命周期范式。凡创建、修改 src/charts/ 下的 uPlot 封装或图表组件时必读。涵盖实例复用、setData 增量更新、resize 处理、销毁清理,以及必须避免的反模式。
---

# uPlot in React 正确范式

uPlot 不是 React 组件,是命令式 canvas 库。核心心法:**React 管挂载点,uPlot 管自己**。
React 的数据流到 ref 为止,不要让 React 的渲染周期驱动 uPlot 的重绘。

## 正确骨架

```tsx
function TimeSeriesChart({ frame, options }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // 创建一次:仅挂载/卸载
  useEffect(() => {
    const plot = new uPlot(options, toUplotData(frame), rootRef.current!);
    plotRef.current = plot;
    const ro = new ResizeObserver(([entry]) => {
      plot.setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(rootRef.current!);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
  }, []); // 依赖数组刻意为空,见下方反例 1

  // 数据更新:只走 setData
  useEffect(() => {
    plotRef.current?.setData(toUplotData(frame));
  }, [frame]);

  return <div ref={rootRef} className="chart-root" />;
}
```

要点:

- options 引用必须稳定(useMemo 或模块常量),它只在创建时消费一次
- toUplotData 是纯转换(ColumnarFrame → uPlot 列式输入),不做任何加工
- 列式数据直接对位:`[frame.ts, ...frame.series.map(s => s.values)]`

## 反例对照(每条都是语料里的高频惯性写法)

**反例 1:数据进依赖数组,变更即重建**

```tsx
useEffect(() => {
  const plot = new uPlot(options, data, root);
  return () => plot.destroy();
}, [data]); // ✗ 每次轮询都销毁重建,百万点场景下是灾难
```

为什么错:重建丢失缩放/光标状态,且全量重初始化的成本是 setData 的数量级倍。
轮询每 15s 来一次新数据,这个写法等于每 15s 砸掉重盖。

**反例 2:用 React state/重渲染驱动图表**

```tsx
const [data, setData] = useState(...);
return <UplotReactWrapper data={data} />; // wrapper 内部 props 变化即重建
```

为什么错:同反例 1,只是把重建藏进了 wrapper。判定标准:数据 props 变化 N 次,
uPlot 构造函数必须只被调用 1 次(T10 的 spy 测试断言的就是这个)。

**反例 3:window resize 监听 + 重建**

```tsx
window.addEventListener('resize', () => { plot.destroy(); plot = new uPlot(...); });
```

为什么错:容器尺寸 ≠ 窗口尺寸(面板布局下尤其);重建不必要,setSize 即可;
且事件监听在组件卸载后泄漏。一律 ResizeObserver + setSize。

**反例 4:options 内联字面量**

```tsx
useEffect(() => { ... }, []);
...
<Chart options={{ width: 800, ... }} /> // ✗ 每次渲染新引用
```

为什么错:本骨架下侥幸无害(options 只读一次),但任何后续把 options 加进依赖数组的
改动都会引爆重建。引用稳定是防御性约定。

## 间隙处理(待验证项)

ColumnarFrame 用 Float64Array,缺点为 NaN(契约 §6)。uPlot 对 typed array + NaN 的
间隙行为是待验证假设:T10 第一步先写一个三点含 NaN 的最小用例验证,结论回写契约
待审定项。验证不通过则在 toUplotData 内做 NaN→null 普通数组转换(降级路径,有一次拷贝)。
