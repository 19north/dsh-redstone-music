/**
 * score.ts —— 把谱面（MIDI 导出的音符表）分配到各条轨的"槽位"上（纯计算，可单测）
 *
 * 分配规则复刻实战结论：
 *   · 一个载体方块最多让 3 个音符盒发声：上方的 top + 南北两个 sides → 每轨每单位 ≤3；
 *   · 有音高轨优先选"移调量最小"的槽（同一条旋律落在同一个采样上，音色才一致）；
 *   · 音符盒 note 必须落在 0..24：note = midi − sample + 12（sample 缺省回退 window[0]+12）；
 *   · 打击乐固定 note = tune（默认 12 = 采样原始音高），可选抽稀（thin）；
 *   · 与十六分网格偏差过大的音（自由处理/装饰音）直接丢弃 —— 硬塞只会听起来"跳"。
 */

import type { LaneSpec } from './lane-layout'

export interface SongNote {
  /** 秒 */
  t: number
  /** MIDI 音高（0..127） */
  midi: number
  /** 源轨号 */
  track: number
}

export interface SongPlan {
  bpm: number
  /** 第一个音符的绝对时间基准（秒） */
  start: number
  notes: SongNote[]
}

export interface AllocateOptions {
  /** 一个音乐单位的时长（秒）；缺省 = 60 / bpm / 4（十六分音符） */
  unitSeconds?: number
  /** 只取 [startUnit, endUnit] 区间（单位号，含端点）；缺省取全曲 */
  startUnit?: number
  endUnit?: number
  /** 网格容差（单位时长的比例）；超过就丢，默认 0.21 */
  offGridTolerance?: number
  /** 每轨每单位最多几个音符盒（默认 3） */
  maxPerUnit?: number
}

/** 摆好的一个音符盒：note 值 + 可选的自定义载体方块（打击乐逐音换音色用） */
export interface PlacedNote {
  note: number
  /** 覆盖该轨默认载体方块（例如同一轨里 15 种鼓声靠换载体实现），缺省 = lane.block */
  block?: string
}

/** 一条轨上摆好的音：top = 载体正上方，sides = 南北两侧 */
export interface LaneNotes {
  top: Map<number, PlacedNote>
  sides: Map<number, PlacedNote[]>
}

export interface AllocateStats {
  total: number
  placed: number
  dropped: number
  outOfWindow: number
  offGrid: number
  thinned: number
  capacity: number
  perLane: Record<string, number>
}

export interface AllocateResult {
  /** 轨 label → 摆好的音 */
  notes: Map<string, LaneNotes>
  stats: AllocateStats
  unitSeconds: number
  /** 让单位时长正好等于 2 个游戏刻所需的 tick rate（1 单位 = 2 刻） */
  tickRate: number
  maxUnit: number
  units: number
  startUnit: number
  endUnit: number
}

function emptyLaneNotes(): LaneNotes {
  return { top: new Map(), sides: new Map() }
}

/** 把谱面音符按单位时长折叠到整数单位号上 */
export function unitOf(note: SongNote, plan: SongPlan, unitSeconds: number): number {
  return Math.round((note.t - plan.start) / unitSeconds)
}

/**
 * 分配音符到轨与槽位。
 * 轨的优先级 = 在 lanes 数组里的顺序（越靠前越优先拿音）。
 */
export function allocateNotes(
  plan: SongPlan,
  lanes: readonly LaneSpec[],
  options: AllocateOptions = {},
): AllocateResult {
  if (!(plan.bpm > 0)) throw new Error('谱面缺少有效的 bpm')
  const unitSeconds = options.unitSeconds ?? 60 / plan.bpm / 4
  const tolerance = options.offGridTolerance ?? 0.21
  const maxPerUnit = options.maxPerUnit ?? 3
  const notes = new Map<string, LaneNotes>()
  for (const lane of lanes) notes.set(lane.label, emptyLaneNotes())

  let maxUnit = 0
  for (const note of plan.notes) maxUnit = Math.max(maxUnit, unitOf(note, plan, unitSeconds))
  const startUnit = options.startUnit ?? 0
  const endUnit = options.endUnit ?? maxUnit
  const units = endUnit - startUnit + 1

  const stats: AllocateStats = {
    total: 0,
    placed: 0,
    dropped: 0,
    outOfWindow: 0,
    offGrid: 0,
    thinned: 0,
    capacity: 0,
    perLane: {},
  }
  // 把 lanes 摊平成"可选槽"，并按数组顺序记优先级
  const candidates = lanes.map((lane, index) => ({ lane, index }))
  const loadOf = (label: string, unit: number): number => {
    const target = notes.get(label)
    if (!target) return 0
    return (target.top.has(unit) ? 1 : 0) + (target.sides.get(unit)?.length ?? 0)
  }

  const buckets = new Map<number, SongNote[]>()
  for (const note of plan.notes) {
    const unit = unitOf(note, plan, unitSeconds)
    if (unit < startUnit || unit > endUnit) continue
    const drift = Math.abs(note.t - plan.start - unit * unitSeconds)
    if (drift > tolerance * unitSeconds) {
      stats.offGrid++
      continue
    }
    const list = buckets.get(unit)
    if (list) list.push(note)
    else buckets.set(unit, [note])
  }

  for (const unit of [...buckets.keys()].sort((a, b) => a - b)) {
    const list = buckets.get(unit) as SongNote[]
    list.sort((a, b) => {
      const pa = candidates.findIndex((c) => c.lane.tracks.includes(a.track))
      const pb = candidates.findIndex((c) => c.lane.tracks.includes(b.track))
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || b.midi - a.midi
    })
    for (const note of list) {
      stats.total++
      const local = unit - startUnit
      const pool = candidates.filter(
        (c) =>
          c.lane.tracks.includes(note.track) &&
          (c.lane.window === null ? (c.lane.keys ?? []).includes(note.midi) : true),
      )
      if (pool.length === 0) {
        stats.dropped++
        continue
      }
      const drumSlot = pool.find((c) => c.lane.window === null)
      let label: string
      let value: number
      let block: string | undefined
      if (drumSlot) {
        // 无音高打击乐槽：固定调音；必要时抽稀；可按鼓键换载体方块（一条轨出多种鼓声）
        label = drumSlot.lane.label
        value = drumSlot.lane.tune ?? 12
        const override = drumSlot.lane.keyBlocks?.[String(note.midi)]
        if (override && override !== drumSlot.lane.block) block = override
        const thin = drumSlot.lane.thin ?? 1
        if (thin > 1 && unit % thin !== 0) {
          stats.thinned++
          continue
        }
      } else {
        const inWindow = pool.filter(
          (c) => note.midi >= (c.lane.window as [number, number])[0] && note.midi <= (c.lane.window as [number, number])[1],
        )
        if (inWindow.length === 0) {
          stats.outOfWindow++
          stats.dropped++
          continue
        }
        const withRoom = inWindow.filter((c) => loadOf(c.lane.label, local) < maxPerUnit)
        if (withRoom.length === 0) {
          stats.capacity++
          stats.dropped++
          continue
        }
        withRoom.sort((a, b) => {
          const sa = a.lane.sample ?? ((a.lane.window as [number, number])[0] + 12)
          const sb = b.lane.sample ?? ((b.lane.window as [number, number])[0] + 12)
          return Math.abs(note.midi - sa) - Math.abs(note.midi - sb) || loadOf(a.lane.label, local) - loadOf(b.lane.label, local)
        })
        const chosen = withRoom[0] as { lane: LaneSpec }
        label = chosen.lane.label
        const sample = chosen.lane.sample ?? ((chosen.lane.window as [number, number])[0] + 12)
        // ★ 关键公式：note = midi − sample + 12（sample 必须显式记录，不能靠隐式约定）
        value = note.midi - sample + 12
        if (value < 0 || value > 24) {
          stats.outOfWindow++
          stats.dropped++
          continue
        }
      }
      const target = notes.get(label) as LaneNotes
      const placed: PlacedNote = block === undefined ? { note: value } : { note: value, block }
      if (!target.top.has(local)) {
        target.top.set(local, placed)
      } else {
        const sides = target.sides.get(local) ?? []
        if (sides.length < maxPerUnit - 1) {
          sides.push(placed)
          target.sides.set(local, sides)
        } else {
          stats.capacity++
          stats.dropped++
          continue
        }
      }
      stats.placed++
      stats.perLane[label] = (stats.perLane[label] ?? 0) + 1
    }
  }

  // 镜像轨：逐音复制（走道两侧同时发声）
  for (const lane of lanes) {
    if (!lane.mirrorOf) continue
    const source = notes.get(lane.mirrorOf)
    const target = notes.get(lane.label) as LaneNotes
    if (!source) throw new Error(`镜像轨 ${lane.label} 找不到源轨 ${lane.mirrorOf}`)
    for (const [unit, note] of source.top) target.top.set(unit, note)
    for (const [unit, sides] of source.sides) target.sides.set(unit, [...sides])
    stats.perLane[lane.label] = target.top.size + [...target.sides.values()].reduce((a, b) => a + b.length, 0)
  }

  return {
    notes,
    stats,
    unitSeconds,
    tickRate: 2 / unitSeconds,
    maxUnit,
    units,
    startUnit,
    endUnit,
  }
}

/** 每条轨实际的音符盒个数 */
export function noteCount(notes: LaneNotes): number {
  return notes.top.size + [...notes.sides.values()].reduce((a, b) => a + b.length, 0)
}
