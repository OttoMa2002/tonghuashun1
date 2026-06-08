import { useState } from 'react';
import type { ReactElement } from 'react';

import { DashboardPage } from './pages/DashboardPage';
import { MillionPointsPage } from './pages/MillionPointsPage';

type View = 'dashboard' | 'million';

// MVP 入口:在 dashboard(T11,stepped 多面板)与 million-points(T12,raw 百万点)间分流。
// 极简切换,无路由库依赖(未立 ADR);每个视图自建并销毁其 Worker。
export function App(): ReactElement {
  const [view, setView] = useState<View>('dashboard');

  const tab = (key: View, label: string): ReactElement => (
    <button
      type="button"
      onClick={() => setView(key)}
      style={{
        padding: '6px 14px',
        border: '1px solid #cbd5e1',
        borderBottom: 'none',
        borderRadius: '6px 6px 0 0',
        background: view === key ? '#fff' : '#f1f5f9',
        fontWeight: view === key ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <nav style={{ display: 'flex', gap: 4, padding: '8px 24px 0', borderBottom: '1px solid #cbd5e1' }}>
        {tab('dashboard', '仪表盘')}
        {tab('million', '百万点演示')}
      </nav>
      {view === 'dashboard' ? <DashboardPage /> : <MillionPointsPage />}
    </div>
  );
}
