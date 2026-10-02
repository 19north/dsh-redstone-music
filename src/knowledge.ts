/**
 * knowledge.ts —— 红石音乐制作的全部硬教训（浓缩自 2026-10-01/02 的实战）
 *
 * 每条都带：症状（怎么发现）→ 根因 → 修法 → 检测方法
 * 这是本插件最有价值的部分：把"踩一次要花几小时"的坑固化成可查的清单。
 */

export interface Pitfall {
  id: string
  area: '音频' | '时序' | '性能' | '数据包' | '方块' | '工具'
  title: string
  /** 症状：用户/AI 实际观察到的现象 */
  symptom: string
  /** 根因 */
  cause: string
  /** 修法 */
  fix: string
  /** 怎么客观检测（命令或脚本思路） */
  detect: string
}

export const PITFALLS: Pitfall[] = [
  {
    id: 'glissando-sound-event',
    area: '数据包',
    title: '★ Glissando 乐器的 sound_event 必须是【服务端认得】的原版事件',
    symptom: '音符盒会响但音色和音高全错（"全是错音"）；世界数据、红石时序、采样起音全部验证正确，却依然难听',
    cause:
      'Glissando 的乐器表是数据包注册表，sound_event 由【服务端】解析。写 "virus:piano" 这种自定义命名空间时，' +
      '该事件只存在于客户端资源包的 sounds.json，服务端 sound_event 注册表里没有 → 整张乐器表加载失败 → ' +
      '所有音符盒回退到原版默认音色（harp）→ 音高全错',
    fix:
      'sound_event 一律写原版事件（16 个 block.note_block.* + 任意冷门原版事件，共几百个可选）；' +
      '再用资源包把那些事件【覆盖】成自己的采样（assets/minecraft/sounds.json），音色数量依然不受限',
    detect:
      '服务端启动日志搜 "Errors in registry" / "Failed to get element" / "Failed to load registries"。' +
      '有就是没配好。注意 /reload 不一定刷出这个错，必须看启动日志',
  },
  {
    id: 'glissando-tag-conflict',
    area: '数据包',
    title: '载体方块不能落在 mod 内置的原版标签里',
    symptom: '音色被解析成完全不相干的乐器（例如钢琴全变成底鼓）',
    cause:
      'Glissando 自带 22 个 minecraft:note_block_instruments/* 标签，圈走了 612 种方块：' +
      'basedrum 含 #base_stone_overworld（stone/deepslate/granite/andesite/tuff/calcite/obsidian/purpur/quartz…），' +
      'bass 含各种木板，hat 含玻璃系，pling 含 glowstone',
    fix:
      '先程序化求出"安全方块集合"（解 jar 里的内置标签，递归展开 #minecraft:* 引用，取补集），再从补集里分配。' +
      '实测安全的 53 种：moss_block/mud/packed_mud/sculk/amethyst_block/copper_block/netherite_block/' +
      'ancient_debris/lodestone/shroomlight/froglight/sponge/honeycomb_block/chain/lantern…',
    detect:
      'execute if block <x> <y> <z> #<ns>:note_block_instruments/<乐器>  → 必须 passed；' +
      'execute if block <x> <y> <z> #minecraft:note_block_instruments/basedrum → 必须 failed',
  },
  {
    id: 'sample-onset',
    area: '音频',
    title: '★ 分层齐奏时，各层采样的【起音】必须接近',
    symptom: '用户说"音不同步""同一时间的两个乐器感觉有时差""很乱"（而不是"音不对"）',
    cause:
      'GeneralUser 的 Tremolo Strings 峰值在 224~293ms（慢慢涨起来），钢琴在 13~36ms（一敲就响）。' +
      '原曲主旋律是钢琴+弦乐震音齐奏 → 弦乐听起来"晚了半拍"',
    fix:
      '① 慢起音音色换掉（GM44 震音 → GM48 弦乐合奏，起音快且仍是弦乐）；' +
      '② 所有采样统一"起音裁切"：裁到【5ms 滑动 RMS 首次达到最大值 50%】的位置 + 2ms 淡入；' +
      '③ 渲完立刻测量并断言起音 ≤3ms',
    detect:
      '读 wav 算 5ms 滑动 RMS 包络，起音 = 首个达到最大 RMS 50% 的位置。跨轨差异 >5ms 就能听出来。' +
      '★ 不要用"峰值位置"当指标——波形有多个相近峰，指标会跳（我踩过）',
  },
  {
    id: 'mcfunction-batch',
    area: '工具',
    title: '★ 批量建造走 mcfunction，不要逐格 RCON',
    symptom: '铺一条 3000 格的带子要 40 分钟',
    cause: '逐格 setblock = 每格一次 RCON 往返，实测只有 5.4 格/秒',
    fix:
      '把命令攒起来写成 .mcfunction，一次 /function 在【一个游戏刻】内执行几千条 → 143,712 条命令只要 30 秒（快 9 倍）。' +
      '每片 ≤8000 条（maxCommandChainLength 默认 65536/刻），片间用 schedule 或外部逐片调用衔接',
    detect: '看每片耗时；单条 /fill 上限 32768 格，单条 /forceload add 上限 256 区块',
  },
  {
    id: 'delay-compensation',
    area: '时序',
    title: '各轨的总线延迟必须补偿：内容 x 与 delay 无关',
    symptom: '同一时刻的音，不同轨听起来错开（延迟 0~5 个游戏刻 = 0~475ms）',
    cause:
      '总线每隔约 10 格插刷新中继器，每条轨的抽头要经过若干个才能拿到信号 → 轨越远信号越晚（T_L 刻）。' +
      '若链条起点跟着往东挪 2×T_L，则整条轨晚了 T_L 个单位',
    fix:
      '链条起点放 X0+2×T_L 没问题，但【内容】必须按全局单位摆：x = X0 + 2u + 1（u = 音乐单位，与 delay 无关）；' +
      '链条第 m 格对应全局单位 m+T_L',
    detect:
      '读各轨粒子指令方块的 LastExecution：同一音乐单位下，所有轨必须完全相同。' +
      '注意：探针 x 要用 X0+2u+1（奇数=载体列），并且要按各轨 delay 取对应链条位置',
  },
  {
    id: 'repeater-support',
    area: '方块',
    title: '中继器必须放在固体方块上——别把支撑层清成空气',
    symptom: '链条推进一格就断（"前8级 1/8"），整条带子半哑',
    cause: '清理特效层时把 dy-1（中继器的支撑层）fill 成 air → 所有中继器当场弹掉',
    fix:
      '清场时填【白混凝土】而不是空气（同样是固体，中继器不弹）；' +
      '或者用 fill ... replace minecraft:white_concrete 只替换支撑块本身',
    detect: 'execute if block <偶数x> <dy> <z> minecraft:repeater —— 偶数 x 应全是中继器',
  },
  {
    id: 'repeater-parity',
    area: '方块',
    title: '粒子块/灯要放【载体列】（奇数 x），中继器列不向下供电',
    symptom: '粒子指令方块永不触发（LastExecution 查不到）',
    cause: '链条是"偶数 x=中继器 / 奇数 x=载体+音符盒"交替；中继器只向它朝向的方块供电，不向下供电',
    fix: '特效方块放到 x = xStart + 2u + 1（载体正下方/正旁边）',
    detect: 'data get block <x> <y> <z> LastExecution —— 空则没被供电过',
  },
  {
    id: 'server-load',
    area: '性能',
    title: '★ 三个负载杀手：实体 / 密集红石灯 / 密集指令方块',
    symptom: '波前慢、音乐"忽快忽慢很乱"；tick 时间远超预算',
    cause:
      '实测 148ms/tick（预算 47.5）= 波前只有 1/3 速度。来源：红石灯 67,400 盏（整行铺满）+ ' +
      '粒子指令方块 67,400 个（整行铺满）+ 强加载区里堆积的 20,484 个实体',
    fix:
      '灯改成跑马灯（每 24 格一盏 ≈ 2,800 盏）；粒子稀疏（每 12 单位一个）或直接不要；' +
      '定期 kill @e[type=!player] 并设 doMobSpawning false。修完 4.5ms/tick',
    detect: '/tick query 看 Average time per tick；execute if entity @e[type=!player] 数实体',
  },
  {
    id: 'client-particles',
    area: '性能',
    title: '粒子数量是【客户端】卡顿主因',
    symptom: '服务器负载不高，但画面很卡',
    cause: '每个 emit 指令的 count=20 × 8,440 个发射器 = 一趟 16.8 万颗粒子，客户端渲染不过来',
    fix: 'count 降到 2~3，或干脆不放粒子；灯只做方块亮灭（几乎不耗性能）',
    detect: 'data get block <粒子块> Command 看 count 参数；乘上发射器数量',
  },
  {
    id: 'forceload',
    area: '工具',
    title: '强加载的两个坑：单条 256 区块上限 / 强杀服务端会丢标记',
    symptom: 'setblock 报 "That position is not loaded"；所有验证变成假失败',
    cause:
      '① /forceload add 单条最多 256 区块，范围大了报 "Too many chunks in the specified area"；' +
      '② 用 -Force 强杀服务端时未保存的 forceload 标记会丢',
    fix: '分段加（如每段 320 格宽 × 130 格深 = 189 区块）；服务端重启或强杀后【必须重新加】并等区块加载完',
    detect: 'forceload query 数数量；execute if block <已知方块> minecraft:air 若回 "not loaded" 就是没加载',
  },
  {
    id: 'capacity',
    area: '时序',
    title: '每轨每刻最多 3 个音符盒（顶+两侧）',
    symptom: '和弦/密集段落丢音',
    cause: '一个载体方块只能让上方+左右共 3 个音符盒发声（第 4 格被粒子块占）',
    fix: '加轨分散；把"同音符不同音色"的齐奏层分到不同轨组（那本来就不是冗余，是配器厚度）',
    detect: '统计每 (轨,单位) 的音符数，超出即会丢',
  },
  {
    id: 'verify-methods',
    area: '工具',
    title: '验证方法本身容易错（血泪）',
    symptom: '假报警、误判"修好了"或"坏了"',
    cause:
      '① 音符盒不是方块实体 → data get block 查不到（要用 execute if block ... note_block[note=N]）；' +
      '② 按钮脉冲只持续约 0.5 秒 → 掐时间读 powered 必然误判（要读粒子块的 LastExecution，它永久记录）；' +
      '③ 中继器 facing=X 表示【输入来自 X 边】，不是朝 X 输出；' +
      '④ 探针 x 的奇偶/各轨 dy 不同，用错坐标就会得到"无数据"并误判',
    fix: '优先用生成器自带的检查（它知道正确坐标）；每个探针都在代码里注明坐标来源',
    detect: '——',
  },
]

/** 制作流程的固定顺序（少一步就会出问题）；括注是对应的工具 */
export const PIPELINE = [
  '1. 分析 MIDI：速度图 / 十六分网格 / 相位偏移 / 每轨音色(program)与音域（rm_analyze，待实现）',
  '2. 定单位时长 U，并让 tick rate = 2/U（1 单位 = 1 红石刻 = 2 游戏刻 = 2 格）',
  '3. 按【乐器】分组设计轨：一个乐器可能要 3~5 条轨覆盖音域（窗口不重叠），每条采样录在自己窗口中心',
  '4. 渲染采样 → 起音对齐（RMS 50% 点）→ 自验证 ≤3ms（rm_render）',
  '5. 写数据包：乐器定义(sound_event 用原版事件) + 方块标签(避开 mod 内置标签)（rm_build 一并写出）',
  '6. 写资源包：覆盖那些原版事件 → 自己的 ogg（attenuation_distance 设 48）（rm_pack，待实现）',
  '7. 生成器出链条+载体+音符盒 → 打包成 mcfunction（每片 8000 条）（rm_build）',
  '8. 清场 → 建造 → 抽头补丁 → 特效（稀疏！）→ 验证（起振/音高/时序）（rm_build + rm_verify/rm_fx，后两者待实现）',
  '9. 保持强加载；定期清实体；看 tick query',
]
