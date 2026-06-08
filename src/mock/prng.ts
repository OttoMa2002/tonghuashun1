// 可种子化伪随机源(src/mock/CLAUDE.md 规则 3:禁裸用 Math.random,确定性是硬指标)。
// 实现为 mulberry32:32 位状态、纯函数推进,同种子产生逐位相同的序列。

/** 确定性随机源:next() 返回 [0,1) 的均匀分布数。 */
export interface Prng {
  /** 推进状态并返回下一个 [0,1) 随机数。 */
  next(): number;
}

/**
 * mulberry32:小而快的确定性 PRNG。种子取整为 uint32。
 * 同一 seed 两次创建的实例产生完全相同的序列(确定性测试对象)。
 */
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * FNV-1a 32 位字符串哈希。用于从全局 seed + series key 派生每序列子种子,
 * 使各序列的随机流相互独立、且与 labelSets 的遍历顺序无关。
 */
export function hashSeed(seed: number, key: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
