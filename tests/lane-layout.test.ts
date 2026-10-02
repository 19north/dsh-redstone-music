import { describe, expect, it } from 'vitest'
import { DEFAULT_GEOMETRY, layoutLanes, type LaneSpec } from '../src/music/lane-layout'

const lanes: LaneSpec[] = [
  { label: '钢琴·低', instrument: 'piano_low', block: 'minecraft:moss_block', side: 'N', pos: 1, window: [40, 52], sample: 46, tracks: [2] },
  { label: '钢琴·高', instrument: 'piano_high', block: 'minecraft:mud', side: 'N', pos: 2, window: [53, 65], sample: 59, tracks: [2] },
  { label: '贝斯', instrument: 'bass', block: 'minecraft:copper_block', side: 'S', pos: 1, window: [28, 45], sample: 37, tracks: [11] },
  { label: '鼓', instrument: 'kick', block: 'minecraft:netherite_block', side: 'S', pos: 2, window: null, tracks: [1], keys: [35, 36], tune: 12 },
]

describe('轨布局', () => {
  it('南北两侧分别向走道外展开，dy 逐条抬高', () => {
    const layout = layoutLanes(lanes, DEFAULT_GEOMETRY, 64)
    const north = layout.lanes.filter((l) => l.side === 'N')
    const south = layout.lanes.filter((l) => l.side === 'S')
    for (const lane of north) expect(lane.z).toBeLessThan(DEFAULT_GEOMETRY.walkMid)
    for (const lane of south) expect(lane.z).toBeGreaterThan(DEFAULT_GEOMETRY.walkMid)
    expect(north[0]?.dy).toBe(1)
    expect(north[1]?.dy).toBe(3)
    expect(south[0]?.dy).toBe(1)
  })

  it('总线阶梯在每个锚点等于该轨的 dy', () => {
    const layout = layoutLanes(lanes, DEFAULT_GEOMETRY, 64)
    for (const lane of layout.lanes) expect(layout.busProfile.get(lane.z)).toBe(lane.dy)
  })

  it('刷新中继器不落在任何一条轨的 z 上，且连续三格同高', () => {
    const layout = layoutLanes(lanes, { ...DEFAULT_GEOMETRY, walkMid: 520 }, 400)
    const laneZs = new Set(layout.lanes.map((l) => l.z))
    expect(layout.busRepeaters.length).toBeGreaterThan(0)
    for (const repeater of layout.busRepeaters) {
      expect(laneZs.has(repeater.z)).toBe(false)
      const height = layout.busProfile.get(repeater.z)
      expect(layout.busProfile.get(repeater.z - 1)).toBe(height)
      expect(layout.busProfile.get(repeater.z + 1)).toBe(height)
    }
  })

  it('延迟补偿：链条起点 = originX + 2×该轨经过的刷新器数', () => {
    const layout = layoutLanes(lanes, DEFAULT_GEOMETRY, 400)
    for (const lane of layout.lanes) expect(lane.xStart).toBe(DEFAULT_GEOMETRY.originX + 2 * lane.delay)
    // 总线刷新器在两侧都有，所以最外侧轨的延迟一定大于内侧轨
    const north = layout.lanes.filter((l) => l.side === 'N').sort((a, b) => a.pos - b.pos)
    expect((north[north.length - 1] as { delay: number }).delay).toBeGreaterThanOrEqual((north[0] as { delay: number }).delay)
  })

  it('轨表为空要报错而不是静默产出空带子', () => {
    expect(() => layoutLanes([], DEFAULT_GEOMETRY, 10)).toThrow()
  })
})
