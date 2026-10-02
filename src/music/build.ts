/**
 * build.ts —— 把「谱面 + 轨表」编译成数据包（纯计算；写盘由 datapack.ts 负责）
 *
 * 这里是 PIPELINE 第 3/5/7 步的合体：
 *   分析后的谱面 → 分配到轨与槽位 → 摊平到坐标（含总线延迟补偿）→ 生成命令 →
 *   切 mcfunction 分片 → 顺带产出 Glissando 乐器定义（sound_event 一律原版事件）。
 *
 * 所有"配错了会静默出错音/断链"的情况都在这里【响亮失败】，而不是等到用户听出来。
 */
import {
  DEFAULT_GEOMETRY,
  layoutLanes,
  laneY,
  type GeometryOptions,
  type LaneLayout,
  type LaneSpec,
} from './lane-layout'
import { allocateNotes, type AllocateOptions, type AllocateResult, type LaneNotes, type SongPlan } from './score'
import { buildCommands, packRefreshShards, packShards, DEFAULT_COMMANDS, type CommandOptions, type CommandPlan, type Shard } from './commands'
import { assignSoundEvents, type InstrumentDefinition } from './datapack'

/** 红石非导体：中继器无法强充能它 → 上面的音符盒永远不响（实战：整条轨在第 1~2 级就断链） */
export const NON_CONDUCTIVE_BLOCKS = new Set(['minecraft:glass', 'minecraft:glowstone'])

/**
 * 被 Glissando 内置标签圈走的方块（612 种的一大半）——用它们当载体 = 音色被抢走，
 * 实测直接导致"整首曲子变成鼓声/全是错音"。
 */
export const OCCUPIED_BLOCKS = new Set([
  // basedrum ⊃ #base_stone_overworld
  'minecraft:stone', 'minecraft:deepslate', 'minecraft:granite', 'minecraft:diorite', 'minecraft:andesite',
  'minecraft:tuff', 'minecraft:calcite', 'minecraft:dripstone_block', 'minecraft:cobblestone', 'minecraft:obsidian',
  'minecraft:purpur_block', 'minecraft:prismarine', 'minecraft:netherrack', 'minecraft:quartz_block',
  // bass ⊃ 木板系 / 其他
  'minecraft:oak_planks', 'minecraft:spruce_planks', 'minecraft:birch_planks', 'minecraft:jungle_planks',
  'minecraft:acacia_planks', 'minecraft:dark_oak_planks', 'minecraft:mangrove_planks', 'minecraft:cherry_planks',
  'minecraft:bamboo_block', 'minecraft:jukebox', 'minecraft:loom', 'minecraft:composter',
  // hat ⊃ 玻璃系 / pling ⊃ 荧石 / guitar ⊃ 羊毛系
  'minecraft:glass', 'minecraft:glowstone', 'minecraft:white_wool', 'minecraft:orange_wool', 'minecraft:magenta_wool',
  'minecraft:light_blue_wool', 'minecraft:yellow_wool', 'minecraft:lime_wool', 'minecraft:pink_wool',
  'minecraft:gray_wool', 'minecraft:light_gray_wool', 'minecraft:cyan_wool', 'minecraft:purple_wool',
  'minecraft:blue_wool', 'minecraft:brown_wool', 'minecraft:green_wool', 'minecraft:red_wool', 'minecraft:black_wool',
])

/** 文档实测安全的载体方块（挑够用即可） */
export const SAFE_CARRIER_BLOCKS = new Set([
  'minecraft:moss_block', 'minecraft:mud', 'minecraft:packed_mud', 'minecraft:sculk', 'minecraft:sculk_catalyst',
  'minecraft:honeycomb_block', 'minecraft:honey_block', 'minecraft:slime_block', 'minecraft:dried_kelp_block',
  'minecraft:amethyst_block', 'minecraft:budding_amethyst', 'minecraft:copper_block', 'minecraft:exposed_copper',
  'minecraft:weathered_copper', 'minecraft:oxidized_copper', 'minecraft:waxed_copper_block',
  'minecraft:waxed_exposed_copper', 'minecraft:waxed_weathered_copper', 'minecraft:waxed_oxidized_copper',
  'minecraft:cut_copper', 'minecraft:waxed_cut_copper', 'minecraft:netherite_block', 'minecraft:ancient_debris',
  'minecraft:lodestone', 'minecraft:shroomlight', 'minecraft:ochre_froglight', 'minecraft:verdant_froglight',
  'minecraft:pearlescent_froglight', 'minecraft:soul_soil', 'minecraft:sponge', 'minecraft:wet_sponge',
  'minecraft:melon', 'minecraft:carved_pumpkin', 'minecraft:jack_o_lantern', 'minecraft:nether_wart_block',
  'minecraft:warped_wart_block', 'minecraft:target', 'minecraft:iron_bars', 'minecraft:chain', 'minecraft:lantern',
  'minecraft:soul_lantern', 'minecraft:bell', 'minecraft:cauldron', 'minecraft:moss_carpet', 'minecraft:vine',
  'minecraft:glow_lichen', 'minecraft:cobweb', 'minecraft:dragon_egg', 'minecraft:turtle_egg',
  'minecraft:end_rod', 'minecraft:lightning_rod', 'minecraft:muddy_mangrove_roots', 'minecraft:rooted_dirt',
])

export interface BuildProject {
  song: SongPlan
  lanes: LaneSpec[]
  geometry?: Partial<GeometryOptions>
}

export interface BuildPlanOptions {
  namespace: string
  packFormat?: number
  shardSize?: number
  allocation?: AllocateOptions
  /** 明确知道自己验证过标签无歧义时，才允许用被 mod 圈走的方块 */
  allowOccupiedBlocks?: boolean
  commands?: Partial<CommandOptions>
}

export interface BuildPlan {
  layout: LaneLayout
  allocation: AllocateResult
  commands: CommandPlan
  shards: Shard[]
  refreshShards: Shard[]
  instruments: InstrumentDefinition[]
  /** 写进数据包的元数据，供验证工具读取（避免各处硬编码坐标导致误报） */
  meta: Record<string, unknown>
  warnings: string[]
  tickRate: number
  unitSeconds: number
  units: number
}

/** 校验载体方块：非导体一定断链；落在 mod 内置标签里一定被抢音色 */
export function validateCarrierBlocks(lanes: readonly LaneSpec[], allowOccupied: boolean): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const blocks = new Set<string>()
  for (const lane of lanes) {
    blocks.add(lane.block)
    for (const block of Object.values(lane.keyBlocks ?? {})) blocks.add(block)
  }
  for (const block of blocks) {
    if (NON_CONDUCTIVE_BLOCKS.has(block)) {
      errors.push(`${block} 是红石非导体：中继器无法强充能它 → 该轨的音符盒永远不响（换 clay 这类导体）`)
      continue
    }
    if (OCCUPIED_BLOCKS.has(block)) {
      const message =
        `${block} 落在 Glissando 内置标签里（basedrum/bass/hat/pling/guitar 圈走了 612 种方块）→ 音色会被抢走，` +
        '实测会让整首曲子变成鼓声/全是错音'
      if (allowOccupied) warnings.push(`${message}（已 allowOccupiedBlocks，请用标签断言复核）`)
      else errors.push(`${message}。改从安全集合里挑（moss_block/mud/sculk/amethyst_block/copper_block/netherite_block/lodestone/shroomlight/sponge…）`)
      continue
    }
    if (!SAFE_CARRIER_BLOCKS.has(block)) {
      warnings.push(`${block} 不在实测安全清单里：放进世界后必须用 execute if block <x> <y> <z> #<ns>:note_block_instruments/<乐器> 断言无歧义`)
    }
  }
  return { errors, warnings }
}

/**
 * 收集乐器定义：**每个实际用到的载体方块 = 一个乐器**。
 * 打击乐若用 keyBlocks 逐音换载体，一条轨就会产出多个乐器（名字 = <轨乐器>_<方块短名>）。
 */
export function collectInstruments(
  lanes: readonly LaneSpec[],
  allocation: AllocateResult,
  descriptions: Map<string, string>,
): InstrumentDefinition[] {
  const byName = new Map<string, string>()
  const byBlock = new Map<string, string>()
  const out: InstrumentDefinition[] = []
  const add = (name: string, block: string, lane: LaneSpec): void => {
    const existingName = byName.get(name)
    if (existingName && existingName !== block) throw new Error(`乐器名 ${name} 同时指向 ${existingName} 与 ${block}（乐器名必须与载体方块一一对应）`)
    const existingBlock = byBlock.get(block)
    if (existingBlock && existingBlock !== name) throw new Error(`载体方块 ${block} 同时被 ${existingBlock} 与 ${name} 使用（一个方块只能属于一个乐器）`)
    if (existingName) return
    byName.set(name, block)
    byBlock.set(block, name)
    out.push({
      name,
      block,
      description: `${descriptions.get(lane.label) ?? lane.label}·${block.replace('minecraft:', '')}`,
      // 占位：下面统一按顺序分配原版事件
      soundEvent: '',
    })
  }
  for (const lane of lanes) {
    const notes = allocation.notes.get(lane.label)
    const used = new Set<string>([lane.block])
    if (notes) {
      for (const placed of notes.top.values()) if (placed.block) used.add(placed.block)
      for (const sides of notes.sides.values()) for (const placed of sides) if (placed.block) used.add(placed.block)
    }
    for (const block of used) {
      const name = block === lane.block ? lane.instrument : `${lane.instrument}_${block.replace('minecraft:', '')}`
      add(name, block, lane)
    }
  }
  const events = assignSoundEvents(out.length)
  return out.map((instrument, index) => ({ ...instrument, soundEvent: events[index] as string }))
}

/** 谱面 + 轨表 → 完整建造计划 */
export function planBuild(project: BuildProject, options: BuildPlanOptions): BuildPlan {
  if (!options.namespace || !/^[a-z0-9_]+$/.test(options.namespace)) {
    throw new Error(`命名空间 ${options.namespace} 非法（只能小写字母数字下划线）`)
  }
  if (project.lanes.length === 0) throw new Error('轨表为空')
  const geometry: GeometryOptions = { ...DEFAULT_GEOMETRY, ...project.geometry }
  const check = validateCarrierBlocks(project.lanes, options.allowOccupiedBlocks ?? false)
  if (check.errors.length > 0) throw new Error(`载体方块有问题：\n  - ${check.errors.join('\n  - ')}`)

  const allocation = allocateNotes(project.song, project.lanes, options.allocation ?? {})
  const units = allocation.units + geometry.tailUnits
  const layout = layoutLanes(project.lanes, geometry, units)
  const notesOf = (lane: { label: string }): LaneNotes => allocation.notes.get(lane.label) as LaneNotes
  const commands = buildCommands(layout, notesOf, (dy) => laneY(geometry, dy), { ...DEFAULT_COMMANDS, ...options.commands })
  const shardSize = options.shardSize ?? 8000
  const shards = packShards(commands.commands, shardSize, options.namespace)
  const refreshShards = packRefreshShards(commands.repeaterCommands, options.namespace)
  const descriptions = new Map(project.lanes.map((l) => [l.label, l.label]))
  const instruments = collectInstruments(project.lanes, allocation, descriptions)

  const meta = {
    namespace: options.namespace,
    unitSeconds: allocation.unitSeconds,
    tickRate: allocation.tickRate,
    units,
    startUnit: allocation.startUnit,
    endUnit: allocation.endUnit,
    stats: allocation.stats,
    bounds: commands.bounds,
    busRepeaters: layout.busRepeaters,
    lanes: layout.lanes.map((lane) => ({
      label: lane.label,
      instrument: lane.instrument,
      block: lane.block,
      z: lane.z,
      dy: lane.dy,
      delay: lane.delay,
      xStart: lane.xStart,
      notes: (() => {
        const n = allocation.notes.get(lane.label)
        return n ? n.top.size + [...n.sides.values()].reduce((a, b) => a + b.length, 0) : 0
      })(),
    })),
    instruments: instruments.map((i) => ({ name: i.name, block: i.block, soundEvent: i.soundEvent })),
  }

  const warnings = [...check.warnings]
  if (Math.abs(allocation.tickRate - Math.round(allocation.tickRate * 1000) / 1000) > 1e-9) {
    // tick rate 不存档：服务端每次重启都要重设
    warnings.push(`需要 tick rate ${allocation.tickRate.toFixed(3)}，它不存档 → 服务端每次重启都要重新 tick rate 设置`)
  }

  return {
    layout,
    allocation,
    commands,
    shards,
    refreshShards,
    instruments,
    meta,
    warnings,
    tickRate: allocation.tickRate,
    unitSeconds: allocation.unitSeconds,
    units,
  }
}
