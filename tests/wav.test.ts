import { describe, expect, it } from 'vitest'
import { alignSample, decodeWav, encodeWav, onsetMs, peakOf } from '../src/music/wav'

const SR = 44100

/** 生成"慢起音"波形：幅度在前 attackMs 内线性涨到 1，之后保持 */
function slowAttack(attackMs: number, durationSec = 1.2, freq = 440): Float32Array {
  const n = Math.floor(SR * durationSec)
  const data = new Float32Array(n)
  const attackSamples = (attackMs / 1000) * SR
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / attackSamples)
    data[i] = env * Math.sin((2 * Math.PI * freq * i) / SR)
  }
  return data
}

/** 真实乐器式的包络：起音 attackMs + 指数衰减（钢琴 ≈5ms/0.15s，弦乐震音 ≈250ms/0.9s） */
function instrument(attackMs: number, decaySec: number, durationSec = 1.5, freq = 440): Float32Array {
  const n = Math.floor(SR * durationSec)
  const data = new Float32Array(n)
  const attackSamples = Math.max(1, (attackMs / 1000) * SR)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    data[i] = Math.min(1, i / attackSamples) * Math.exp(-t / decaySec) * Math.sin((2 * Math.PI * freq * i) / SR)
  }
  return data
}

describe('wav 编解码', () => {
  it('编码后解码回来基本一致', () => {
    const source = slowAttack(5, 0.2)
    const round = decodeWav(encodeWav(source, SR))
    expect(round.sampleRate).toBe(SR)
    expect(round.data.length).toBe(source.length)
    let maxDiff = 0
    for (let i = 0; i < source.length; i++) maxDiff = Math.max(maxDiff, Math.abs((source[i] as number) - (round.data[i] as number)))
    expect(maxDiff).toBeLessThan(1 / 32000)
  })

  it('拒绝非 WAV 数据', () => {
    expect(() => decodeWav(Buffer.from('not a wav file at all, really'))).toThrow()
  })
})

describe('起音指标', () => {
  it('慢起音波形的起音 ≈ 峰值 50% 的时间点', () => {
    // 250ms 涨到峰 → 50% 幅度处约 125ms（RMS 跟随幅度线性，故 ≈125ms）
    const value = onsetMs(slowAttack(250), SR, 0.5)
    expect(value).toBeGreaterThan(90)
    expect(value).toBeLessThan(160)
  })

  it('静音返回 0 而不是抛错', () => {
    expect(onsetMs(new Float32Array(SR), SR, 0.5)).toBe(0)
  })
})

describe('统一起音对齐', () => {
  it('真实乐器（快起音）对齐后起音 ≤3ms，峰值归一化到 level 附近', () => {
    const aligned = alignSample(instrument(5, 0.15), { sampleRate: SR, decaySec: 0.5, level: 0.9 })
    expect(aligned.rawOnsetMs).toBeLessThan(6)
    expect(aligned.outOnsetMs).toBeLessThanOrEqual(3)
    expect(peakOf(aligned.data)).toBeLessThanOrEqual(0.91)
    expect(peakOf(aligned.data)).toBeGreaterThan(0.5)
  })

  it('★ 同一条规则处理"钢琴"与"弦乐震音"，差值从 ~85ms 压到听不出来的范围（≤3ms）', () => {
    const piano = alignSample(instrument(5, 0.15), { sampleRate: SR, decaySec: 0.5 })
    const tremolo = alignSample(instrument(250, 0.9), { sampleRate: SR, decaySec: 0.9 })
    // 对齐前差 ~85ms —— 这就是用户听到的"弦乐晚了半拍、很乱"
    expect(tremolo.rawOnsetMs - piano.rawOnsetMs).toBeGreaterThan(50)
    // 对齐后差值必须落进听不出来的范围（文档口径：跨轨 >5ms 才听得出来；
    // 残余的 2~3ms 来自检测器自带的 5ms 滑动窗，不是对齐没做）
    expect(Math.abs(tremolo.outOnsetMs - piano.outOnsetMs)).toBeLessThanOrEqual(3)
  })

  it('裁切上限生效：不会把整段采样裁没', () => {
    const aligned = alignSample(slowAttack(600, 0.8), { sampleRate: SR, maxCutMs: 120 })
    expect(aligned.cutMs).toBeLessThanOrEqual(120.01)
    expect(aligned.data.length).toBeGreaterThan(0)
  })
})
