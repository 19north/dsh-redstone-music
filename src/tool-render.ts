/**
 * tool-render.ts —— rm_render：渲染乐器采样 → 统一起音对齐 → 自验证
 *
 * 对应 PIPELINE 第 4 步。两种模式：
 *   render —— 从 .sf2（SoundFont）渲染，需要可选依赖 js-synthesizer
 *   align  —— 只对齐 sourceDir 里已有的 wav（没装 fluidsynth 时也能用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import {
  createFluidSynthRenderer,
  readInstrumentsManifest,
  renderSamples,
  type InstrumentSlot,
  type SlotKind,
} from './music/sample-render'

interface RawSlot {
  name?: string
  kind?: string
  block?: string
  program?: number
  window?: number[]
  sample?: number
  key?: number
  durationSec?: number
  decaySec?: number
  level?: number
}

/** 把工具入参（宽松 JSON）收敛成严格的槽定义，顺便给出可读的报错 */
export function toSlots(raw: readonly RawSlot[]): InstrumentSlot[] {
  const problems: string[] = []
  const slots = raw.map((slot, index) => {
    const kind = (slot.kind ?? 'pitched') as SlotKind
    if (kind !== 'pitched' && kind !== 'drum') problems.push(`slots[${index}].kind 只能是 pitched 或 drum`)
    if (!slot.name) problems.push(`slots[${index}] 缺 name`)
    if (!slot.block) problems.push(`slots[${index}] 缺 block`)
    if (slot.window && slot.window.length !== 2) problems.push(`slots[${index}].window 必须是两个数 [lo, hi]`)
    if (kind === 'pitched' && typeof slot.program !== 'number') problems.push(`slots[${index}] 是有音高乐器，必须给 program`)
    if (kind === 'drum' && typeof slot.key !== 'number') problems.push(`slots[${index}] 是打击乐，必须给 key`)
    return {
      name: slot.name as string,
      kind,
      block: slot.block as string,
      program: slot.program,
      window: slot.window ? ([slot.window[0], slot.window[1]] as [number, number]) : undefined,
      sample: slot.sample,
      key: slot.key,
      durationSec: slot.durationSec,
      decaySec: slot.decaySec,
      level: slot.level,
    }
  })
  if (problems.length > 0) throw new Error(`槽表有问题：\n  - ${problems.join('\n  - ')}`)
  return slots
}

export function registerRenderTool(ctx: Context, config: Config): void {
  ctx.tools.register(
    defineTool({
      name: 'rm_render',
      description:
        '渲染红石音乐用的乐器采样并做【统一起音对齐】。' +
        '规则一律是"5ms 滑动 RMS 首次达到最大值 50% 处裁切 + 2ms 淡入 + 指数衰减"，' +
        '渲完立刻读回来重量一次起音并断言 ≤ maxOnsetMs —— 分层齐奏时各层起音差 >5ms 就会被听成"错拍"。' +
        'action=render 从 .sf2 渲染（需 js-synthesizer）；action=align 只对齐 sourceDir 里已有的 wav。' +
        '产出 <outDir>/<name>.wav 与 <outDir>/instruments.json 清单（含每个采样的录音音高 sample，供 rm_build 算 note 值）。',
      parameters: {
        outDir: { type: 'string', required: true, description: '采样输出目录（还要放 instruments.json）' },
        action: { type: 'string', enum: ['render', 'align'], description: 'render=从 sf2 渲染；align=只对齐已有 wav（默认 render）' },
        slots: {
          type: 'array',
          description: '乐器槽表：一个槽 = 一种音色（name/kind/block，有音高给 program+window+sample，打击乐给 key）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true, description: '槽名（进文件名，只能字母数字下划线）' },
              kind: { type: 'string', enum: ['pitched', 'drum'], required: true },
              block: { type: 'string', required: true, description: '载体方块（红石导体，且不能落在 mod 内置标签里）' },
              program: { type: 'number', description: 'GM 音色号（0-based）' },
              window: { type: 'array', items: { type: 'number' }, description: '音域窗口 [lo, hi]（MIDI 音高）' },
              sample: { type: 'number', description: '★ 采样录音音高（缺省 = window[0]+12）；必须显式记录，note = midi − sample + 12' },
              key: { type: 'number', description: 'GM 鼓键（打击乐）' },
              durationSec: { type: 'number', description: '渲染时长（秒；有音高默认 1.3，打击乐 0.6）' },
              decaySec: { type: 'number', description: '指数衰减时间常数（秒；有音高默认 0.5，打击乐 0.3）' },
              level: { type: 'number', description: '归一化电平（默认 0.92）' },
            },
          },
        },
        slotsFile: { type: 'string', description: '槽表 JSON 文件路径（与 slots 二选一）' },
        sourceDir: { type: 'string', description: 'align 模式：放着 <name>.wav 的目录' },
        soundFont: { type: 'string', description: 'SoundFont (.sf2) 路径；缺省用插件配置 soundFont' },
        namespace: { type: 'string', description: '采样命名空间（写进清单的 sound 字段，默认 rm）' },
        sampleRate: { type: 'number', description: '采样率 Hz（默认用插件配置 sampleRate）' },
        maxOnsetMs: { type: 'number', description: '允许的最大输出起音 ms（默认用插件配置 maxOnsetMs=3）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            outDir: { type: 'string', required: true },
            sampleRate: { type: 'number', required: true },
            maxOnsetMs: { type: 'number', required: true },
            count: { type: 'number', required: true },
            ok: { type: 'number', required: true },
            failed: { type: 'number', required: true },
            manifestFile: { type: 'string', required: true },
            totalKB: { type: 'number', required: true },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  sound: { type: 'string', required: true },
                  block: { type: 'string', required: true },
                  sample: { type: 'number', required: true },
                  window: { type: 'json', required: true },
                  key: { type: 'json', required: true },
                  file: { type: 'string', required: true },
                  sizeKB: { type: 'number', required: true },
                  durationSec: { type: 'number', required: true },
                  rawOnsetMs: { type: 'number', required: true },
                  cutMs: { type: 'number', required: true },
                  outOnsetMs: { type: 'number', required: true },
                  ok: { type: 'boolean', required: true },
                },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const lines = value.items.map(
            (item) =>
              `  ${item.name.padEnd(14)} 起音 ${item.rawOnsetMs.toFixed(1).padStart(7)}ms → 裁 ${item.cutMs
                .toFixed(1)
                .padStart(6)}ms → 输出 ${item.outOnsetMs.toFixed(2).padStart(6)}ms  ${item.ok ? '✓' : '✗ 不合格'}  ${item.sound}  ${item.sizeKB}KB`,
          )
          const head =
            `【${value.mode}】${value.count} 个采样（合格 ${value.ok} / 不合格 ${value.failed}），${value.sampleRate}Hz，最大允许起音 ${value.maxOnsetMs}ms\n` +
            `输出目录：${value.outDir}\n清单：${value.manifestFile}\n共 ${value.totalKB.toFixed(0)} KB`
          const warning = value.warnings.length > 0 ? `\n注意：\n  - ${value.warnings.join('\n  - ')}` : ''
          return [{ type: 'text', text: `${head}\n\n${lines.join('\n')}${warning}` }]
        },
      },
      async execute(args, exec) {
        const sampleRate = args.sampleRate ?? config.sampleRate
        const maxOnsetMs = args.maxOnsetMs ?? config.maxOnsetMs
        const namespace = args.namespace ?? 'rm'
        const mode = args.action ?? 'render'

        let slots: InstrumentSlot[]
        if (args.slotsFile) {
          const parsed = JSON.parse(fs.readFileSync(args.slotsFile, 'utf8')) as { slots?: RawSlot[] } | RawSlot[]
          const list = Array.isArray(parsed) ? parsed : (parsed.slots ?? [])
          slots = toSlots(list)
        } else if (args.slots) {
          slots = toSlots(args.slots as RawSlot[])
        } else if (args.sourceDir) {
          // 没给槽表就退回清单里的 items（instruments.json 本身就是可再用作槽表）
          const manifest = readInstrumentsManifest(path.join(args.sourceDir, 'instruments.json'))
          slots = manifest.items.map((item) => ({
            name: item.name,
            kind: item.kind,
            block: item.block,
            program: undefined,
            window: item.window ?? undefined,
            sample: item.sample,
            key: item.key ?? undefined,
          }))
        } else {
          throw new Error('必须给 slots / slotsFile，或给 sourceDir（用其 instruments.json 当槽表）')
        }

        const warnings: string[] = []
        const outDir = args.outDir
        let renderer
        if (mode === 'render') {
          const soundFont = args.soundFont ?? config.soundFont
          if (soundFont.trim() === '') {
            throw new Error(
              'render 模式需要 SoundFont：调用时给 soundFont（.sf2 路径），或在插件配置里设 soundFont。' +
                '手上只有渲好的 wav 就用 action="align"（配 sourceDir），它不需要 SoundFont。',
            )
          }
          renderer = await createFluidSynthRenderer(soundFont, sampleRate)
        }
        if (exec.signal.aborted) throw new Error('已取消')

        const outcome = renderSamples({
          slots,
          outDir,
          sampleRate,
          maxOnsetMs,
          namespace,
          sourceDir: args.sourceDir,
          renderer,
        })
        renderer?.dispose()

        const failed = outcome.items.filter((item) => !item.ok)
        if (failed.length > 0) {
          warnings.push(
            `有 ${failed.length} 个采样起音 >${maxOnsetMs}ms（${failed.map((f) => `${f.name}=${f.outOnsetMs}ms`).join('、')}）：` +
              '这会让该层听起来"晚半拍"。检查是否用了起音很慢的音色（如 GM44 Tremolo Strings），或把裁切上限调小。',
          )
        }

        return {
          mode,
          outDir,
          sampleRate,
          maxOnsetMs,
          count: outcome.items.length,
          ok: outcome.ok,
          failed: outcome.failed,
          manifestFile: outcome.manifestFile,
          totalKB: Number(outcome.items.reduce((sum, item) => sum + item.sizeKB, 0).toFixed(1)),
          items: outcome.items.map((item) => ({
            name: item.name,
            kind: item.kind,
            sound: item.sound,
            block: item.block,
            sample: item.sample,
            window: item.window,
            key: item.key,
            file: item.file,
            sizeKB: item.sizeKB,
            durationSec: item.durationSec,
            rawOnsetMs: item.rawOnsetMs,
            cutMs: item.cutMs,
            outOnsetMs: item.outOnsetMs,
            ok: item.ok,
          })),
          warnings,
        }
      },
    }),
  )
}
