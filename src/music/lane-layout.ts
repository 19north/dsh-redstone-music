/**
 * lane-layout.ts —— 红石带子的几何与时序（纯计算，可单测）
 *
 * 复刻实战生成器的三条硬约束：
 *   ① 链条 = 偶数 x 中继器 / 奇数 x 载体+音符盒；载体方块必须落在【奇数 x】列；
 *   ② 总线每隔约 10 格红石线要插一个刷新中继器，于是各轨抽头经过的中继器数不同 →
 *      链条起点必须补偿 xStart = X0 + 2·T_L，而【内容】按全局单位摆（x = X0 + 2u + 1）
 *      —— 否则整条轨会晚 T_L 个单位（实战：钢琴右手晚 100ms）；
 *   ③ 刷新中继器不能落在任何一条轨的 z 上（那条轨的抽头会贴着中继器的轴向取不到电），
 *      且要求连续三格同高（中继器要平放）。
 */

/** 轨定义：位置与乐器都来自这里 */
export interface LaneSpec {
  /** 唯一标识 / 显示名（也用作标签文件名） */
  label: string
  /** 乐器名 → 数据包 data/<ns>/glissando/note_block_instrument/<instrument>.json */
  instrument: string
  /** 载体方块（红石导体，且不能落在 mod 内置标签里） */
  block: string
  /** 走道的哪一侧 */
  side: 'N' | 'S'
  /** 该侧第几条（1 起）：z = walkMid ∓ pos·gap，dy = 1 + 2·(pos−1) */
  pos: number
  /** 音域窗口（有音高轨）；null = 无音高打击乐轨 */
  window: [number, number] | null
  /** 采样录音音高（缺省 = window[0] + 12）；note = midi − sample + 12 */
  sample?: number
  /** 源轨号（谱面 notes[].track 命中哪些就归这条轨） */
  tracks: number[]
  /** 打击乐：接受哪些 GM 鼓键 */
  keys?: number[]
  /** 打击乐：固定 note 值（默认 12 = 采样原始音高） */
  tune?: number
  /** 打击乐：按 GM 鼓键换载体方块（一条轨出多种鼓声；键为字符串形式的鼓键号） */
  keyBlocks?: Record<string, string>
  /** 抽稀：只保留 unit 为该值倍数的音（打击乐常用 2） */
  thin?: number
  /** 镜像哪条轨（逐音复制，用于走道两侧同时发声） */
  mirrorOf?: string
}

export interface GeometryOptions {
  /** 链条基准 x（各轨实际起点 = originX + 2·delay） */
  originX: number
  /** 走道 y */
  baseY: number
  /** 走道中心 z */
  walkMid: number
  /** 相邻轨的 z 间距（格） */
  laneGap: number
  /** 尾巴：末尾多留几个单位，避免最后一个音被后续结构压住 */
  tailUnits: number
  /** 总线每铺多少格红石线插一个刷新中继器 */
  busRefreshInterval: number
}

export const DEFAULT_GEOMETRY: GeometryOptions = {
  originX: 250,
  baseY: 180,
  walkMid: 520,
  laneGap: 5,
  tailUnits: 4,
  busRefreshInterval: 12,
}

export interface LaidOutLane extends LaneSpec {
  z: number
  dy: number
  /** 经过的总线刷新中继器个数（= 需要补偿的单位数） */
  delay: number
  /** 链条起点 x（含延迟补偿） */
  xStart: number
}

export interface LaneLayout {
  lanes: LaidOutLane[]
  walkZ: [number, number]
  leverZ: number
  zMin: number
  zMax: number
  x0: number
  xEnd: number
  units: number
  /** z → 该 z 上总线的高度 dy（阶梯） */
  busProfile: Map<number, number>
  /** 总线刷新中继器 */
  busRepeaters: { z: number; facing: 'north' | 'south' }[]
}

/** 单位的 y 坐标 */
export function laneY(options: GeometryOptions, dy: number): number {
  return options.baseY + dy
}

/**
 * 总线沿 z 走阶梯：每个锚点（各轨 z 与走道）有自己的高度，
 * 中途在满足"剩余格数 ≥ 2×高度差"的前提下逐格过渡，保证不会出现竖直断崖。
 */
export function busProfile(
  options: GeometryOptions,
  anchors: readonly { z: number; dy: number }[],
  zMin: number,
  zMax: number,
): Map<number, number> {
  const sorted = [...anchors].sort((a, b) => a.z - b.z)
  const profile = new Map<number, number>()
  let height = 1
  for (let z = zMin; z <= zMax; z++) {
    const next = sorted.find((a) => a.z >= z) ?? sorted[sorted.length - 1]
    if (!next) throw new Error('总线锚点为空')
    if (z === next.z) {
      height = next.dy
    } else {
      const remain = next.z - z
      const diff = next.dy - height
      if (diff !== 0 && remain <= 2 * Math.abs(diff)) height += Math.sign(diff)
    }
    profile.set(z, height)
  }
  for (const a of sorted) {
    if (profile.get(a.z) !== a.dy) {
      throw new Error(`总线在 z=${a.z} 是 ${profile.get(a.z)}，但该处要求 dy=${a.dy}（阶梯过渡来不及）`)
    }
  }
  return profile
}

/**
 * 总线刷新中继器位置：从拉杆往两侧走，累计红石线超过 busRefreshInterval 就插一个。
 * 约束：不能落在任何一条轨的 z 上，且要连续三格同高。
 */
export function busRepeaters(
  options: GeometryOptions,
  profile: Map<number, number>,
  laneZs: readonly number[],
  leverZ: number,
  zMin: number,
  zMax: number,
): { z: number; facing: 'north' | 'south' }[] {
  const out: { z: number; facing: 'north' | 'south' }[] = []
  const laneZ = new Set(laneZs)
  const ok = (z: number): boolean =>
    z > zMin &&
    z < zMax &&
    !laneZ.has(z) &&
    profile.get(z - 1) === profile.get(z) &&
    profile.get(z + 1) === profile.get(z)
  for (const dir of [-1, 1] as const) {
    let count = 0
    for (let z = leverZ + dir; z >= zMin && z <= zMax; z += dir) {
      count++
      if (count < options.busRefreshInterval) continue
      let found: number | null = null
      for (let k = 0; k <= 10 && found === null; k++) {
        for (const cand of [z + dir * k, z - dir * k]) {
          if (ok(cand)) {
            found = cand
            break
          }
        }
      }
      if (found === null) throw new Error(`总线刷新器没找到合法位置（z≈${z}）`)
      out.push({ z: found, facing: dir < 0 ? 'south' : 'north' })
      count = Math.abs(found - z)
    }
  }
  return out.sort((a, b) => a.z - b.z)
}

/** 每条轨经过几个总线刷新器 → 链条起点补偿多少格（2 格 = 1 个单位） */
export function laneDelays(
  repeaters: readonly { z: number }[],
  laneZs: readonly number[],
  leverZ: number,
): number[] {
  return laneZs.map((z) => repeaters.filter((r) => (z < leverZ ? r.z > z && r.z <= leverZ : r.z >= leverZ && r.z < z)).length)
}

/** 把轨定义摊平到具体坐标，并算出各轨延迟与链条起点 */
export function layoutLanes(
  lanes: readonly LaneSpec[],
  options: GeometryOptions,
  units: number,
): LaneLayout {
  if (lanes.length === 0) throw new Error('至少需要一条轨')
  const walkZ: [number, number] = [options.walkMid, options.walkMid + 1]
  const leverZ = options.walkMid
  const positioned = lanes.map((lane) => {
    if (lane.side === 'N') return { ...lane, z: options.walkMid - lane.pos * options.laneGap, dy: 1 + 2 * (lane.pos - 1) }
    return { ...lane, z: options.walkMid + 1 + lane.pos * options.laneGap, dy: 1 + 2 * (lane.pos - 1) }
  })
  // ★ 总线范围必须【包含走道与拉杆】：总线本体、拉杆、按钮都铺在 walkZ 上，
  //   只按各轨 z 取范围会让走道落在范围外（profile 里查不到 → 建出来是断的）。
  const zMin = Math.min(...positioned.map((l) => l.z), walkZ[0])
  const zMax = Math.max(...positioned.map((l) => l.z), walkZ[1]) + 1
  const profile = busProfile(
    options,
    [...positioned.map((l) => ({ z: l.z, dy: l.dy })), { z: walkZ[0], dy: 1 }],
    zMin,
    zMax,
  )
  const repeaters = busRepeaters(
    options,
    profile,
    positioned.map((l) => l.z),
    leverZ,
    zMin,
    zMax,
  )
  const delays = laneDelays(repeaters, positioned.map((l) => l.z), leverZ)
  const laid: LaidOutLane[] = positioned.map((lane, index) => {
    const delay = delays[index] ?? 0
    return { ...lane, delay, xStart: options.originX + 2 * delay }
  })
  return {
    lanes: laid,
    walkZ,
    leverZ,
    zMin,
    zMax,
    x0: options.originX,
    xEnd: options.originX + 2 * units + 8,
    units,
    busProfile: profile,
    busRepeaters: repeaters,
  }
}
