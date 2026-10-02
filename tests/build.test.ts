import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planBuild } from '../src/music/build'
import { forceloadSegments, packShards } from '../src/music/commands'
import type { LaneSpec } from '../src/music/lane-layout'
import type { SongPlan } from '../src/music/score'
import { loadProject } from '../src/tool-build'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const lanes: LaneSpec[] = [
  { label: '钢琴·低', instrument: 'piano_low', block: 'minecraft:moss_block', side: 'N', pos: 1, window: [40, 52], sample: 46, tracks: [2] },
  { label: '钢琴·高', instrument: 'piano_high', block: 'minecraft:mud', side: 'N', pos: 2, window: [53, 65], sample: 59, tracks: [2] },
  { label: '鼓', instrument: 'kick', block: 'minecraft:netherite_block', side: 'S', pos: 1, window: null, tracks: [1], keys: [35, 36], tune: 12 },
]

// 120 BPM 十六分 = 0.125s；谱面：钢琴 3 个音 + 底鼓 2 个音
const song: SongPlan = {
  bpm: 120,
  start: 0,
  notes: [
    { t: 0, midi: 46, track: 2 },
    { t: 0.25, midi: 60, track: 2 },
    { t: 0.5, midi: 40, track: 2 },
    { t: 0, midi: 36, track: 1 },
    { t: 0.5, midi: 35, track: 1 },
  ],
}

const project = { song, lanes, geometry: { originX: 100, baseY: 64, walkMid: 300, laneGap: 8 } }

describe('planBuild', () => {
  const plan = planBuild(project, { namespace: 'rm_test', packFormat: 48 })

  it('单位时长与 tick rate 自洽（1 单位 = 2 游戏刻）', () => {
    expect(plan.unitSeconds).toBeCloseTo(0.125, 6)
    expect(plan.tickRate).toBeCloseTo(16, 6)
  })

  it('乐器定义全部用原版 sound_event（自定义命名空间会让整张表加载失败）', () => {
    expect(plan.instruments.length).toBe(3)
    for (const instrument of plan.instruments) expect(instrument.soundEvent.startsWith('minecraft:')).toBe(true)
    expect(new Set(plan.instruments.map((i) => i.soundEvent)).size).toBe(plan.instruments.length)
  })

  it('载体方块落在奇数 x（载体列），中继器落在偶数 x', () => {
    const carriers = plan.commands.cells.filter((c) => c.tag.includes('载体') && !c.tag.includes('侧垫'))
    const repeaters = plan.commands.cells.filter((c) => c.block.startsWith('minecraft:repeater'))
    expect(carriers.length).toBeGreaterThan(0)
    expect(repeaters.length).toBeGreaterThan(0)
    for (const cell of carriers) expect(Math.abs(cell.x % 2)).toBe(1)
    for (const cell of repeaters) expect(cell.x % 2).toBe(0)
  })

  it('★ 延迟补偿：链条第 m 格上的载体对应全局单位 u = m + delay，且 x = originX + 2u + 1', () => {
    let checked = 0
    for (const lane of plan.layout.lanes) {
      for (const cell of plan.commands.cells) {
        const match = new RegExp(`^${lane.label}:载体(\\d+)$`).exec(cell.tag)
        if (!match) continue
        const unit = Number(match[1])
        expect(unit).toBeGreaterThanOrEqual(lane.delay)
        expect(cell.x).toBe(100 + 2 * unit + 1)
        expect(cell.z).toBe(lane.z)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('音符盒不带 instrument 属性（Glissando 接管后该属性不存在）', () => {
    const noteBlocks = plan.commands.cells.filter((c) => c.block.startsWith('minecraft:note_block'))
    expect(noteBlocks.length).toBeGreaterThan(0)
    for (const cell of noteBlocks) {
      expect(cell.block).toMatch(/^minecraft:note_block\[note=\d+,powered=false\]$/)
      expect(cell.block).not.toContain('instrument')
    }
  })

  it('note 值由采样录音音高换算：note = midi − sample + 12', () => {
    // midi 46 → 低轨（sample 46）→ note 12；midi 60 → 高轨（sample 59）→ note 13
    const values = plan.commands.cells
      .filter((c) => c.block.startsWith('minecraft:note_block'))
      .map((c) => Number(/note=(\d+)/.exec(c.block)?.[1]))
    expect(values).toContain(12)
    expect(values).toContain(13)
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(24)
    }
  })

  it('清场只填空气、铺底用固体（中继器必须有支撑，否则当场弹掉）', () => {
    expect(plan.commands.clears.length).toBeGreaterThan(0)
    for (const command of plan.commands.clears) expect(command.endsWith('minecraft:air')).toBe(true)
    expect(plan.commands.fills.some((f) => f.includes('minecraft:white_concrete'))).toBe(true)
    // 每条轨的支撑条就在载体下方一格（Y(dy) − 1）
    for (const lane of plan.layout.lanes) {
      const supportY = 64 + lane.dy - 1
      expect(plan.commands.fills.some((f) => f.includes(` ${supportY} ${lane.z} `))).toBe(true)
    }
  })

  it('命令总数 = 清场 + 铺底 + 元件，且元件按 y/x/z 有序（支撑先于其上元件）', () => {
    expect(plan.commands.counts.commands).toBe(plan.commands.counts.clears + plan.commands.counts.fills + plan.commands.counts.cells)
    const cells = plan.commands.cells
    for (let i = 1; i < cells.length; i++) {
      const previous = cells[i - 1] as { x: number; y: number; z: number }
      const current = cells[i] as { x: number; y: number; z: number }
      const ordered = current.y > previous.y || (current.y === previous.y && (current.x > previous.x || (current.x === previous.x && current.z >= previous.z)))
      expect(ordered).toBe(true)
    }
  })

  it('唤醒分片保留各自 facing（不能把总线刷新器统一改成 west）', () => {
    const facings = new Set(plan.refreshShards[0]?.lines.map((line) => /facing=(\w+)/.exec(line)?.[1]))
    expect(facings.size).toBeGreaterThan(1)
  })

  it('meta 可供验证工具读取，且写明了每条轨的延迟与起点', () => {
    const meta = plan.meta as { lanes: { label: string; delay: number; xStart: number }[] }
    expect(meta.lanes.length).toBe(3)
    for (const lane of meta.lanes) expect(lane.xStart).toBe(100 + 2 * lane.delay)
  })
})

describe('载体方块校验', () => {
  it('非导体（玻璃/荧石）直接报错：会让整条轨哑掉', () => {
    const bad = [{ ...(lanes[0] as LaneSpec), block: 'minecraft:glass' }]
    expect(() => planBuild({ song, lanes: bad }, { namespace: 'rm_test' })).toThrow(/非导体/)
  })

  it('落在 mod 内置标签里的方块直接报错：音色会被抢走', () => {
    const bad = [{ ...(lanes[0] as LaneSpec), block: 'minecraft:stone' }]
    expect(() => planBuild({ song, lanes: bad }, { namespace: 'rm_test' })).toThrow(/内置标签/)
    // 显式放行时降级成 warning
    const plan = planBuild({ song, lanes: bad }, { namespace: 'rm_test', allowOccupiedBlocks: true })
    expect(plan.warnings.join('\n')).toMatch(/内置标签/)
  })
})

describe('mcfunction 分片', () => {
  it('每片不超过 shardSize 条命令，片尾 schedule 下一片，最后一片 schedule refresh', () => {
    const commands = Array.from({ length: 20 }, (_, i) => `setblock 0 0 ${i} minecraft:air`)
    const shards = packShards(commands, 8, 'ns')
    expect(shards.map((s) => s.name)).toEqual(['build1', 'build2', 'build3'])
    expect(shards[0]?.lines.length).toBe(9) // 8 条 + schedule
    expect(shards[0]?.lines[8]).toBe('schedule function ns:build2 2t')
    expect(shards[2]?.lines[shards[2].lines.length - 1]).toBe('schedule function ns:refresh 2t')
  })
})

describe('强加载分段', () => {
  it('单段区块数不超过 256（实测超了服务端会直接拒绝）', () => {
    const bounds = { x1: 100, z1: 400, x2: 3500, z2: 560 }
    const segments = forceloadSegments(bounds)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      const chunksX = Math.floor(segment.x2 / 16) - Math.floor(segment.x1 / 16) + 1
      const chunksZ = Math.floor(segment.z2 / 16) - Math.floor(segment.z1 / 16) + 1
      expect(chunksX * chunksZ).toBeLessThanOrEqual(256)
    }
    expect(segments[0]?.x1).toBe(100)
    expect((segments[segments.length - 1] as { x2: number }).x2).toBe(3500)
  })
})

describe('examples/minimal/project.json', () => {
  it('仓库里那份最小示例始终是可用的（能过 loadProject 与 planBuild）', () => {
    const { project } = loadProject({ projectFile: path.join(HERE, '..', 'examples', 'minimal', 'project.json') })
    expect(project.lanes.length).toBe(3)
    expect(project.song.notes.length).toBe(5)
    const plan = planBuild(project, { namespace: 'rm_minimal' })
    expect(plan.allocation.stats.placed).toBe(5)
    expect(plan.allocation.stats.dropped).toBe(0)
    expect(plan.instruments.length).toBe(3)
    expect(plan.instruments.every((i) => i.soundEvent.startsWith('minecraft:'))).toBe(true)
    expect(plan.commands.counts.commands).toBeGreaterThan(100)
    expect(fs.existsSync(path.join(HERE, '..', 'examples', 'minimal', 'project.json'))).toBe(true)
  })
})
