import { describe, it, expect } from 'vitest';

import { seriesKey } from './metric';

// seriesKey 是 mock 与 worker 共用的规范化函数(§1),漂移会让两侧 series 身份分叉。
describe('seriesKey', () => {
  it('labels 顺序无关:按 key 字典序规范化', () => {
    expect(seriesKey('http_requests', { method: 'GET', code: '200' })).toBe(
      seriesKey('http_requests', { code: '200', method: 'GET' }),
    );
  });

  it('确定性:同输入两次结果逐字符相等', () => {
    expect(seriesKey('m', { b: '2', a: '1' })).toBe(seriesKey('m', { b: '2', a: '1' }));
  });

  it('无标签退化为 name 本身', () => {
    expect(seriesKey('up', {})).toBe('up');
  });

  it('标签值不同 → key 不同', () => {
    expect(seriesKey('m', { a: '1' })).not.toBe(seriesKey('m', { a: '2' }));
  });
});
