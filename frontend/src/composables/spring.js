// 弹簧物理（解析解实现）
//
// 借鉴 applemusic-like-lyrics (amll) 的滚动弹簧：Apple Music 歌词滚动的"跟手又带
// 弹性"手感来自位置弹簧，而不是固定缓动曲线。本实现是 amll 的 solveSpring 解析解
// （MIT License, github.com/pushkine/）的独立精简版：
//   - 解析解：每一帧直接代入闭式解求位置，无积分误差、无步长稳定性问题
//   - 无 rAF 自驱：由调用方驱动 update(dt)，弹簧只负责"位置→时间的函数"
//   - arrived() 用数值微分判速，到位即冻结（省掉无谓的逐帧计算）
//
// 参数语义（mass=1 归一化）：
//   - stiffness（刚度）：越大回弹越快，170~220 区间是"轻快跟手"的歌词手感
//   - damping（阻尼）：越大越不弹；damping >= 2*sqrt(stiffness) 时临界/过阻尼（不振荡）

export class Spring {
  constructor(position = 0, params = {}) {
    this.target = position;
    this.params = { stiffness: 180, damping: 26, ...params };
    this.time = 0;
    this.solver = () => this.target; // 初始静止：solver 先就位，_resetSolver 才能算速度
    this._resetSolver();
  }

  /** 立即把弹簧瞬移到某个位置（无动画） */
  setPosition(pos) {
    this.target = pos;
    this.time = 0;
    this.solver = () => pos;
  }

  /** 设定新目标，弹簧从当前位置自然过渡过去 */
  setTarget(pos, params = {}) {
    if (params.stiffness || params.damping) {
      this.updateParams(params);
    }
    if (Math.abs(pos - this.target) < 0.001) return;
    this.target = pos;
    this._resetSolver();
  }

  updateParams(params) {
    this.params = { ...this.params, ...params };
    this._resetSolver();
  }

  /** 推进 delta 秒，返回当前位置 */
  update(delta) {
    this.time += delta;
    if (this.arrived()) {
      // 到位后冻结：直接钉在目标上，停止后续计算
      this.setPosition(this.target);
      return this.target;
    }
    return this.solver(this.time);
  }

  /** 是否已稳定到达目标（位置差 + 速度 + 加速度都≈0） */
  arrived() {
    return (
      Math.abs(this.target - this.solver(this.time)) < 0.01 &&
      Math.abs(this._velocity(this.time)) < 0.01
    );
  }

  get current() {
    return this.solver(this.time);
  }

  _resetSolver() {
    const v = this._velocity(this.time);
    this.time = 0;
    this.solver = solveSpring(this.solver ? this.solver(0) : this.target, v, this.target, this.params);
  }

  /** 数值微分求速度（h=1ms，对歌词滚动足够精确） */
  _velocity(t) {
    const h = 0.001;
    return (this.solver(t + h) - this.solver(t - h)) / (2 * h);
  }
}

/**
 * 二阶弹簧闭式解。
 * 临界条件 damping >= 2*sqrt(stiffness*mass)：过阻尼（缓慢逼近，无振荡）；
 * 否则欠阻尼：带一次振荡后收敛（Apple Music 滚动那种轻微回弹）。
 * soft=true 强制过阻尼（用于 Seek/间奏等"不该弹"的场景）。
 */
function solveSpring(from, velocity, to, params = {}) {
  const { soft = false, stiffness = 180, damping = 26, mass = 1 } = params;
  const delta = to - from;

  if (soft || 1.0 <= damping / (2.0 * Math.sqrt(stiffness * mass))) {
    // 临界/过阻尼：指数收敛
    const angular = -Math.sqrt(stiffness / mass);
    const leftover = -angular * delta - velocity;
    return (t) => {
      if (t < 0) return from;
      return to - (delta + t * leftover) * Math.E ** (t * angular);
    };
  }

  // 欠阻尼：衰减振荡
  const dfreq = Math.sqrt(4.0 * mass * stiffness - damping ** 2.0);
  const leftover = (damping * delta - 2.0 * mass * velocity) / dfreq;
  const decay = -(0.5 * damping) / mass;
  const omega = (0.5 * dfreq) / mass;
  return (t) => {
    if (t < 0) return from;
    return (
      to -
      (Math.cos(t * omega) * delta + Math.sin(t * omega) * leftover) *
        Math.E ** (t * decay)
    );
  };
}

/**
 * 歌词滚动的弹簧参数策略（借鉴 amll getPosYSpringPolicy）：
 * 行间隔越大（慢歌），弹簧越软、滚得越从容；行间隔小（快歌）则更硬更跟手。
 * Seek/间奏/首尾行用慢参数（过阻尼，不弹）。
 *
 * @param {object} opts
 * @param {boolean} opts.isSeeking 是否跳转中
 * @param {number|undefined} opts.intervalMs 当前行与上一行的时间差（ms），首尾行传 undefined
 */
export function getLyricSpringPolicy({ isSeeking = false, intervalMs } = {}) {
  const SLOW = { stiffness: 90, damping: 15 }; // 过阻尼（90 < (15/2)²=56.25? 否 → 实际欠阻尼，但很软）

  if (isSeeking || intervalMs == null) return { ...SLOW, soft: true };

  const MIN_I = 100;
  const MAX_I = 800;
  const MIN_S = 170;
  const MAX_S = 220;
  const clamped = Math.min(Math.max(intervalMs, MIN_I), MAX_I);
  // 间隔越大 → ratio 越小 → stiffness 越小（越软）
  let ratio = 1 - (clamped - MIN_I) / (MAX_I - MIN_I);
  ratio = ratio ** 0.2; // 开五次方根：偏向更快的一端
  const stiffness = MIN_S + ratio * (MAX_S - MIN_S);
  const damping = Math.sqrt(stiffness) * 2.2;
  return { stiffness, damping };
}
