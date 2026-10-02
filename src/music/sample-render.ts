/**
 * sample-render.ts —— 从 SoundFont 渲染乐器采样 → 统一起音对齐 → 自验证
 *
 * 对应 knowledge.ts 的 PIPELINE 第 4 步，也把三条硬教训写进了代码：
 *   ① `sample-onset`：所有采样用【同一条】裁切规则，且渲完立刻量起音（≤ maxOnsetMs）；
 *   ② 采样录音音高必须【显式记录】：note = midi − sample + 12（缺省才回退 window[0]+12）；
 *   ③ 自定义音效事件不会被服务端注册表认，所以渲染产物只负责产出 wav + 清单，
 *      乐器定义由 rm_build 用【原版 sound_event】写进数据包。
 *
 * 渲染用可选依赖 js-synthesizer（Emscripten 版 FluidSynth）：
 *   装了就能从 .sf2 直接渲染；没装则只能用 align 模式对齐已有的 wav。
 */
import fs from 'node:fs'
import path from 'node:path'
import { alignSample, decodeWav, encodeWav, onsetMs } from './wav'

export type SlotKind = 'pitched' | 'drum'

/** 一个乐器槽：= 一个专属载体方块 + 一段采样 */
export interface InstrumentSlot {
  name: string
  kind: SlotKind
  /** 载体方块，如 minecraft:moss_block（必须是红石导体，且不能落在 mod 内置标签里） */
  block: string
  /** pitched：GM 音色号（0-based） */
  program?: number
  /** pitched：音域窗口 [lo, hi]（闭区间，MIDI 音高） */
  window?: [number, number]
  /** pitched：采样录音音高（缺省 = window[0] + 12）；必须显式记录才能算准 note */
  sample?: number
  /** drum：GM 鼓键 */
  key?: number
  /** 渲染时长（秒，默认：有音高 1.3 / 打击乐 0.6） */
  durationSec?: number
  /** 指数衰减时间常数（秒，默认：有音高 0.5 / 打击乐 0.3；undefined = 不衰减） */
  decaySec?: number
  /** 归一化电平（默认 0.92） */
  level?: number
}

export interface RenderedSample {
  name: string
  kind: SlotKind
  sound: string
  block: string
  /** 采样录音音高（打击乐固定 12 = 原始音高） */
  sample: number
  window: [number, number] | null
  key: number | null
  file: string
  sizeKB: number
  durationSec: number
  rawOnsetMs: number
  cutMs: number
  outOnsetMs: number
  ok: boolean
}

export interface SynthRequest {
  key: number
  program: number | null
  drum: boolean
  durationSec: number
}

/** 可注入的采样渲染器（便于单测替换成假实现） */
export interface SynthRenderer {
  render(request: SynthRequest): Float32Array
  dispose(): void
}

/** 采样录音音高：显式 sample 优先，否则回退 window[0]+12（老行为）；打击乐固定 12 */
export function resolveSamplePitch(slot: InstrumentSlot): number {
  if (slot.kind === 'drum') return 12
  if (typeof slot.sample === 'number') return slot.sample
  if (slot.window) return slot.window[0] + 12
  throw new Error(`槽 ${slot.name} 既没给 sample 也没给 window`)
}

/** 校验槽表：把"配错了会静默出错音"的情况在渲染前就拦下 */
export function validateSlots(slots: readonly InstrumentSlot[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const s of slots) {
    if (!s.name) problems.push('存在没有 name 的槽')
    else if (seen.has(s.name)) problems.push(`槽名重复：${s.name}`)
    seen.add(s.name)
    if (!/^[a-z0-9_]+$/i.test(s.name ?? '')) problems.push(`槽名 ${s.name} 只能包含字母数字下划线（会进文件名与命名空间）`)
    if (!s.block) problems.push(`槽 ${s.name} 没有载体方块`)
    if (s.kind === 'pitched') {
      if (typeof s.program !== 'number') problems.push(`槽 ${s.name} 是有音高乐器，必须给 program`)
      if (!s.window) problems.push(`槽 ${s.name} 缺 window（音域窗口）`)
      else if (s.window[0] > s.window[1]) problems.push(`槽 ${s.name} 的 window 上下界反了`)
      if (s.sample !== undefined && s.window) {
        // note = midi − sample + 12 必须落在音符盒合法的 0..24 内：
        // 等价于 sample ∈ [win[1] − 12, win[0] + 12]。越界 = 该窗口内会有音算不出合法 note。
        const lo = s.window[1] - 12
        const hi = s.window[0] + 12
        if (s.sample < lo || s.sample > hi) {
          problems.push(`槽 ${s.name} 的 sample=${s.sample} 会让窗口 ${s.window[0]}..${s.window[1]} 算出非法 note（要求 ${lo}..${hi}）`)
        }
      }
    } else if (typeof s.key !== 'number') {
      problems.push(`槽 ${s.name} 是打击乐，必须给 key（GM 鼓键）`)
    }
  }
  return problems
}

interface JSSynthModule {
  Synthesizer: {
    new (): {
      init(sampleRate: number): void
      loadSFont(buffer: ArrayBuffer): Promise<void>
      midiProgramChange(channel: number, program: number): void
      midiControl(channel: number, control: number, value: number): void
      midiNoteOn(channel: number, key: number, velocity: number): void
      midiNoteOff(channel: number, key: number): void
      render(buffers: Float32Array[]): void
    }
    initializeWithFluidSynthModule(module: unknown): void
  }
  waitForReady(): Promise<void>
}

/** 懒加载 js-synthesizer（可选依赖），失败时给出可操作的提示 */
async function loadJSSynth(): Promise<JSSynthModule> {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  let mod: JSSynthModule
  try {
    mod = require('js-synthesizer') as JSSynthModule
    mod.Synthesizer.initializeWithFluidSynthModule(require('js-synthesizer/libfluidsynth'))
  } catch (error) {
    throw new Error(
      '拿不到可选依赖 js-synthesizer（Emscripten 版 FluidSynth），无法从 .sf2 渲染。' +
        `修法：在本插件目录执行 pnpm add js-synthesizer，或改用 action="align" 对齐已有 wav。原始错误：${String(error)}`,
    )
  }
  await mod.waitForReady()
  return mod
}

/** 用 FluidSynth 从 .sf2 渲染单个音（单声道取左声道） */
export async function createFluidSynthRenderer(soundFont: string, sampleRate: number): Promise<SynthRenderer> {
  if (!fs.existsSync(soundFont)) throw new Error(`SoundFont 不存在：${soundFont}`)
  const JSSynth = await loadJSSynth()
  const synth = new JSSynth.Synthesizer()
  synth.init(sampleRate)
  const raw = fs.readFileSync(soundFont)
  await synth.loadSFont(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  return {
    render(request) {
      const channel = request.drum ? 9 : 0
      if (!request.drum && request.program !== null) synth.midiProgramChange(0, request.program)
      synth.midiControl(channel, 7, 105)
      synth.midiControl(channel, 91, 30)
      const total = Math.ceil(sampleRate * (request.durationSec + 0.3))
      const left = new Float32Array(total)
      const right = new Float32Array(total)
      synth.midiNoteOn(channel, request.key, 105)
      let done = 0
      let released = false
      while (done < total) {
        const n = Math.min(1024, total - done)
        synth.render([left.subarray(done, done + n), right.subarray(done, done + n)])
        done += n
        if (!released && done >= sampleRate * request.durationSec) {
          synth.midiNoteOff(channel, request.key)
          released = true
        }
      }
      return left
    },
    dispose() {
      /* js-synthesizer 没有显式销毁接口；进程退出即释放 */
    },
  }
}

export interface RenderRequest {
  slots: readonly InstrumentSlot[]
  outDir: string
  sampleRate: number
  maxOnsetMs: number
  /** 采样命名空间（写进清单的 sound 字段，供资源包用） */
  namespace: string
  /** 已渲染好 wav 的目录：给了就只做对齐（align 模式） */
  sourceDir?: string
  /** .sf2 路径与渲染器回调：给了就渲染（render 模式） */
  renderer?: SynthRenderer
}

export interface RenderOutcome {
  items: RenderedSample[]
  ok: number
  failed: number
  manifestFile: string
}

function defaultDuration(slot: InstrumentSlot): number {
  if (slot.durationSec !== undefined) return slot.durationSec
  return slot.kind === 'drum' ? 0.6 : 1.3
}

function defaultDecay(slot: InstrumentSlot): number | undefined {
  if (slot.decaySec !== undefined) return slot.decaySec
  return slot.kind === 'drum' ? 0.3 : 0.5
}

/**
 * 渲染 + 对齐 + 自验证。
 * 每个采样都走【同一条】alignSample 规则，渲完立刻读回来重量一次起音并断言 ≤ maxOnsetMs。
 */
export function renderSamples(request: RenderRequest): RenderOutcome {
  const problems = validateSlots(request.slots)
  if (problems.length > 0) throw new Error(`槽表有问题：\n  - ${problems.join('\n  - ')}`)
  fs.mkdirSync(request.outDir, { recursive: true })

  const items: RenderedSample[] = []
  for (const slot of request.slots) {
    const samplePitch = resolveSamplePitch(slot)
    const durationSec = defaultDuration(slot)
    let raw: Float32Array
    if (request.renderer) {
      raw = request.renderer.render({
        key: slot.kind === 'drum' ? (slot.key as number) : samplePitch,
        program: slot.kind === 'pitched' ? (slot.program as number) : null,
        drum: slot.kind === 'drum',
        durationSec,
      })
    } else {
      const source = path.join(request.sourceDir ?? request.outDir, `${slot.name}.wav`)
      if (!fs.existsSync(source)) throw new Error(`对齐模式缺少源文件：${source}`)
      raw = decodeWav(fs.readFileSync(source)).data
    }
    const aligned = alignSample(raw, {
      sampleRate: request.sampleRate,
      decaySec: defaultDecay(slot),
      level: slot.level,
    })
    const file = path.join(request.outDir, `${slot.name}.wav`)
    fs.writeFileSync(file, encodeWav(aligned.data, request.sampleRate))
    // ★ 自验证：写盘后读回来再测一次，量的是"真正会被打包的东西"
    const written = decodeWav(fs.readFileSync(file)).data
    const outOnsetMs = onsetMs(written, request.sampleRate, 0.5)
    items.push({
      name: slot.name,
      kind: slot.kind,
      sound: `${request.namespace}:${slot.name}`,
      block: slot.block,
      sample: samplePitch,
      window: slot.window ?? null,
      key: slot.kind === 'drum' ? (slot.key as number) : null,
      file,
      sizeKB: Number((fs.statSync(file).size / 1024).toFixed(1)),
      durationSec: Number((written.length / request.sampleRate).toFixed(2)),
      rawOnsetMs: Number(aligned.rawOnsetMs.toFixed(2)),
      cutMs: Number(aligned.cutMs.toFixed(2)),
      outOnsetMs: Number(outOnsetMs.toFixed(2)),
      ok: outOnsetMs <= request.maxOnsetMs,
    })
  }

  const manifestFile = path.join(request.outDir, 'instruments.json')
  fs.writeFileSync(
    manifestFile,
    JSON.stringify({ namespace: request.namespace, sampleRate: request.sampleRate, items }, null, 2),
    'utf8',
  )
  const failed = items.filter((i) => !i.ok).length
  return { items, ok: items.length - failed, failed, manifestFile }
}

/** 采样表 JSON（rm_render 的 slotsFile / rm_build 的 instrumentsFile）形状 */
export interface InstrumentsManifest {
  namespace: string
  sampleRate: number
  items: RenderedSample[]
}

/** 读采样清单（也接受 { pitched: [...], drums: [...] } 这种老形状） */
export function readInstrumentsManifest(file: string): InstrumentsManifest {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  if (Array.isArray(raw.items)) return raw as unknown as InstrumentsManifest
  const legacy = [...((raw.pitched as RenderedSample[]) ?? []), ...((raw.drums as RenderedSample[]) ?? [])]
  return { namespace: String(raw.namespace ?? 'rm'), sampleRate: Number(raw.sampleRate ?? 44100), items: legacy }
}
