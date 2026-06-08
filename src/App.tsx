import { MillionPointsPage } from './pages/MillionPointsPage';

// MVP 入口:当前挂载 million-points raw 演示页(T12)。dashboard(T11)就绪后在此分流路由。
export function App(): JSX.Element {
  return <MillionPointsPage />;
}
