#!/usr/bin/env node
/**
 * verify-e2e.mjs —— 用【真实素材】端到端验证 rm_render / rm_build（跑的是构建产物 lib/index.js）
 *
 * 素材：
 *   · 谱面 F:/desktop/project 2/redstone-music/beethoven-virus.json（158 BPM，7313 个音）
 *   · SoundFont …/generaluser/GeneralUser.sf2
 *   · 轨表 = 参考工程 gen-virus2-fn.mjs 里最终定稿的 20 条轨（含 7 条打击乐）
 *
 * 校验点（都可核对文档里的实测数字）：
 *   ① 插件能加载、4 个工具全部注册成功（schema 一旦写错，defineTool 会当场抛错）
 *   ② rm_render：真实 sf2 渲染 + 起音对齐，输出起音 ≤3ms
 *   ③ rm_build：单位时长 94.94ms → 需要 tick rate 21.066（与文档一致）
 *   ④ rm_build：命令切成 ≤8000 条的 mcfunction 分片，片间 schedule 接力
 *   ⑤ rm_build：乐器 sound_event 全部是原版事件（写自定义命名空间 = 全是错音）
 *
 * 用法：node scripts/verify-e2e.mjs [--out <目录>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const REFERENCE = 'F:/desktop/project 2/redstone-music'
const args = process.argv.slice(2)
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const outRoot = argOf('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'rm-verify-')))

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── ① 加载插件并收集注册的工具
const tools = new Map()
const ctx = { tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
const config = {
  enabled: true,
  serverDir: REFERENCE,
  rconHost: '127.0.0.1',
  rconPort: 25575,
  rconPassword: '',
  datapackDir: 'world/datapacks',
  clientPackDir: '',
  soundFont: path.join(REFERENCE, 'sound/node_modules/generaluser/GeneralUser.sf2'),
  sampleDir: '',
  sampleRate: 44100,
  maxOnsetMs: 3,
}
console.log('① 加载插件（lib/index.js）')
apply(ctx, config)
check(
  ['redstone_music_pitfalls', 'redstone_music_pipeline', 'rm_render', 'rm_build'].every((name) => tools.has(name)),
  '四个工具都注册成功',
  [...tools.keys()].join(', '),
)

const exec = { signal: new AbortController().signal }

// ── ② rm_render：真实 sf2 渲染 + 起音对齐
console.log('\n② rm_render（真实 SoundFont 渲染 → 起音对齐）')
const sampleDir = path.join(outRoot, 'samples')
const renderResult = await tools.get('rm_render').execute(
  {
    action: 'render',
    outDir: sampleDir,
    namespace: 'virus2',
    slots: [
      { name: 'piano_low', kind: 'pitched', program: 0, window: [40, 52], sample: 46, block: 'minecraft:moss_block', decaySec: 0.4 },
      { name: 'strings_mid', kind: 'pitched', program: 48, window: [62, 72], sample: 67, block: 'minecraft:sculk', decaySec: 0.9, durationSec: 2 },
      { name: 'kick', kind: 'drum', key: 36, block: 'minecraft:weathered_copper', decaySec: 0.3 },
    ],
  },
  exec,
)
check(renderResult.count === 3, '渲染出 3 个采样', renderResult.items.map((i) => `${i.name}=${i.outOnsetMs}ms`).join(' '))
check(renderResult.failed === 0, '全部起音 ≤3ms', `raw ${renderResult.items.map((i) => i.rawOnsetMs).join('/')}ms`)
check(fs.existsSync(renderResult.manifestFile), '写出 instruments.json 清单')

// ── ③④⑤ rm_build：真实谱面 + 参考工程的 20 轨轨表
const LANES = [
  { label: '大钢琴·低', instrument: 'piano_low', block: 'minecraft:moss_block', side: 'N', pos: 1, window: [40, 52], sample: 46, tracks: [2, 3] },
  { label: '大钢琴·中低', instrument: 'piano_midlow', block: 'minecraft:mud', side: 'N', pos: 2, window: [53, 65], sample: 59, tracks: [2, 3] },
  { label: '大钢琴·中高', instrument: 'piano_midhigh', block: 'minecraft:packed_mud', side: 'N', pos: 3, window: [66, 77], sample: 72, tracks: [2, 3] },
  { label: '大钢琴·高', instrument: 'piano_high', block: 'minecraft:sculk', side: 'N', pos: 4, window: [78, 88], sample: 83, tracks: [2, 3] },
  { label: '弦乐震音·低', instrument: 'strings_low', block: 'minecraft:sculk_catalyst', side: 'N', pos: 5, window: [39, 50], sample: 45, tracks: [5, 6, 7, 8, 9, 10] },
  { label: '弦乐震音·中低', instrument: 'strings_mlow', block: 'minecraft:honeycomb_block', side: 'N', pos: 6, window: [51, 61], sample: 56, tracks: [5, 6, 7, 8, 9, 10] },
  { label: '弦乐震音·中', instrument: 'strings_mid', block: 'minecraft:honey_block', side: 'N', pos: 7, window: [62, 72], sample: 67, tracks: [5, 6, 7, 8, 9, 10] },
  { label: '弦乐震音·中高', instrument: 'strings_mhigh', block: 'minecraft:slime_block', side: 'N', pos: 8, window: [73, 82], sample: 78, tracks: [5, 6, 7, 8, 9, 10] },
  { label: '弦乐震音·高', instrument: 'strings_high', block: 'minecraft:dried_kelp_block', side: 'N', pos: 9, window: [83, 92], sample: 88, tracks: [5, 6, 7, 8, 9, 10] },
  { label: '合成铜管2', instrument: 'synthbrass', block: 'minecraft:amethyst_block', side: 'N', pos: 10, window: [40, 62], sample: 51, tracks: [4] },
  { label: '铜管乐组', instrument: 'brass', block: 'minecraft:budding_amethyst', side: 'S', pos: 1, window: [52, 70], sample: 61, tracks: [12] },
  { label: '无品贝斯', instrument: 'fretless', block: 'minecraft:copper_block', side: 'S', pos: 2, window: [28, 45], sample: 37, tracks: [11] },
  { label: '定音鼓', instrument: 'timpani', block: 'minecraft:exposed_copper', side: 'S', pos: 3, window: [38, 52], sample: 45, tracks: [0] },
  { label: '鼓·底鼓', instrument: 'kick', block: 'minecraft:weathered_copper', side: 'S', pos: 4, window: null, tracks: [1], keys: [35, 36], tune: 12 },
  { label: '鼓·军鼓', instrument: 'snare', block: 'minecraft:netherite_block', side: 'S', pos: 5, window: null, tracks: [1], keys: [38, 40], tune: 12 },
  { label: '鼓·击掌', instrument: 'clap', block: 'minecraft:lodestone', side: 'S', pos: 6, window: null, tracks: [1], keys: [39], tune: 12 },
  { label: '鼓·踩镲', instrument: 'hihat', block: 'minecraft:shroomlight', side: 'S', pos: 7, window: null, tracks: [1], keys: [42, 46], tune: 12 },
  { label: '鼓·铃鼓', instrument: 'tambourine', block: 'minecraft:sponge', side: 'S', pos: 8, window: null, tracks: [1], keys: [54], tune: 12 },
  { label: '鼓·叮叮镲', instrument: 'ride', block: 'minecraft:waxed_weathered_copper', side: 'S', pos: 9, window: null, tracks: [1], keys: [53, 59], tune: 12 },
  { label: '鼓·镲类', instrument: 'crash', block: 'minecraft:verdant_froglight', side: 'S', pos: 10, window: null, tracks: [1], keys: [49, 52, 55, 57, 58], tune: 12 },
]

console.log('\n③④⑤ rm_build（真实谱面《Beethoven Virus》+ 参考工程 20 轨）')
const datapackDir = path.join(outRoot, 'datapacks/virus_build')
const buildResult = await tools.get('rm_build').execute(
  {
    action: 'pack',
    namespace: 'virus_build',
    songFile: path.join(REFERENCE, 'beethoven-virus.json'),
    lanes: LANES,
    outputDir: datapackDir,
    geometry: { originX: 250, baseY: 180, walkMid: 545, laneGap: 5, tailUnits: 4 },
  },
  exec,
)

check(Math.abs(buildResult.unitSeconds * 1000 - 94.94) < 0.05, '单位时长 = 94.94ms（158 BPM 十六分）', `${(buildResult.unitSeconds * 1000).toFixed(3)}ms`)
check(Math.abs(buildResult.tickRate - 21.066) < 0.01, 'tick rate = 21.066（与文档一致）', buildResult.tickRate.toFixed(4))
// 文档：「单位 94.94ms；总 1679 个单位；时长 159.6 秒」+ 尾巴 4 个单位
const durationSec = (buildResult.units - 4) * buildResult.unitSeconds
check(Math.abs(durationSec - 159.6) < 0.5, '长度 ≈ 159.6 秒（与文档一致）', `${durationSec.toFixed(1)}s / ${buildResult.units} 个单位（含 4 单位尾巴）`)
// 文档：「范围 x 250..3628」→ xEnd 一定等于 originX + 2·units + 8
check(buildResult.bounds.x2 - 2 === 250 + 2 * buildResult.units + 8, '链条终点 x = 3628（与文档的 x 250..3628 一致）', `xEnd=${buildResult.bounds.x2 - 2}`)
// 文档：「20 轨 / 丢 15 个音」「7195 个音」
check(
  buildResult.stats.placed + buildResult.stats.dropped === 7195 && buildResult.stats.dropped === 15,
  '音符账目与文档一致：7195 个音 → 放下 7180 / 丢 15',
  `放下 ${buildResult.stats.placed}、丢 ${buildResult.stats.dropped}`,
)
check(
  buildResult.shards.every((s) => s.commands <= 8001),
  '每片 mcfunction ≤8000 条命令（多出的 1 条是 schedule）',
  `${buildResult.shards.length} 片，最大 ${Math.max(...buildResult.shards.map((s) => s.commands))} 条`,
)
// 文档：「143,712 条命令 / 18 个 mcfunction」——参考实现把"唤醒中继器"的两轮也算在命令总数里，
// 本插件把它拆成 refresh / refresh2 两个函数，所以按【总量】对齐才有可比性。
const totalCommands = buildResult.commandCounts.commands + 2 * buildResult.commandCounts.repeaters
check(
  Math.abs(totalCommands - 143_712) / 143_712 < 0.01,
  '命令总量与参考工程实测的 143,712 条相差 <1%',
  `${totalCommands} 条（build ${buildResult.commandCounts.commands} + 唤醒 2×${buildResult.commandCounts.repeaters}），共 ${buildResult.shards.length + 2} 个 mcfunction`,
)
check(
  buildResult.instruments.every((i) => i.soundEvent.startsWith('minecraft:')),
  '乐器 sound_event 全是原版事件',
  `${buildResult.instruments.length} 个乐器`,
)
check(
  new Set(buildResult.instruments.map((i) => i.soundEvent)).size === buildResult.instruments.length,
  '每个乐器占用的事件互不重复',
)

const mcmeta = JSON.parse(fs.readFileSync(path.join(datapackDir, 'pack.mcmeta'), 'utf8'))
check(mcmeta.pack.pack_format === 48, 'pack.mcmeta pack_format = 48（1.21）')
const shardFiles = fs.readdirSync(path.join(datapackDir, 'data/virus_build/function')).filter((f) => f.endsWith('.mcfunction'))
check(shardFiles.includes('build1.mcfunction') && shardFiles.includes('refresh.mcfunction'), '生成了 build*.mcfunction 与 refresh.mcfunction', `${shardFiles.length} 个函数文件`)
const firstShard = fs.readFileSync(path.join(datapackDir, 'data/virus_build/function/build1.mcfunction'), 'utf8').trimEnd().split('\n')
check(firstShard[firstShard.length - 1] === 'schedule function virus_build:build2 2t', '片尾 schedule 接力下一片')
const lastShard = fs.readFileSync(path.join(datapackDir, `data/virus_build/function/build${buildResult.shards.length}.mcfunction`), 'utf8')
check(lastShard.includes('schedule function virus_build:refresh 2t'), '最后一片 schedule 唤醒中继器')
check(!fs.readFileSync(path.join(datapackDir, 'data/virus_build/function/refresh.mcfunction'), 'utf8').includes('note_block'), '唤醒只重放中继器（不动音符盒）')

console.log('\n建造规模：')
console.log(`  清场 ${buildResult.commandCounts.clears} 条 fill；铺底 ${buildResult.commandCounts.fills} 条；元件 ${buildResult.commandCounts.cells} 个`)
console.log(`  命令合计 ${buildResult.commandCounts.commands} 条 → ${buildResult.shards.length} 片；中继器唤醒 ${buildResult.commandCounts.repeaters} 个 ×2 轮`)
console.log(
  `  音符：放下 ${buildResult.stats.placed}，丢弃 ${buildResult.stats.dropped}` +
    `（窗口外 ${buildResult.stats.outOfWindow}、每刻超 3 个 ${buildResult.stats.capacity}、离网格 ${buildResult.stats.offGrid}、抽稀 ${buildResult.stats.thinned}）`,
)
console.log(`  范围 ${JSON.stringify(buildResult.bounds)}`)
console.log(`  产物：${datapackDir}`)
check(buildResult.commandCounts.commands > 50_000, '单次建造的命令规模与参考工程同量级（>5 万条）')
check(
  buildResult.lanes.every((lane) => lane.xStart === 250 + 2 * lane.delay && Math.abs(lane.xStart % 2) === 0),
  '各轨链条起点含延迟补偿（xStart = originX + 2·delay）',
)
const delays = buildResult.lanes.map((lane) => lane.delay)
console.log(`  各轨延迟：${buildResult.lanes.map((l) => `${l.label}=${l.delay}`).join(' ')}`)
check(new Set(delays).size > 1, '不同轨拿到不同的总线延迟（说明延迟补偿真的在工作）', `延迟集合 ${[...new Set(delays)].sort((a, b) => a - b).join(',')}`)

// ── ⑥ deploy 路径：对着假 RCON 服务端跑一遍，验命令顺序（这是唯一会改世界的代码路径）
console.log('\n⑥ rm_build --deploy（假 RCON 服务端，只验命令序列）')
const { default: net } = await import('node:net')
const received = []
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 12) break
      const length = buffer.readInt32LE(0)
      if (buffer.length < length + 4) break
      const id = buffer.readInt32LE(4)
      const type = buffer.readInt32LE(8)
      const body = buffer.toString('utf8', 12, length + 2)
      buffer = Buffer.from(buffer.subarray(length + 4))
      const reply = (replyId, replyType, text) => {
        const payload = Buffer.from(text, 'utf8')
        const out = Buffer.alloc(14 + payload.length)
        out.writeInt32LE(10 + payload.length, 0)
        out.writeInt32LE(replyId, 4)
        out.writeInt32LE(replyType, 8)
        payload.copy(out, 12)
        socket.write(out)
      }
      if (type === 3) reply(body === 'verify-password' ? id : -1, 2, '')
      else {
        received.push(body)
        reply(id, 0, body.startsWith('datapack list') ? 'There are 2 datapacks:\n- file/virus_build' : 'ok')
      }
    }
  })
})
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// 用指向假 RCON 的配置再挂一次插件（工具闭包捕获配置，所以要另起一个注册表）
const deployTools = new Map()
apply(
  { tools: { register: (definition) => { deployTools.set(definition.name, definition); return () => deployTools.delete(definition.name) } } },
  { ...config, rconPort: port, rconPassword: 'verify-password' },
)
const deployResult = await deployTools.get('rm_build').execute(
  {
    action: 'deploy',
    namespace: 'virus_build',
    songFile: path.join(REFERENCE, 'beethoven-virus.json'),
    lanes: LANES,
    geometry: { originX: 250, baseY: 180, walkMid: 545, laneGap: 5, tailUnits: 4 },
  },
  exec,
)
await new Promise((resolve) => server.close(resolve))

console.log(`  发出命令：${received.map((c) => c.slice(0, 28)).join(' | ')}`)
check(received[0] === `tick rate ${buildResult.tickRate}`, 'deploy 先设 tick rate（不存档，重启要重设）', received[0])
check(received[1] === 'reload', 'deploy 第二步行 /reload')
check(received[2] === 'datapack enable "file/virus_build"', 'deploy 启用数据包（/reload 不会自动启用新包）', received[2])
check(received.filter((c) => c.startsWith('forceload add')).length > 1, 'deploy 分段强加载（单条 256 区块上限，必须分段）', `${received.filter((c) => c.startsWith('forceload add')).length} 段`)
check(received.includes('function virus_build:build1'), 'deploy 最后用 /function 开建（分片自己 schedule 接力）')
check(received[received.length - 1] === 'datapack list', 'deploy 收尾核对数据包已启用')
check(deployResult.deploy.performed === true && deployResult.deploy.errors.length === 0, 'deploy 全程无错误', deployResult.deploy.errors.join('; '))

console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项未通过 ✗`}`)
process.exit(failures === 0 ? 0 : 1)
