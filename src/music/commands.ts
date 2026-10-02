/**
 * commands.ts —— 把"摆好的音"翻译成 Minecraft 命令（纯计算，可单测）
 *
 * 建造顺序 = 清场 → 铺底 → 元件，且【元件按 y/x/z 排序】：
 *   先铺支撑层再放中继器，中继器才不会当场弹掉（`repeater-support` 那条教训）。
 *
 * 清场刻意只清到空气、随后用【白混凝土】铺回支撑层 —— 中继器必须坐在固体方块上。
 */
import type { LaneLayout, LaidOutLane } from './lane-layout'
import type { LaneNotes } from './score'

export interface Cell {
  x: number
  y: number
  z: number
  block: string
  tag: string
}

export interface CommandOptions {
  /** 铺底方块（必须是固体；清场后靠它给中继器当支撑） */
  wallBlock: string
  /** 链条中继器（默认 facing=west：波前向东推，输入来自西边） */
  repeater: string
  /** 音符盒方块状态模板；Glissando 接管后 note_block 没有 instrument 属性了 */
  noteBlock: (note: number) => string
  /** 清场是否包含实体清理（kill @e[type=!player]）——负载杀手之一 */
  clearEntities: boolean
}

export const DEFAULT_COMMANDS: CommandOptions = {
  wallBlock: 'minecraft:white_concrete',
  repeater: 'minecraft:repeater[facing=west,delay=1]',
  noteBlock: (note) => `minecraft:note_block[note=${note},powered=false]`,
  clearEntities: false,
}

export interface CommandPlan {
  /** 清场（fill … air），分段以遵守单条 fill 上限 */
  clears: string[]
  /** 铺底（走道 + 每条轨的支撑条） */
  fills: string[]
  /** 元件（总线、抽头、中继器、载体、音符盒、拉杆/按钮） */
  cells: Cell[]
  /** 实际要写进 mcfunction 的命令序列 */
  commands: string[]
  /** 唤醒中继器用的重放命令（保留各自 facing，不能统一成 west） */
  repeaterCommands: string[]
  bounds: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
  counts: { clears: number; fills: number; cells: number; commands: number }
}

/** 单条 fill 的方块上限 */
const FILL_LIMIT = 30000

/**
 * 生成完整建造命令序列。
 * `notesOf(lane)` 返回该轨摆好的音（top/sides）。
 */
export function buildCommands(
  layout: LaneLayout,
  notesOf: (lane: LaidOutLane) => LaneNotes,
  geometryY: (dy: number) => number,
  options: CommandOptions = DEFAULT_COMMANDS,
): CommandPlan {
  const { x0, xEnd, walkZ, leverZ, zMin, zMax, units } = layout
  const Y = geometryY
  const maxDy = Math.max(1, ...layout.lanes.map((l) => l.dy))
  const y1 = Y(0) - 4
  const y2 = Y(maxDy + 2)

  // ── 清场：按 x 分段、z 每 4 格一条，控制在单条 fill 上限内
  const clears: string[] = []
  const dx = Math.max(1, Math.floor(FILL_LIMIT / ((y2 - y1 + 1) * 4)))
  for (let xs = x0 - 14; xs <= xEnd + 2; xs += dx) {
    const xe = Math.min(xs + dx - 1, xEnd + 2)
    for (let zs = zMin - 4; zs <= zMax + 4; zs += 4) {
      clears.push(`fill ${xs} ${y1} ${zs} ${xe} ${y2} ${Math.min(zs + 3, zMax + 4)} minecraft:air`)
    }
  }
  if (options.clearEntities) clears.push('kill @e[type=!player]')

  // ── 铺底：走道 + 每条轨的支撑条（含侧挂音符盒的底）
  const fills: string[] = []
  for (const z of walkZ) fills.push(`fill ${x0 - 10} ${Y(0)} ${z} ${xEnd} ${Y(0)} ${z} ${options.wallBlock}`)
  for (const lane of layout.lanes) {
    const y = Y(lane.dy)
    fills.push(`fill ${x0 - 2} ${y - 1} ${lane.z} ${xEnd} ${y - 1} ${lane.z} ${options.wallBlock}`)
    fills.push(`fill ${x0 - 2} ${y - 3} ${lane.z - 1} ${xEnd} ${y - 3} ${lane.z + 1} ${options.wallBlock}`)
  }

  // ── 元件
  const cells: Cell[] = []
  const push = (x: number, y: number, z: number, block: string, tag: string): void => {
    cells.push({ x, y, z, block, tag })
  }
  const busX = x0 - 2
  const repeaterByZ = new Map(layout.busRepeaters.map((r) => [r.z, r]))
  for (let z = zMin; z <= zMax; z++) {
    const h = layout.busProfile.get(z) ?? 1
    const repeater = repeaterByZ.get(z)
    push(
      busX,
      Y(h),
      z,
      repeater ? `minecraft:repeater[facing=${repeater.facing},delay=1]` : 'minecraft:redstone_wire',
      `总线 z=${z} dy=${h}`,
    )
    push(busX, Y(h) - 1, z, options.wallBlock, `总线支撑 z=${z}`)
  }
  push(x0 - 3, Y(1), leverZ, 'minecraft:lever[face=floor,facing=north,powered=false]', '拉杆')
  push(x0 - 1, Y(1), leverZ, 'minecraft:stone_button[face=floor,facing=north,powered=false]', '播放按钮')
  push(x0 - 3, Y(0), leverZ, options.wallBlock, '拉杆底座')

  for (const lane of layout.lanes) {
    const y = Y(lane.dy)
    const notes = notesOf(lane)
    // 抽头：从总线沿 x 铺红石线到链条起点之前
    for (let x = x0 - 1; x < lane.xStart; x++) push(x, y, lane.z, 'minecraft:redstone_wire', `${lane.label}:抽头走线`)
    push(lane.xStart - 1, y, lane.z, 'minecraft:redstone_wire', `${lane.label}:抽头末`)
    for (let m = 0; m < units; m++) {
      // ★ 延迟补偿：链条第 m 格对应【全局单位】m + delay（内容按全局单位摆）
      const unit = m + lane.delay
      const xr = lane.xStart + 2 * m
      const xc = xr + 1
      push(xr, y, lane.z, options.repeater, `${lane.label}:R${unit}`)
      const top = notes.top.get(unit)
      // 载体方块：音符可以自带覆盖（打击乐逐音换音色），缺省用该轨的载体
      push(xc, y, lane.z, top?.block ?? lane.block, `${lane.label}:载体${unit}`)
      if (top) push(xc, y + 1, lane.z, options.noteBlock(top.note), `${lane.label}:音${unit}=${top.note}`)
      const sides = notes.sides.get(unit)
      if (sides) {
        sides.forEach((placed, index) => {
          const zz = lane.z + (index === 0 ? -1 : 1)
          push(xc, y - 1, zz, placed.block ?? lane.block, `${lane.label}:侧垫${unit}`)
          push(xc, y, zz, options.noteBlock(placed.note), `${lane.label}:侧${unit}=${placed.note}`)
        })
      }
    }
  }

  // 排序：先低后高、先西后东 —— 支撑层总是先于坐在它上面的元件
  cells.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
  const setblocks = cells.map((c) => `setblock ${c.x} ${c.y} ${c.z} ${c.block}`)
  const repeaterCommands = cells.filter((c) => c.block.startsWith('minecraft:repeater')).map((c) => `setblock ${c.x} ${c.y} ${c.z} ${c.block}`)
  const commands = [...clears, ...fills, ...setblocks]

  return {
    clears,
    fills,
    cells,
    commands,
    repeaterCommands,
    bounds: { x1: x0 - 14, y1, z1: zMin - 4, x2: xEnd + 2, y2, z2: zMax + 4 },
    counts: { clears: clears.length, fills: fills.length, cells: cells.length, commands: commands.length },
  }
}

export interface Shard {
  name: string
  lines: string[]
}

/**
 * 把命令切成 mcfunction 分片。
 * ★ maxCommandChainLength 默认 65536/刻，单刻执行几千条既快又不触发看门狗；
 *   片间用 `schedule function <ns>:buildN+1 2t` 跨 tick 衔接（每片 8000 条是实战值）。
 */
export function packShards(commands: readonly string[], shardSize: number, namespace: string): Shard[] {
  if (shardSize < 1) throw new Error('shardSize 必须 ≥1')
  const shards: Shard[] = []
  for (let i = 0; i < commands.length; i += shardSize) {
    shards.push({ name: `build${shards.length + 1}`, lines: commands.slice(i, i + shardSize) as string[] })
  }
  shards.forEach((shard, index) => {
    const next = shards[index + 1]
    shard.lines.push(next ? `schedule function ${namespace}:${next.name} 2t` : `schedule function ${namespace}:refresh 2t`)
  })
  return shards
}

/** 唤醒中继器：同一批重放两轮（分两个 tick），让被"平放"的中继器重新计算状态 */
export function packRefreshShards(repeaterCommands: readonly string[], namespace: string): Shard[] {
  return [
    { name: 'refresh', lines: [...repeaterCommands, `schedule function ${namespace}:refresh2 2t`] },
    { name: 'refresh2', lines: [...repeaterCommands] },
  ]
}

/**
 * 强加载分段：单条 /forceload add 最多 256 区块（实测踩过两次），必须分段。
 * 这里按 x 方向切，保证每段的区块数不超过 maxChunks。
 */
export function forceloadSegments(
  bounds: { x1: number; z1: number; x2: number; z2: number },
  maxChunks = 240,
): { x1: number; z1: number; x2: number; z2: number }[] {
  const chunk = 16
  const zChunks = Math.max(1, Math.floor(bounds.z2 / chunk) - Math.floor(bounds.z1 / chunk) + 1)
  const maxXChunks = Math.max(1, Math.floor(maxChunks / zChunks))
  const spanBlocks = maxXChunks * chunk
  const out: { x1: number; z1: number; x2: number; z2: number }[] = []
  for (let x = bounds.x1; x <= bounds.x2; x += spanBlocks) {
    out.push({ x1: x, z1: bounds.z1, x2: Math.min(x + spanBlocks - 1, bounds.x2), z2: bounds.z2 })
  }
  return out
}

export function forceloadCommands(segments: readonly { x1: number; z1: number; x2: number; z2: number }[]): string[] {
  return segments.map((s) => `forceload add ${s.x1} ${s.z1} ${s.x2} ${s.z2}`)
}
