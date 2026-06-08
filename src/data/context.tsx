// 数据层上下文(T08)。把 QueryClient(传输)与 ColumnarStore(快照)经 Provider 注入,
// useMetricQuery 从此读取。页面在根处创建 client+store 并提供;测试注入假实现驱动三态。

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { ColumnarStore } from './store';
import type { QueryClient } from './queryClient';

export interface DataLayer {
  client: QueryClient;
  store: ColumnarStore;
}

const DataLayerContext = createContext<DataLayer | null>(null);

export function DataLayerProvider({
  value,
  children,
}: {
  value: DataLayer;
  children: ReactNode;
}): ReactNode {
  return <DataLayerContext.Provider value={value}>{children}</DataLayerContext.Provider>;
}

export function useDataLayer(): DataLayer {
  const ctx = useContext(DataLayerContext);
  if (!ctx) {
    throw new Error('useDataLayer 必须在 DataLayerProvider 内使用');
  }
  return ctx;
}
