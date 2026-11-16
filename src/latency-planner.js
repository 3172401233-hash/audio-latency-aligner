/**
 * 音频延迟对齐规划器。
 *
 * 单位约定（核心不变量）：
 * - 每个节点的处理延迟以其自身采样率下的样本数（latencySamples）或秒（latencySeconds）声明。
 * - 图内累计一律在“秒”域进行：samples / node.sampleRate。
 *   绝不把秒直接加到样本上，也不把不同采样率下的样本直接相加。
 * - 只有在最终输出补偿量时，才把秒换算成输出设备采样率下的样本数。
 */

export class LatencyCycleError extends Error {
  constructor(cycle) {
    super(`音频图存在循环: ${cycle.join(' -> ')}`);
    this.name = 'LatencyCycleError';
    this.cycle = cycle;
  }
}

export class LatencyPlanner {
  /**
   * @param {{id?: string, sampleRate: number, latencySamples?: number, latencySeconds?: number}} outputDevice
   */
  constructor({ outputDevice }) {
    if (!outputDevice || !(outputDevice.sampleRate > 0)) {
      throw new TypeError('outputDevice.sampleRate 必须为正数');
    }
    this.outputDevice = {
      id: outputDevice.id ?? 'output',
      sampleRate: outputDevice.sampleRate,
      latencySamples: outputDevice.latencySamples ?? 0,
      latencySeconds: outputDevice.latencySeconds,
      bypassed: false,
      kind: 'output',
    };
    this.nodes = new Map();
    this.edges = new Map(); // from -> Set<to>
  }

  /**
   * @param {{
   *   id: string,
   *   kind?: 'source'|'resampler'|'convolver'|'compressor'|'external'|'mixer'|'output'|string,
   *   sampleRate?: number,        // latencySamples 所用的采样率；缺省继承输出设备采样率
   *   latencySamples?: number,    // 以 sampleRate 为单位的处理延迟；undefined 表示未知
   *   latencySeconds?: number,    // 也可以直接以秒声明（如外部硬件报告的延迟）
   *   bypassed?: boolean,
   * }} node
   */
  addNode(node) {
    if (!node || typeof node.id !== 'string') {
      throw new TypeError('node.id 必须是非空字符串');
    }
    if (node.latencySamples != null && !(node.sampleRate > 0)) {
      throw new TypeError(`节点 ${node.id} 声明了 latencySamples，必须提供正数 sampleRate`);
    }
    this.nodes.set(node.id, {
      kind: 'processor',
      latencySamples: undefined,
      latencySeconds: undefined,
      bypassed: false,
      ...node,
    });
    return this;
  }

  connect(fromId, toId) {
    this._requireNode(fromId);
    this._requireNode(toId);
    if (!this.edges.has(fromId)) this.edges.set(fromId, new Set());
    this.edges.get(fromId).add(toId);
    return this;
  }

  disconnect(fromId, toId) {
    this.edges.get(fromId)?.delete(toId);
    return this;
  }

  /** 运行时旁路切换；下一次 plan() 反映新状态。 */
  setBypass(id, bypassed) {
    this._requireNode(id);
    this.nodes.get(id).bypassed = Boolean(bypassed);
    return this;
  }

  _requireNode(id) {
    if (id !== this.outputDevice.id && !this.nodes.has(id)) {
      throw new Error(`未知节点: ${id}`);
    }
  }

  _getNode(id) {
    return id === this.outputDevice.id ? this.outputDevice : this.nodes.get(id);
  }

  /**
   * 节点自身贡献的延迟（秒）。
   * 返回 { seconds: number|null, unknown: boolean }；旁路节点贡献 0。
   */
  _ownLatencySeconds(node) {
    if (node.bypassed) return { seconds: 0, unknown: false };
    if (node.latencySeconds != null) return { seconds: node.latencySeconds, unknown: false };
    if (node.latencySamples != null) {
      const rate = node.sampleRate ?? this.outputDevice.sampleRate;
      return { seconds: node.latencySamples / rate, unknown: false };
    }
    // 源节点（无延迟声明的输入端）视为 0；处理节点延迟未知。
    if (node.kind === 'source' || node.kind === 'mixer') return { seconds: 0, unknown: false };
    return { seconds: null, unknown: true };
  }

  _successors(id) {
    return this.edges.get(id) ?? new Set();
  }

  /** 三色 DFS 检测循环，返回构成循环的节点 id 路径，无环返回 null。 */
  findCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const stack = [];
    const allIds = [...this.nodes.keys(), this.outputDevice.id];

    const visit = (id) => {
      color.set(id, GRAY);
      stack.push(id);
      for (const next of this._successors(id)) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          return stack.slice(stack.indexOf(next)).concat(next);
        }
        if (c === WHITE) {
          const found = visit(next);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(id, BLACK);
      return null;
    };

    for (const id of allIds) {
      if ((color.get(id) ?? WHITE) === WHITE) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * 计算对齐方案。
   * @returns {{
   *   outputSampleRate: number,
   *   referenceLatencySeconds: number|null, // 对齐目标：已知路径中的最大总延迟
   *   sources: Array<{
   *     id: string,
   *     known: boolean,
   *     latencySeconds: number|null,          // 源到设备（含设备自身）的累计延迟
   *     latencySamplesAtOutput: number|null,  // 换算到设备采样率的样本数
   *     compensationSamples: number|null,     // 需插入的延迟线长度（设备样本）
   *     compensatedTotalSeconds: number|null, // 补偿后总延迟，应对齐到 reference
   *     unknownNodes: string[],
   *   }>,
   *   unknownNodes: string[],
   * }}
   */
  plan() {
    const cycle = this.findCycle();
    if (cycle) throw new LatencyCycleError(cycle);

    // 自底向上（从设备往源方向）记忆化累计：down(id) = 自身 + max(后继)。
    // 并行子混音在汇聚点取最大路径，菱形分叉自动取最坏情况。
    const memo = new Map();
    const downstream = (id) => {
      if (memo.has(id)) return memo.get(id);
      const node = this._getNode(id);
      const own = this._ownLatencySeconds(node);
      const succs = [...this._successors(id)];
      let seconds = own.seconds ?? 0;
      let unknown = own.unknown;
      const unknownNodes = own.unknown ? [id] : [];
      if (succs.length > 0) {
        let best = null;
        for (const s of succs) {
          const d = downstream(s);
          if (best === null || d.seconds > best.seconds) best = d;
        }
        seconds += best.seconds;
        unknown = unknown || best.unknown;
        unknownNodes.push(...best.unknownNodes);
      }
      const result = { seconds, unknown, unknownNodes: [...new Set(unknownNodes)] };
      memo.set(id, result);
      return result;
    };

    // 源 = 入度为 0 的非设备节点。
    const hasIncoming = new Set();
    for (const targets of this.edges.values()) {
      for (const t of targets) hasIncoming.add(t);
    }
    const sourceIds = [...this.nodes.keys()].filter((id) => !hasIncoming.has(id));

    const entries = sourceIds.map((id) => {
      const d = downstream(id);
      return { id, ...d };
    });

    const known = entries.filter((e) => !e.unknown);
    const reference = known.length > 0
      ? Math.max(...known.map((e) => e.seconds))
      : null;
    const outRate = this.outputDevice.sampleRate;

    const sources = entries.map((e) => {
      if (e.unknown || reference === null) {
        return {
          id: e.id,
          known: false,
          latencySeconds: null,
          latencySamplesAtOutput: null,
          compensationSamples: null,
          compensatedTotalSeconds: null,
          unknownNodes: e.unknownNodes,
        };
      }
      const compensationSamples = Math.round((reference - e.seconds) * outRate);
      return {
        id: e.id,
        known: true,
        latencySeconds: e.seconds,
        latencySamplesAtOutput: Math.round(e.seconds * outRate),
        compensationSamples,
        compensatedTotalSeconds: e.seconds + compensationSamples / outRate,
        unknownNodes: [],
      };
    });

    return {
      outputSampleRate: outRate,
      referenceLatencySeconds: reference,
      sources,
      unknownNodes: [...new Set(entries.flatMap((e) => e.unknownNodes))],
    };
  }
}
