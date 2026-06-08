// 指标列表虚拟滚动表格(T13)。architecture.md §4:components 消费 data/contract 的列式快照。
// 选型 TanStack Virtual(ADR-0001:成熟方案不自研)。核心约束:
//   - 行渲染数与视口挂钩——万行下实际 DOM 行数恒为「可见窗口 + overscan」量级(DoD#1)
//   - 滚动不触发整表重渲:行组件 memo 化,props 全部稳定,留在视口内的行不重渲(DoD#2)
// 本组件不做数据加工(硬约束 3):不排序、不过滤、不降采样,只把传入的行投影到虚拟窗口。

import { memo, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { LabelSet } from '../contract';

/**
 * 表格行视图模型。由上游(页面或 columnarToMetricRows 适配器)构造;
 * 本组件只负责把它放进虚拟窗口,不解释其来源。value 为 NaN 表示无样本。
 */
export interface MetricTableRow {
  /** 稳定身份(通常为 seriesKey()),用作虚拟项 key,保证滚动时行身份不漂移。 */
  key: string;
  name: string;
  labels: LabelSet;
  value: number;
}

const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_VIEWPORT_HEIGHT = 480;
const OVERSCAN = 8;

function formatValue(value: number): string {
  return Number.isNaN(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function formatLabels(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  return keys.length === 0 ? '—' : keys.map((k) => `${k}="${labels[k]}"`).join(', ');
}

interface MetricRowViewProps {
  row: MetricTableRow;
  /** 行在内容容器内的绝对偏移(= index × rowHeight),按 index 恒定,与滚动量无关。 */
  top: number;
  height: number;
  /** 仅供测试的渲染探针:行实际渲染时回调其 key,用于断言虚拟化未触发整表重渲(DoD#2)。 */
  onRender?: (key: string) => void;
}

// memo:props 全部稳定(row 引用、top 按 index 恒定、height 常量、onRender 由父稳定下传)时,
// 滚动导致父重渲也不会重渲留在视口内的行——这是 DoD#2「滚动时无整表重渲」的实现要点。
const MetricRowView = memo(function MetricRowView({
  row,
  top,
  height,
  onRender,
}: MetricRowViewProps): ReactElement {
  onRender?.(row.key);
  const style: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height,
    transform: `translateY(${top}px)`,
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    borderBottom: '1px solid #e2e8f0',
    padding: '0 12px',
    gap: 12,
  };
  return (
    <div role="row" data-testid="metric-row" style={style}>
      <span
        style={{
          width: 280,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.name}
      </span>
      <span
        style={{
          flex: 1,
          color: '#475569',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {formatLabels(row.labels)}
      </span>
      <span style={{ width: 120, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {formatValue(row.value)}
      </span>
    </div>
  );
});

export interface MetricTableProps {
  rows: MetricTableRow[];
  rowHeight?: number;
  height?: number;
  /** 仅供测试:每当某行实际渲染时回调其 key(见 MetricRowView.onRender)。 */
  onRowRender?: (key: string) => void;
}

/**
 * 虚拟滚动指标表格。无论 rows 有多少(万行级),DOM 中只存在
 * 「可见窗口 + overscan」量级的行;滚动改变窗口而非重建整表。
 */
export function MetricTable({
  rows,
  rowHeight = DEFAULT_ROW_HEIGHT,
  height = DEFAULT_VIEWPORT_HEIGHT,
  onRowRender,
}: MetricTableProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    // 身份取自行 key:行集变化时虚拟项不按下标错位复用(滚动稳定性的前提)。
    getItemKey: (index) => rows[index].key,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      data-testid="metric-table-scroll"
      role="table"
      style={{
        height,
        overflow: 'auto',
        position: 'relative',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => (
          <MetricRowView
            key={item.key}
            row={rows[item.index]}
            top={item.start}
            height={rowHeight}
            onRender={onRowRender}
          />
        ))}
      </div>
    </div>
  );
}
