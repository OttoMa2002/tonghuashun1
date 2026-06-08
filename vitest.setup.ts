import '@testing-library/jest-dom';

// jsdom 不实现 matchMedia,而 uPlot 在模块加载期(setPxRatio)即调用它;
// 不注入会导致任何 import 'uplot' 的测试在模块求值阶段崩溃。
// 仅为测试环境补齐浏览器 API,不改变被测代码行为。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
