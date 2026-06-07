# src/mock/ 规则

本目录模拟 Prometheus 查询侧。语义以 docs/data-contract.md §1-§4 为准,prom-query-semantics
skill 提供实现要点。

1. 禁止按「印象中的 Prometheus」补全契约未定义的语义。契约没写的行为 = 不存在的行为,
   需要时提请人工改契约,不自行发明
2. 本目录只允许依赖 src/contract/,不得 import src/ 其他模块(依赖方向的最末端)
3. 确定性是硬指标:同种子两次生成逐点相等。禁止裸用 Math.random,一律走可种子化的 PRNG
4. 故障注入与数据生成分层实现,故障层包裹生成层;故障全关时输出与生成层直出逐字节一致
5. counter 必须单调不减(重置点除外),gauge 必须在配置区间内,这两条是生成器自身的单测对象
6. 对外唯一输出格式是 MatrixResponse / ErrorResponse,不提供任何「便利的」旁路格式
