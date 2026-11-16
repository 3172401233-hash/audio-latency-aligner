# audio-latency-aligner
JavaScript 游戏音频延迟对齐库，处理子混音、插件链、报告延迟和时间戳

## 解决的问题

运行时混音图里，重采样、卷积、压缩、外部音频节点各自报告延迟，且单位不同
（样本数在不同采样率下、或直接是秒）。并行子混音汇聚后，过场对白和音效会
错开几十毫秒。本库对每个源到输出设备的路径累计延迟，并给出需要插入的补偿
延迟线长度（输出设备采样率下的样本数），使所有源在设备端对齐。

## 单位不变量

- 节点延迟用 `latencySamples`（配合节点自己的 `sampleRate`）或 `latencySeconds` 声明。
- 图内累计一律在**秒域**进行：`samples / node.sampleRate`。
  绝不把秒加到样本上，也不把不同采样率下的样本直接相加。
- 只有最终的 `compensationSamples` 才换算到输出设备采样率。

## 用法

```js
import { LatencyPlanner } from './src/latency-planner.js';

const planner = new LatencyPlanner({
  outputDevice: { id: 'device', sampleRate: 48000, latencySamples: 240 },
});

planner
  .addNode({ id: 'dialog', kind: 'source' })
  .addNode({ id: 'conv', kind: 'convolver', sampleRate: 48000, latencySamples: 512 })
  .addNode({ id: 'voice', kind: 'external', latencySeconds: 0.012 })
  .addNode({ id: 'mix', kind: 'mixer' })
  .connect('dialog', 'conv')
  .connect('conv', 'mix')
  .connect('voice', 'mix')
  .connect('mix', 'device');

const plan = planner.plan();
// plan.sources[*].compensationSamples —— 每个源要插入的延迟（设备样本）
// plan.referenceLatencySeconds —— 对齐目标（最长已知路径）

// 运行时旁路切换后重新规划：
planner.setBypass('conv', true);
const updated = planner.plan();
```

## 边界情况

- **并行子混音 / 菱形分叉**：汇聚点取各入边的最大延迟（最坏路径）。
- **运行时旁路**：旁路节点贡献 0 延迟；`setBypass()` 后调用 `plan()` 得到新方案。
- **未知延迟**：未声明延迟的处理节点标记为 unknown，所在源 `known: false`、
  `compensationSamples: null`，不参与对齐目标计算，并在 `plan.unknownNodes` 中报告。
- **图循环**：`plan()` 抛出 `LatencyCycleError`，`err.cycle` 给出构成循环的节点路径。

## 设备时钟 vs 离线时钟

本库输出的补偿样本数**只在输出设备时钟域内有意义**：

- **设备时钟**：声卡 DAC 按自己的晶振走，`compensationSamples` 个样本对应的
  真实时长是 `samples / 设备实际采样率`。设备实际采样率与标称值会有几十 ppm
  的漂移，且与 CPU 时钟、其他设备不同步。因此补偿量用于实时渲染图时，
  长时间运行后可能需要按设备时钟漂移做重校准（本库不处理漂移补偿）。
- **离线时钟**（导出 / 渲染到文件）：没有 DAC，时间轴完全由文件采样率定义，
  补偿样本数精确对应 `samples / sampleRate` 秒，不存在漂移，对齐是严格样本级
  精确的。

换句话说：离线渲染里“延迟归零”是数学上严格的；实时设备上“归零”只在规划
时刻成立，之后随设备间时钟漂移缓慢积累误差。

## 测试

```sh
node --test
```

测试验证：多采样率链在秒域正确累计、补偿后各源总延迟与参考路径之差归零
（允许 1 样本取整误差）、旁路切换后方案更新、未知延迟被隔离报告、循环被检出。
