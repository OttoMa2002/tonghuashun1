import { describe, it, expect } from 'vitest';

import { createPrng, hashSeed } from './prng';

// PRNG 是确定性的唯一来源(CLAUDE.md 规则 3)。漂移会让整个生成层失去可复现性。
describe('createPrng', () => {
  it('同种子两次序列逐位相等', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('不同种子序列不同', () => {
    const a = createPrng(1);
    const b = createPrng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('输出落在 [0,1)', () => {
    const p = createPrng(7);
    for (let i = 0; i < 1000; i++) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('确定性:同输入同输出', () => {
    expect(hashSeed(5, 'a{b=1}')).toBe(hashSeed(5, 'a{b=1}'));
  });

  it('不同 key 或不同 seed 派生不同子种子', () => {
    expect(hashSeed(5, 'a')).not.toBe(hashSeed(5, 'b'));
    expect(hashSeed(5, 'a')).not.toBe(hashSeed(6, 'a'));
  });
});
