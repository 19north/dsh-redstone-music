/**
 * tool-build.ts —— rm_build：谱面 + 轨表 → 数据包（mcfunction 分片）→ 可选部署并开建
 *
 * 对应 PIPELINE 第 7/8 步。两条硬教训直接写进实现：
 *   · `mcfunction-batch`：命令收集起来写成 .mcfunction（每片 8000 条，片间 schedule 2t），
 *     而不是逐格 RCON —— 实测 143,712 条命令 30 秒跑完，逐格要 40 分钟；
 *   · `delay-compensation`：内容按【全局单位】摆（x = originX + 2u + 1），
 *     各轨链条起点 xStart = originX + 2·delay，否则整条轨晚 delay 个单位。
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import {
  DEFAULT_GEOMETRY,
  type GeometryOptions,
  type LaneSpec,
} from './music/lane-layout'
import { planBuild, type BuildProject } from './music/build'
import { writeDatapack } from './music/datapack'
import { forceloadCommands, forceloadSegments } from './music/commands'
import { openRcon } from './music/rcon'
import type { SongNote, SongPlan } from './music/score'

interface RawLane {
  label?: string
  instrument?: string
  block?: string
  side?: string
  pos?: number
  window?: number[] | null
  sample?: number
  tracks?: number[]
  keys?: number[]
  keyBlocks?: unknown
  tune?: number
  thin?: number
  mirrorOf?: string
}

interface RawGeometry {
  originX?: number
  baseY?: number
  walkMid?: number
  laneGap?: number
  tailUnits?: number
  busRefreshInterval?: number
}

/** 把 JSON 里的 keyBlocks 收敛成"鼓键 → 方块"字符串映射 */
export function toKeyBlocks(raw: unknown, at: string, problems: string[]): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${at}.keyBlocks 必须是 { "鼓键": "方块" } 形式的对象`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) problems.push(`${at}.keyBlocks 的键 "${key}" 不是鼓键号`)
    else if (typeof value !== 'string') problems.push(`${at}.keyBlocks["${key}"] 必须是方块 id 字符串`)
    else out[key] = value
  }
  return out
}

export function toLanes(raw: readonly RawLane[]): LaneSpec[] {
  const problems: string[] = []
  const lanes = raw.map((lane, index) => {
    const at = `lanes[${index}]${lane.label ? `(${lane.label})` : ''}`
    if (!lane.label) problems.push(`${at} 缺 label`)
    if (!lane.instrument) problems.push(`${at} 缺 instrument（= 数据包里的乐器名）`)
    if (!lane.block) problems.push(`${at} 缺 block（载体方块）`)
    if (lane.side !== 'N' && lane.side !== 'S') problems.push(`${at}.side 只能是 N 或 S`)
    if (typeof lane.pos !== 'number' || lane.pos < 1) problems.push(`${at}.pos 必须是 ≥1 的整数`)
    if (lane.window && lane.window.length !== 2) problems.push(`${at}.window 必须是两个数 [lo, hi]`)
    const isDrum = !lane.window
    if (isDrum && (!lane.keys || lane.keys.length === 0) && !lane.mirrorOf) {
      problems.push(`${at} 没给 window（当打击乐轨处理）就必须给 keys（接受哪些 GM 鼓键）`)
    }
    return {
      label: lane.label as string,
      instrument: lane.instrument as string,
      block: lane.block as string,
      side: lane.side as 'N' | 'S',
      pos: lane.pos as number,
      window: lane.window ? ([lane.window[0], lane.window[1]] as [number, number]) : null,
      sample: lane.sample,
      tracks: lane.tracks ?? [],
      keys: lane.keys,
      keyBlocks: toKeyBlocks(lane.keyBlocks, at, problems),
      tune: lane.tune,
      thin: lane.thin,
      mirrorOf: lane.mirrorOf,
    }
  })
  if (problems.length > 0) throw new Error(`轨表有问题：\n  - ${problems.join('\n  - ')}`)
  return lanes
}

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

interface ProjectArgs {
  projectFile?: string
  songFile?: string
  lanesFile?: string
  lanes?: readonly RawLane[]
  geometry?: RawGeometry
}

/** 组装工程：projectFile 给全量，songFile/lanesFile/lanes/geometry 逐项覆盖 */
export function loadProject(args: ProjectArgs): { project: BuildProject; geometry: Partial<GeometryOptions> } {
  let song: SongPlan | undefined
  let lanes: RawLane[] | undefined
  let geometry: Partial<GeometryOptions> = {}
  if (args.projectFile) {
    const project = readJson(args.projectFile) as { song?: SongPlan; lanes?: RawLane[]; geometry?: RawGeometry }
    song = project.song
    lanes = project.lanes
    geometry = { ...geometry, ...(project.geometry as Partial<GeometryOptions> | undefined) }
  }
  if (args.songFile) song = readJson(args.songFile) as SongPlan
  if (args.lanesFile) lanes = readJson(args.lanesFile) as RawLane[]
  if (args.lanes) lanes = [...args.lanes]
  if (args.geometry) geometry = { ...geometry, ...(args.geometry as Partial<GeometryOptions>) }

  if (!song) throw new Error('缺谱面：给 projectFile（含 song）或 songFile')
  if (!lanes || lanes.length === 0) throw new Error('缺轨表：给 projectFile（含 lanes）、lanesFile 或 lanes')
  if (!(song.bpm > 0)) throw new Error('谱面 bpm 非法')
  if (!Array.isArray(song.notes) || song.notes.length === 0) throw new Error('谱面 notes 为空')
  for (const [index, note] of song.notes.entries()) {
    if (typeof note?.t !== 'number' || typeof note?.midi !== 'number' || typeof note?.track !== 'number') {
      throw new Error(`notes[${index}] 必须是 { t, midi, track }（都是数字）`)
    }
  }
  const normalized: SongPlan = {
    bpm: song.bpm,
    start: typeof song.start === 'number' ? song.start : 0,
    notes: song.notes.map((note: SongNote) => ({ t: note.t, midi: note.midi, track: note.track })),
  }
  return { project: { song: normalized, lanes: toLanes(lanes), geometry }, geometry }
}

export function registerBuildTool(ctx: Context, config: Config): void {
  ctx.tools.register(
    defineTool({
      name: 'rm_build',
      description:
        '把红石音乐谱面编译成 Minecraft 数据包并（可选）部署开建。' +
        '输入：谱面（bpm/start/notes[{t,midi,track}]）+ 轨表（每条轨 = 一种音色：instrument/block/side/pos/window/sample/tracks）。' +
        '它会分配音符到槽位（每轨每刻最多 3 个音符盒）、算总线刷新中继器与各轨延迟补偿、' +
        '生成 mcfunction 分片（每片 8000 条 + 片间 schedule 2t + 末尾唤醒中继器），' +
        '并同时写出 Glissando 乐器定义（sound_event 强制用原版事件，杜绝"全是错音"）。' +
        'action=pack 只写数据包；action=deploy 还会经 RCON 设 tick rate、reload、启用数据包、分段强加载并 /function 开建。' +
        '★ 建造期间不要用别的脚本碰 RCON（会让建造任务失去连接并从头重跑）。',
      parameters: {
        action: { type: 'string', enum: ['pack', 'deploy'], description: 'pack=只生成数据包；deploy=再经 RCON 开建（默认 pack）' },
        namespace: { type: 'string', description: '数据包命名空间（默认 rm_build，只能小写字母数字下划线）' },
        projectFile: { type: 'string', description: '工程 JSON：{ song, lanes, geometry? }（与 songFile/lanes 二选一）' },
        songFile: { type: 'string', description: '谱面 JSON：{ bpm, start, notes:[{t,midi,track}] }' },
        lanesFile: { type: 'string', description: '轨表 JSON：[{label,instrument,block,side,pos,...}]' },
        lanes: {
          type: 'array',
          description: '轨表（内联）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true, description: '轨的唯一标识' },
              instrument: { type: 'string', required: true, description: '乐器名（进数据包乐器定义的文件名）' },
              block: { type: 'string', required: true, description: '载体方块（红石导体 + 不在 mod 内置标签里）' },
              side: { type: 'string', enum: ['N', 'S'], required: true, description: '走道北侧/南侧' },
              pos: { type: 'number', required: true, description: '该侧第几条（1 起）：z = walkMid ∓ pos·laneGap，dy = 1+2(pos−1)' },
              window: {
                oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }],
                description: '音域窗口 [lo,hi]；null（或不给）= 打击乐轨',
              },
              sample: { type: 'number', description: '采样录音音高（缺省 = window[0]+12）；note = midi − sample + 12' },
              tracks: { type: 'array', required: true, items: { type: 'number' }, description: '源轨号' },
              keys: { type: 'array', items: { type: 'number' }, description: '打击乐：接受哪些 GM 鼓键' },
              keyBlocks: { type: 'json', description: '打击乐：鼓键 → 载体方块（一条轨出多种鼓声）' },
              tune: { type: 'number', description: '打击乐固定 note（默认 12 = 采样原始音高）' },
              thin: { type: 'number', description: '抽稀：只保留 unit 为该值倍数的音（打击乐常用 2）' },
              mirrorOf: { type: 'string', description: '镜像哪条轨（逐音复制，走道两侧同时发声）' },
            },
          },
        },
        geometry: {
          type: 'object',
          additionalProperties: false,
          description: '几何（不给就用默认：originX=250 baseY=180 walkMid=520 laneGap=5 tailUnits=4）',
          properties: {
            originX: { type: 'number' },
            baseY: { type: 'number' },
            walkMid: { type: 'number' },
            laneGap: { type: 'number' },
            tailUnits: { type: 'number' },
            busRefreshInterval: { type: 'number', description: '总线每铺多少格红石线插一个刷新中继器（默认 12）' },
          },
        },
        outputDir: { type: 'string', description: '数据包目录；缺省 <serverDir>/<datapackDir>/<namespace>' },
        packFormat: { type: 'number', description: 'pack_format（1.21 = 48，默认 48）' },
        shardSize: { type: 'number', description: '每片 mcfunction 的命令数（默认 8000）' },
        allowOccupiedBlocks: { type: 'boolean', description: '允许使用被 Glissando 内置标签圈走的方块（默认 false，会直接报错）' },
        setTickRate: { type: 'boolean', description: 'deploy 时顺便设 tick rate（默认 true；它不存档，重启要重设）' },
        doForceload: { type: 'boolean', description: 'deploy 时分段强加载建造范围（默认 true）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            namespace: { type: 'string', required: true },
            datapackDir: { type: 'string', required: true },
            unitSeconds: { type: 'number', required: true },
            tickRate: { type: 'number', required: true },
            units: { type: 'number', required: true },
            commandCounts: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                clears: { type: 'number', required: true },
                fills: { type: 'number', required: true },
                cells: { type: 'number', required: true },
                commands: { type: 'number', required: true },
                repeaters: { type: 'number', required: true },
              },
            },
            shards: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  commands: { type: 'number', required: true },
                },
              },
            },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { file: { type: 'string', required: true }, bytes: { type: 'number', required: true } },
              },
            },
            instruments: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  block: { type: 'string', required: true },
                  soundEvent: { type: 'string', required: true },
                },
              },
            },
            stats: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                total: { type: 'number', required: true },
                placed: { type: 'number', required: true },
                dropped: { type: 'number', required: true },
                outOfWindow: { type: 'number', required: true },
                offGrid: { type: 'number', required: true },
                thinned: { type: 'number', required: true },
                capacity: { type: 'number', required: true },
              },
            },
            lanes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true },
                  instrument: { type: 'string', required: true },
                  block: { type: 'string', required: true },
                  z: { type: 'number', required: true },
                  dy: { type: 'number', required: true },
                  delay: { type: 'number', required: true },
                  xStart: { type: 'number', required: true },
                  notes: { type: 'number', required: true },
                },
              },
            },
            bounds: { type: 'json', required: true },
            deploy: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                requested: { type: 'boolean', required: true },
                performed: { type: 'boolean', required: true },
                steps: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { command: { type: 'string', required: true }, result: { type: 'string', required: true } },
                  },
                },
                forceload: { type: 'array', required: true, items: { type: 'string' } },
                errors: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            nextSteps: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const lines: string[] = []
          lines.push(
            `【${value.action}】${value.namespace} → ${value.datapackDir}\n` +
              `单位 ${(value.unitSeconds * 1000).toFixed(2)}ms（需要 tick rate ${value.tickRate.toFixed(3)}），共 ${value.units} 个单位\n` +
              `命令：清场 ${value.commandCounts.clears} / 铺底 ${value.commandCounts.fills} / 元件 ${value.commandCounts.cells} = 合计 ${value.commandCounts.commands} 条，切成 ${value.shards.length} 片\n` +
              `音符：放下 ${value.stats.placed}，丢弃 ${value.stats.dropped}（窗口外 ${value.stats.outOfWindow}、超容量 ${value.stats.capacity}、离网格 ${value.stats.offGrid}、抽稀 ${value.stats.thinned}）\n` +
              `乐器 ${value.instruments.length} 个（sound_event 全部为原版事件）`,
          )
          for (const lane of value.lanes) {
            lines.push(`  z=${String(lane.z).padStart(4)} dy=${lane.dy} 延迟${lane.delay} 起点x=${lane.xStart}  ${lane.label}（${lane.instrument}）${lane.notes} 音`)
          }
          lines.push(`数据包文件 ${value.files.length} 个`)
          for (const step of value.deploy.steps) lines.push(`  > ${step.command}\n    ${step.result.split('\n')[0]}`)
          if (value.deploy.forceload.length > 0) lines.push(`强加载分段 ${value.deploy.forceload.length} 条：${value.deploy.forceload.join(' | ')}`)
          if (value.deploy.errors.length > 0) lines.push(`✗ 部署报错：\n  - ${value.deploy.errors.join('\n  - ')}`)
          if (value.warnings.length > 0) lines.push(`注意：\n  - ${value.warnings.join('\n  - ')}`)
          lines.push(`下一步：\n  - ${value.nextSteps.join('\n  - ')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const namespace = args.namespace ?? 'rm_build'
        const action = args.action ?? 'pack'
        const { project, geometry } = loadProject(args)
        const plan = planBuild(project, {
          namespace,
          packFormat: args.packFormat,
          shardSize: args.shardSize,
          allowOccupiedBlocks: args.allowOccupiedBlocks,
        })
        if (exec.signal.aborted) throw new Error('已取消')

        if (!args.outputDir && config.serverDir.trim() === '') {
          throw new Error(
            '不知道数据包该写到哪：没给 outputDir，插件配置里的 serverDir 也是空的。' +
              '二选一：调用时给 outputDir（例如 <服务端目录>/world/datapacks/rm_build），或在插件配置里设 serverDir。',
          )
        }
        const datapackDir = args.outputDir ?? path.join(config.serverDir, config.datapackDir, namespace)
        const written = writeDatapack({
          dir: datapackDir,
          namespace,
          packFormat: args.packFormat ?? 48,
          description: `rm_build: ${namespace}（${plan.units} 单位 / ${plan.allocation.stats.placed} 音）`,
          shards: plan.shards,
          extraShards: plan.refreshShards,
          instruments: plan.instruments,
          meta: plan.meta,
        })

        const forceload = forceloadCommands(forceloadSegments(plan.commands.bounds))
        const warnings = [...plan.warnings]
        const deploy = {
          requested: action === 'deploy',
          performed: false,
          steps: [] as { command: string; result: string }[],
          forceload,
          errors: [] as string[],
        }

        if (action === 'deploy') {
          if (!config.rconPassword) {
            deploy.errors.push('没有配置 RCON 密码（插件配置 rconPassword）→ 只能 pack，不能 deploy')
          } else {
            const commands: string[] = []
            if (args.setTickRate ?? true) commands.push(`tick rate ${Number(plan.tickRate.toFixed(4))}`)
            commands.push('reload')
            commands.push(`datapack enable "file/${namespace}"`)
            if (args.doForceload ?? true) commands.push(...forceload)
            commands.push(`function ${namespace}:build1`)
            commands.push('datapack list')
            let client
            try {
              client = await openRcon({
                host: config.rconHost,
                port: config.rconPort,
                password: config.rconPassword,
              })
              const results = await client.execMany(commands, { batchDelayMs: 60 })
              results.forEach((result, index) => deploy.steps.push({ command: commands[index] as string, result: result.trim() }))
              deploy.performed = true
              const listResult = deploy.steps[deploy.steps.length - 1]
              if (listResult && !/file\/|available|enabled/i.test(listResult.result)) {
                warnings.push(`datapack list 的输出看起来不含 "${namespace}"：${listResult.result.slice(0, 200)}`)
              }
            } catch (error) {
              deploy.errors.push(String(error instanceof Error ? error.message : error))
            } finally {
              client?.close()
            }
          }
        }

        const meta = plan.meta as { lanes?: { notes?: number }[] }
        const nextSteps = [
          `数据包已写到 ${datapackDir}；若服务端没在跑或目录不在这，把整个目录拷进 <serverDir>/<datapackDir>/ 再 /reload。`,
          `/reload → /datapack enable "file/${namespace}" → /function ${namespace}:build1（分片会自动 schedule 接力，最后唤醒中继器）。`,
          `建完用标签断言复核音色无歧义：/execute if block <x> <y> <z> #${namespace}:note_block_instruments/<乐器> 必须 passed。`,
          '看服务端启动日志有没有 Errors in registry / Failed to get element —— 有就是乐器表没配好（会回退 harp，全是错音）。',
          `/tick query 看平均刻时间；平均 >40ms 就先 kill @e[type=!player] 并减少灯/粒子。`,
        ]
        if (plan.tickRate > 20.5 || plan.tickRate < 19.5) {
          nextSteps.push(`★ tick rate 设成 ${plan.tickRate.toFixed(3)}（不存档，服务端每次重启都要重设），否则速度不对。`)
        }
        nextSteps.push('建造期间只用读日志看进度，不要用别的脚本碰 RCON（会让建造任务失去连接并从头重跑）。')

        return {
          action,
          namespace,
          datapackDir,
          unitSeconds: Number(plan.unitSeconds.toFixed(6)),
          tickRate: Number(plan.tickRate.toFixed(4)),
          units: plan.units,
          commandCounts: {
            clears: plan.commands.counts.clears,
            fills: plan.commands.counts.fills,
            cells: plan.commands.counts.cells,
            commands: plan.commands.counts.commands,
            repeaters: plan.commands.repeaterCommands.length,
          },
          shards: plan.shards.map((shard) => ({ name: shard.name, commands: shard.lines.length })),
          files: written.files.map((file) => ({ file: file.file, bytes: file.bytes })),
          instruments: plan.instruments.map((instrument) => ({
            name: instrument.name,
            block: instrument.block,
            soundEvent: instrument.soundEvent,
          })),
          stats: {
            total: plan.allocation.stats.total,
            placed: plan.allocation.stats.placed,
            dropped: plan.allocation.stats.dropped,
            outOfWindow: plan.allocation.stats.outOfWindow,
            offGrid: plan.allocation.stats.offGrid,
            thinned: plan.allocation.stats.thinned,
            capacity: plan.allocation.stats.capacity,
          },
          lanes: plan.layout.lanes.map((lane, index) => ({
            label: lane.label,
            instrument: lane.instrument,
            block: lane.block,
            z: lane.z,
            dy: lane.dy,
            delay: lane.delay,
            xStart: lane.xStart,
            notes: meta.lanes?.[index]?.notes ?? 0,
          })),
          bounds: plan.commands.bounds,
          deploy,
          warnings,
          nextSteps,
        }
      },
    }),
  )
}

export { DEFAULT_GEOMETRY }
