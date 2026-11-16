import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyPlanner, LatencyCycleError } from '../src/latency-planner.js';

const EPS = 1e-9;

/** 构造一个典型游戏混音图：
 *  dialog(48k) -> convolver(48k, 512 样本) -> mix
 *  sfx(48k) -> compressor(48k, 128 样本) -> mix
 *  music(44.1k) -> resampler(44.1k, 64 样本) -> mix
 *  voice(外部节点, 12ms) -> mix
 *  mix -> device(48k, 240 样本输出缓冲)
 */
function buildPlanner() {
  const planner = new LatencyPlanner({
    outputDevice: { id: 'device', sampleRate: 48000, latencySamples: 240 },
  });
  planner
    .addNode({ id: 'dialog', kind: 'source' })
    .addNode({ id: 'sfx', kind: 'source' })
    .addNode({ id: 'music', kind: 'source' })
    .addNode({ id: 'voice', kind: 'external', latencySeconds: 0.012 })
    .addNode({ id: 'conv', kind: 'convolver', sampleRate: 48000, latencySamples: 512 })
    .addNode({ id: 'comp', kind: 'compressor', sampleRate: 48000, latencySamples: 128 })
    .addNode({ id: 'rs', kind: 'resampler', sampleRate: 44100, latencySamples: 64 })
    .addNode({ id: 'mix', kind: 'mixer' })
    .connect('dialog', 'conv')
    .connect('conv', 'mix')
    .connect('sfx', 'comp')
    .connect('comp', 'mix')
    .connect('music', 'rs')
    .connect('rs', 'mix')
    .connect('voice', 'mix')
    .connect('mix', 'device');
  return planner;
}

test('累计延迟在正确单位上换算：重采样节点按自身采样率折算', () => {
  const plan = buildPlanner().plan();
  const music = plan.sources.find((s) => s.id === 'music');
  // 64 样本 @44.1kHz + 240 样本 @48kHz，单位必须先各自换成秒再相加
  const expected = 64 / 44100 + 240 / 48000;
  assert.ok(Math.abs(music.latencySeconds - expected) < EPS);
  // 换算到设备样本：64/44100s ≈ 69.66 个 48k 样本，加 240 共约 310；
  // 若错误地把不同采样率的样本直接相加会得到 64 + 240 = 304
  assert.equal(music.latencySamplesAtOutput, 310);
});

test('补偿后所有已知源的总延迟对齐（差值为零）', () => {
  const plan = buildPlanner().plan();
  const ref = plan.referenceLatencySeconds;
  // 参考路径是最长的 voice 外部节点链：12ms + 240/48000
  assert.ok(Math.abs(ref - (0.012 + 240 / 48000)) < EPS);
  for (const src of plan.sources) {
    assert.ok(src.known, `${src.id} 应为已知`);
    assert.ok(Math.abs(src.compensatedTotalSeconds - ref) < 1 / plan.outputSampleRate);
    // 用样本域验证：延迟 + 补偿 == 参考（允许 1 样本取整误差）
    const total = src.latencySamplesAtOutput + src.compensationSamples;
    assert.ok(Math.abs(total - ref * plan.outputSampleRate) <= 1);
  }
  // 最长路径（voice）不需要补偿
  const voice = plan.sources.find((s) => s.id === 'voice');
  assert.equal(voice.compensationSamples, 0);
  assert.equal(voice.latencySamplesAtOutput, 576 + 240);
  // dialog: (512+240)/48000 = 752 样本，补偿 816 - 752 = 64
  const dialog = plan.sources.find((s) => s.id === 'dialog');
  assert.equal(dialog.compensationSamples, 64);
});

test('外部节点以秒声明延迟时正确参与累计', () => {
  const plan = buildPlanner().plan();
  const voice = plan.sources.find((s) => s.id === 'voice');
  assert.ok(Math.abs(voice.latencySeconds - (0.012 + 240 / 48000)) < EPS);
});

test('运行时旁路切换后重新规划，补偿量随之更新', () => {
  const planner = buildPlanner();
  const before = planner.plan();
  const dialogBefore = before.sources.find((s) => s.id === 'dialog');
  assert.equal(dialogBefore.compensationSamples, 64);

  // 旁路卷积：dialog 路径只剩设备缓冲，补偿增大到 12ms = 576 样本
  planner.setBypass('conv', true);
  const after = planner.plan();
  const ref = after.referenceLatencySeconds;
  assert.ok(Math.abs(ref - (0.012 + 240 / 48000)) < EPS);
  const dialogAfter = after.sources.find((s) => s.id === 'dialog');
  assert.equal(dialogAfter.compensationSamples, 576);
  assert.ok(Math.abs(dialogAfter.compensatedTotalSeconds - ref) < 1 / 48000);

  // 取消旁路后恢复原状
  planner.setBypass('conv', false);
  const restored = planner.plan();
  assert.equal(restored.sources.find((s) => s.id === 'dialog').compensationSamples, 64);
});

test('未知延迟节点被报告，受影响源不参与补偿', () => {
  const planner = buildPlanner();
  planner.addNode({ id: 'mystery', kind: 'processor', sampleRate: 48000 });
  planner.disconnect('sfx', 'comp');
  planner.connect('sfx', 'mystery');
  planner.connect('mystery', 'mix');
  const plan = planner.plan();
  assert.deepEqual(plan.unknownNodes, ['mystery']);
  const sfx = plan.sources.find((s) => s.id === 'sfx');
  assert.equal(sfx.known, false);
  assert.equal(sfx.compensationSamples, null);
  // 其余源不受影响，仍能对齐
  const known = plan.sources.filter((s) => s.known);
  assert.ok(known.length >= 3);
  for (const s of known) {
    assert.ok(Math.abs(s.compensatedTotalSeconds - plan.referenceLatencySeconds) < 1 / 48000);
  }
});

test('图循环被检测并抛出带路径的错误', () => {
  const planner = buildPlanner();
  planner.addNode({ id: 'fbA', kind: 'processor', sampleRate: 48000, latencySamples: 32 });
  planner.addNode({ id: 'fbB', kind: 'processor', sampleRate: 48000, latencySamples: 32 });
  planner.connect('mix', 'fbA');
  planner.connect('fbA', 'fbB');
  planner.connect('fbB', 'fbA');
  assert.throws(() => planner.plan(), (err) => {
    assert.ok(err instanceof LatencyCycleError);
    assert.ok(err.cycle.includes('fbA') && err.cycle.includes('fbB'));
    return true;
  });
});

test('菱形分叉（同一源经两条路径到达混音器）取最坏路径', () => {
  const planner = new LatencyPlanner({
    outputDevice: { id: 'device', sampleRate: 48000, latencySamples: 0 },
  });
  planner
    .addNode({ id: 'src', kind: 'source' })
    .addNode({ id: 'fast', kind: 'processor', sampleRate: 48000, latencySamples: 48 })
    .addNode({ id: 'slow', kind: 'processor', sampleRate: 48000, latencySamples: 480 })
    .addNode({ id: 'mix', kind: 'mixer' })
    .connect('src', 'fast')
    .connect('src', 'slow')
    .connect('fast', 'mix')
    .connect('slow', 'mix')
    .connect('mix', 'device');
  const plan = planner.plan();
  const src = plan.sources.find((s) => s.id === 'src');
  assert.equal(src.latencySamplesAtOutput, 480);
  assert.equal(src.compensationSamples, 0);
});

test('多采样率链：44.1k 源经重采样到 48k 输出，全程秒域累计', () => {
  const planner = new LatencyPlanner({
    outputDevice: { id: 'device', sampleRate: 48000, latencySamples: 96 },
  });
  planner
    .addNode({ id: 'a', kind: 'source' })
    .addNode({ id: 'pre', kind: 'convolver', sampleRate: 44100, latencySamples: 441 })
    .addNode({ id: 'post', kind: 'compressor', sampleRate: 48000, latencySamples: 240 })
    .connect('a', 'pre')
    .connect('pre', 'post')
    .connect('post', 'device');
  const plan = planner.plan();
  const a = plan.sources.find((s) => s.id === 'a');
  // 441/44100 = 10ms，240/48000 = 5ms，96/48000 = 2ms，共 17ms = 816 样本 @48k
  assert.ok(Math.abs(a.latencySeconds - 0.017) < EPS);
  assert.equal(a.latencySamplesAtOutput, 816);
});
