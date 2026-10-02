/**
 * datapack.ts —— 把命令分片与乐器定义写成数据包
 *
 * ★ 这里挡掉了本插件最贵的一个坑（`glissando-sound-event`）：
 *   乐器定义的 `sound_event` 由【服务端】解析，写自定义命名空间（如 virus:piano）
 *   会让整张乐器表加载失败 → 所有音符盒回退原版 harp → 用户听到"全是错音"。
 *   所以 writeInstrumentDatapack() 只接受 `minecraft:` 开头的事件，并且绝不重复占用。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Shard } from './commands'

/** 可用于承载自定义采样的【原版】音效事件（前 16 个是音符盒自带的，后面是冷门实体/方块音效） */
export const VANILLA_NOTE_EVENTS = [
  'minecraft:block.note_block.harp',
  'minecraft:block.note_block.basedrum',
  'minecraft:block.note_block.snare',
  'minecraft:block.note_block.hat',
  'minecraft:block.note_block.bass',
  'minecraft:block.note_block.flute',
  'minecraft:block.note_block.bell',
  'minecraft:block.note_block.guitar',
  'minecraft:block.note_block.chime',
  'minecraft:block.note_block.xylophone',
  'minecraft:block.note_block.iron_xylophone',
  'minecraft:block.note_block.cow_bell',
  'minecraft:block.note_block.didgeridoo',
  'minecraft:block.note_block.bit',
  'minecraft:block.note_block.banjo',
  'minecraft:block.note_block.pling',
  'minecraft:entity.llama.angry',
  'minecraft:entity.fox.screech',
  'minecraft:entity.panda.sneeze',
  'minecraft:entity.axolotl.idle_air',
  'minecraft:entity.dolphin.play',
  'minecraft:entity.parrot.imitate.creeper',
  'minecraft:entity.bat.takeoff',
  'minecraft:entity.cat.purreow',
  'minecraft:entity.rabbit.attack',
  'minecraft:block.conduit.activate',
  'minecraft:block.respawn_anchor.set_spawn',
  'minecraft:item.trident.throw',
] as const

/** 一个乐器的数据包定义：方块标签 + Glissando 乐器注册 */
export interface InstrumentDefinition {
  /** 乐器名（= 采样名，进文件路径与标签名） */
  name: string
  /** 载体方块，如 minecraft:moss_block */
  block: string
  /** 显示名 */
  description: string
  /** 必须是以 minecraft: 开头的原版音效事件 */
  soundEvent: string
}

export interface DatapackRequest {
  /** 数据包根目录（…/datapacks/<namespace>） */
  dir: string
  namespace: string
  packFormat: number
  description: string
  shards: readonly Shard[]
  /** 额外函数（如唤醒中继器的 refresh 分片） */
  extraShards?: readonly Shard[]
  instruments?: readonly InstrumentDefinition[]
  /** 几何/分配元数据，写成 meta.json 供后续验证工具读取 */
  meta?: unknown
}

export interface DatapackResult {
  dir: string
  files: { file: string; bytes: number }[]
  functions: number
  instruments: number
  bytes: number
}

/** 从原版事件表里按顺序取事件；数量不够就报错（宁可报错也不要静默回退） */
export function assignSoundEvents(count: number, events: readonly string[] = VANILLA_NOTE_EVENTS): string[] {
  if (count > events.length) {
    throw new Error(`需要 ${count} 个原版音效事件，内置表只有 ${events.length} 个（乐器太多就得多挑几个冷门原版事件）`)
  }
  return events.slice(0, count)
}

/** 校验：sound_event 必须是原版事件，否则服务端注册表解析失败 → 全是错音 */
export function assertVanillaEvents(instruments: readonly InstrumentDefinition[]): void {
  for (const instrument of instruments) {
    if (!instrument.soundEvent.startsWith('minecraft:')) {
      throw new Error(
        `乐器 ${instrument.name} 的 sound_event="${instrument.soundEvent}" 不是原版事件。` +
          'Glissando 的乐器表由服务端解析，自定义命名空间只存在于客户端资源包 → 整张表加载失败 → 所有音符盒回退 harp（"全是错音"）。' +
          '改用 minecraft:block.note_block.* 或任意冷门原版事件，再用资源包覆盖那些事件。',
      )
    }
  }
}

export function writeDatapack(request: DatapackRequest): DatapackResult {
  const root = request.dir
  const functionDir = path.join(root, 'data', request.namespace, 'function')
  fs.mkdirSync(functionDir, { recursive: true })
  const files: { file: string; bytes: number }[] = []
  let bytes = 0
  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
    const size = fs.statSync(file).size
    files.push({ file, bytes: size })
    bytes += size
  }

  write(
    path.join(root, 'pack.mcmeta'),
    JSON.stringify({ pack: { pack_format: request.packFormat, description: request.description } }, null, 2),
  )

  const allShards = [...request.shards, ...(request.extraShards ?? [])]
  for (const shard of allShards) write(path.join(functionDir, `${shard.name}.mcfunction`), `${shard.lines.join('\n')}\n`)

  if (request.instruments && request.instruments.length > 0) {
    assertVanillaEvents(request.instruments)
    for (const instrument of request.instruments) {
      write(
        path.join(root, 'data', request.namespace, 'glissando', 'note_block_instrument', `${instrument.name}.json`),
        JSON.stringify(
          {
            blocks: `#${request.namespace}:note_block_instruments/${instrument.name}`,
            description: { text: instrument.description },
            sound_event: instrument.soundEvent,
          },
          null,
          2,
        ),
      )
      write(
        path.join(root, 'data', request.namespace, 'tags', 'block', 'note_block_instruments', `${instrument.name}.json`),
        JSON.stringify({ values: [instrument.block] }, null, 2),
      )
    }
  }

  if (request.meta !== undefined) {
    write(path.join(root, 'meta.json'), JSON.stringify(request.meta, null, 2))
  }

  return {
    dir: root,
    files,
    functions: allShards.length,
    instruments: request.instruments?.length ?? 0,
    bytes,
  }
}
