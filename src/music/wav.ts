/**
 * wav.ts —— 采样文件的读写与"起音对齐"核心算法（纯函数，无外部依赖）
 *
 * 这里是 knowledge.ts 里 `sample-onset` 那条硬教训的代码化：
 *   分层齐奏时各层采样的起音必须接近（跨轨差 >5ms 就能听出来）。
 *   指标一律用【5ms 滑动 RMS 首次达到最大值 50% 的位置】——
 *   ★ 不要用"峰值位置"：波形有多个相近峰，该指标会跳（实战踩过）。
 */

/** 解码结果：单声道 Float32 采样 */
export interface WavData {
  sampleRate: number
  data: Float32Array
}

/**
 * 解析 16/8 位 PCM WAV（单声道或立体声，取各声道均值）。
 * 只支持本项目自己产出的格式与 fluidsynth 导出格式，遇到压缩格式直接报错。
 */
export function decodeWav(buffer: Buffer): WavData {
  if (buffer.length < 44) throw new Error('WAV 太短，不是合法文件')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件')
  }
  let pos = 12
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined
  let dataStart = -1
  let dataLength = 0
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataStart = body
      dataLength = Math.min(size, buffer.length - body)
    }
    pos = body + size + (size % 2)
  }
  if (!fmt) throw new Error('WAV 缺少 fmt 块')
  if (dataStart < 0) throw new Error('WAV 缺少 data 块')
  if (fmt.format !== 1) throw new Error(`只支持未压缩 PCM（format=${fmt.format}）`)
  if (fmt.bits !== 16 && fmt.bits !== 8) throw new Error(`只支持 8/16 位（bits=${fmt.bits}）`)

  const bytesPerSample = fmt.bits / 8
  const frames = Math.floor(dataLength / (bytesPerSample * fmt.channels))
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < fmt.channels; c++) {
      const at = dataStart + (i * fmt.channels + c) * bytesPerSample
      acc += fmt.bits === 16 ? buffer.readInt16LE(at) / 32767 : (buffer.readUInt8(at) - 128) / 128
    }
    data[i] = acc / fmt.channels
  }
  return { sampleRate: fmt.sampleRate, data }
}

/** 编码成 16 位单声道 PCM WAV */
export function encodeWav(data: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + data.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + data.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(data.length * 2, 40)
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i] ?? 0))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

/** 5ms 滑动 RMS 包络（默认窗口对应 44.1kHz 下的 220 点） */
export function rmsEnvelope(data: Float32Array, windowSamples: number): Float32Array {
  const win = Math.max(1, windowSamples)
  const env = new Float32Array(data.length)
  let acc = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0
    acc += v * v
    if (i >= win) {
      const old = data[i - win] ?? 0
      acc -= old * old
    }
    env[i] = Math.sqrt(acc / Math.min(i + 1, win))
  }
  return env
}

/** 采样中的最大绝对值（峰值） */
export function peakOf(data: Float32Array): number {
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}

/**
 * 起音位置（毫秒）= 5ms 滑动 RMS 首次达到【最大 RMS 的 ratio 倍】的位置。
 * 稳定的听感指标；不要换成峰值位置。
 */
export function onsetMs(data: Float32Array, sampleRate: number, ratio = 0.5): number {
  if (data.length === 0) return 0
  const env = rmsEnvelope(data, Math.floor(sampleRate * 0.005))
  let max = 0
  for (let i = 0; i < env.length; i++) if ((env[i] ?? 0) > max) max = env[i] ?? 0
  if (max <= 0) return 0
  for (let i = 0; i < env.length; i++) if ((env[i] ?? 0) >= max * ratio) return (i / sampleRate) * 1000
  return 0
}

export interface AlignOptions {
  sampleRate: number
  /** 裁切点判定：滑动 RMS 达到最大值的该比例处（默认 0.5） */
  ratio?: number
  /** 裁切上限（毫秒），防止把整个采样裁没（默认 120） */
  maxCutMs?: number
  /** 淡入时长（毫秒，默认 2） */
  fadeMs?: number
  /** 指数衰减时间常数（秒）；undefined = 不施加衰减 */
  decaySec?: number
  /** 归一化到该电平（默认 0.92） */
  level?: number
}

export interface AlignResult {
  data: Float32Array
  /** 裁切前测得的起音（ms） */
  rawOnsetMs: number
  /** 实际裁掉的长度（ms） */
  cutMs: number
  /** 裁切后重新测得的起音（ms）——必须 ≤ maxOnsetMs */
  outOnsetMs: number
  gain: number
}

/**
 * 统一起音对齐：从"滑动 RMS 达到最大值 ratio 倍"处裁切 → 2ms 淡入 → 标准衰减 → 归一化。
 *
 * ★ 规则必须对所有采样【完全一致】：给每个采样单独调裁切量 = 给每条轨加不同的延迟
 *   （实战踩过：钢琴被裁 5~8ms、弦乐被裁 30ms → 差 20+ms → 听感"很乱"）。
 */
export function alignSample(raw: Float32Array, options: AlignOptions): AlignResult {
  const { sampleRate } = options
  const ratio = options.ratio ?? 0.5
  const maxCutMs = options.maxCutMs ?? 120
  const fadeMs = options.fadeMs ?? 2
  const level = options.level ?? 0.92

  const rawOnsetMs = onsetMs(raw, sampleRate, ratio)
  const cut = Math.min(
    Math.floor((rawOnsetMs / 1000) * sampleRate),
    Math.floor((maxCutMs / 1000) * sampleRate),
    Math.max(0, raw.length - 1),
  )
  const peak = peakOf(raw)
  const gain = peak > 0.001 ? level / peak : 1
  const n = raw.length - cut
  const fade = Math.max(1, Math.floor((fadeMs / 1000) * sampleRate))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const decay = options.decaySec === undefined ? 1 : Math.exp(-t / options.decaySec)
    const fadeIn = i < fade ? i / fade : 1
    out[i] = (raw[cut + i] ?? 0) * gain * decay * fadeIn
  }
  return { data: out, rawOnsetMs, cutMs: (cut / sampleRate) * 1000, outOnsetMs: onsetMs(out, sampleRate, ratio), gain }
}
