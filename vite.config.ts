import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 列式时序平台脚手架配置。数据加工在 Worker 内,见 docs/architecture.md §5。
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
