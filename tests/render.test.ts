import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  readInstrumentsManifest,
  renderSamples,
  resolveSamplePitch,
  validateSlots,
  type InstrumentSlot,
  type SynthRenderer,
} from '../src/music/sample-render'

const SR = 44100
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-render-'))
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }))

/** 假渲染器：起音 attackMs + 指数衰减（贴近真实乐器：钢琴 ~5ms，弦乐震音 ~250ms） */
function fakeRenderer(attackMs: number, decaySec = 0.2, freq = 440): SynthRenderer {
  return {
    render(request) {
      const n = Math.ceil(SR * (request.durationSec + 0.3))
      const data = new Float32Array(n)
      const attack = Math.max(1, (attackMs / 1000) * SR)
      for (let i = 0; i < n; i++) {
        const t = i / SR
        const env = Math.min(1, i / attack) * Math.exp(-t / decaySec)
        data[i] = 0.8 * env * Math.sin((2 * Math.PI * freq * i) / SR)
      }
      return data
    },
    dispose() {},
  }
}

const slots: InstrumentSlot[] = [
  { name: 'piano_low', kind: 'pitched', program: 0, window: [40, 52], sample: 46, block: 'minecraft:moss_block', decaySec: 0.5 },
  { name: 'kick', kind: 'drum', key: 36, block: 'minecraft:netherite_block', decaySec: 0.3 },
]

describe('采样音高解析', () => {
  it('显式 sample 优先；缺省回退 window[0]+12；打击乐固定 12', () => {
    expect(resolveSamplePitch({ name: 'a', kind: 'pitched', block: 'b', window: [40, 52], sample: 46 })).toBe(46)
    expect(resolveSamplePitch({ name: 'a', kind: 'pitched', block: 'b', window: [40, 52] })).toBe(52)
    expect(resolveSamplePitch({ name: 'd', kind: 'drum', block: 'b', key: 36 })).toBe(12)
  })
})

describe('槽表校验', () => {
  it('缺 program / 非法槽名 / sample 越界都要被抓出来', () => {
    const problems = validateSlots([
      { name: 'bad name', kind: 'pitched', block: 'minecraft:moss_block', window: [40, 52] },
      { name: 'drum_missing_key', kind: 'drum', block: 'minecraft:netherite_block' },
      // sample=20 会让窗口 40..52 算出 note = midi−20+12 = 32..44（超出 0..24）
      { name: 'bad_sample', kind: 'pitched', block: 'minecraft:mud', program: 0, window: [40, 52], sample: 20 },
    ])
    expect(problems.join('\n')).toMatch(/program/)
    expect(problems.join('\n')).toMatch(/字母数字下划线/)
    expect(problems.join('\n')).toMatch(/非法 note/)
    expect(problems.join('\n')).toMatch(/必须给 key/)
  })
})

describe('renderSamples', () => {
  it('快起音（钢琴/鼓）渲染后起音都 ≤3ms，并写出可复用的清单', () => {
    const outDir = path.join(workDir, 'fast')
    const outcome = renderSamples({ slots, outDir, sampleRate: SR, maxOnsetMs: 3, namespace: 'rm', renderer: fakeRenderer(5) })
    expect(outcome.failed).toBe(0)
    expect(outcome.items.length).toBe(2)
    for (const item of outcome.items) {
      expect(item.rawOnsetMs).toBeLessThan(5)
      expect(item.outOnsetMs).toBeLessThanOrEqual(3)
      expect(item.ok).toBe(true)
      expect(fs.existsSync(item.file)).toBe(true)
      expect(item.sound).toBe(`rm:${item.name}`)
    }
    const manifest = readInstrumentsManifest(outcome.manifestFile)
    expect(manifest.items.length).toBe(2)
    expect(manifest.items.find((i) => i.name === 'piano_low')?.sample).toBe(46)
    expect(manifest.items.find((i) => i.name === 'kick')?.key).toBe(36)
  })

  it('★ 慢起音音色（弦乐震音那类）与快起音对齐后差值从 ~85ms 压到 ≤2ms', () => {
    const fast = renderSamples({ slots, outDir: path.join(workDir, 'f2'), sampleRate: SR, maxOnsetMs: 3, namespace: 'rm', renderer: fakeRenderer(5) })
    const slow = renderSamples({
      slots,
      outDir: path.join(workDir, 's2'),
      sampleRate: SR,
      maxOnsetMs: 3,
      namespace: 'rm',
      renderer: fakeRenderer(250, 0.9),
    })
    const fastPiano = fast.items.find((i) => i.name === 'piano_low') as { rawOnsetMs: number; outOnsetMs: number }
    const slowPiano = slow.items.find((i) => i.name === 'piano_low') as { rawOnsetMs: number; outOnsetMs: number }
    // 对齐前的差距就是"弦乐晚半拍"的来源
    expect(slowPiano.rawOnsetMs - fastPiano.rawOnsetMs).toBeGreaterThan(50)
    // 对齐后必须落进听不出来的范围
    expect(Math.abs(slowPiano.outOnsetMs - fastPiano.outOnsetMs)).toBeLessThanOrEqual(2)
  })

  it('慢起音音色即使对齐后仍可能超过阈值 → 必须报出来（提示换音色），不能静默通过', () => {
    const outcome = renderSamples({
      slots,
      outDir: path.join(workDir, 'slow3'),
      sampleRate: SR,
      maxOnsetMs: 3,
      namespace: 'rm',
      renderer: fakeRenderer(260, 0.9),
    })
    expect(outcome.failed).toBeGreaterThan(0)
    const slow = outcome.items.find((i) => i.name === 'piano_low') as { outOnsetMs: number; ok: boolean }
    expect(slow.outOnsetMs).toBeGreaterThan(3)
    expect(slow.ok).toBe(false)
  })

  it('align 模式只对齐已有 wav（不需要 fluidsynth）', () => {
    const sourceDir = path.join(workDir, 'fast')
    const outDir = path.join(workDir, 'realigned')
    const outcome = renderSamples({ slots, outDir, sampleRate: SR, maxOnsetMs: 3, namespace: 'rm', sourceDir })
    expect(outcome.items.length).toBe(2)
    expect(outcome.failed).toBe(0)
  })

  it('align 模式缺源文件时明确报错', () => {
    expect(() =>
      renderSamples({ slots, outDir: path.join(workDir, 'x'), sampleRate: SR, maxOnsetMs: 3, namespace: 'rm', sourceDir: path.join(workDir, 'nope') }),
    ).toThrow(/缺少源文件/)
  })
})
