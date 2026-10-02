# 红石建造提速 + Glissando 突破音色上限（2026-10-01 实战总结）

> 本轮把《Beethoven Virus》从"13 轨 / 丢 1714 个音 / 建造 40 分钟"重做成
> **20 轨 / 丢 15 个音 / 完全按原曲音色 / 建造 4 分钟**。下面是可复用的做法与坑。

---

## 一、★ 建造提速 9 倍：mcfunction 批量执行（最重要）

**问题**：生成器逐格发 `setblock` → 76,000 次 RCON 往返 ✗ 实测只有 **5.4 格/秒** → 40 分钟。

**解法**：把命令**收集起来写成 `.mcfunction`**，一次 `/function` 在**一个 tick 内**执行几千条 ✓

```
旧：76,000 次 RCON（每次一个来回）           → 40 分钟 ✗
新：143,712 条命令 / 18 个 mcfunction        → 260 秒 ✓✓（9 倍）
    tick 峰值 46ms，没有触发看门狗 ✓
```

**关键参数与限制**：

| 项 | 值 | 说明 |
|---|---|---|
| `maxCommandChainLength` | **65536** | 每个**游戏刻**能执行的命令上限 ✓ 所以每片别超过它 |
| 建议每片 | **8000 条** | 加上片间 `schedule function <下一片> 2t` → 既快又不卡死 ✓ |
| 单条 `/fill` 上限 | **32768 格** | 超出要分段 |
| 单条 `/forceload add` 上限 | **256 区块** | ★ 我踩了两次 ✗ 必须分段（如每段 320 格宽 × 130 格深 = 189 区块 ✓） |
| 服务端看门狗 | 单刻 60 秒 | 8000 条 setblock 约 1~3 秒 ✓ 安全 |

**生成器的改法（最小侵入）**：把真实 RCON 换成一个收集器 ✓ 收尾时写成文件 ✓

```js
// ① 替换 const rcon = await openRcon(...)
const FN = [];
const rcon = {
  async exec(c) { FN.push(String(c)); return ''; },
  async execMany(cmds) { for (const c of cmds) FN.push(String(c)); },
  close() {},
};
// ② 替换收尾的 rcon.close()
const FNDIR = '<world>/datapacks/<名>/data/<ns>/function';
for (let i = 0; i < FN.length; i += 8000) { /* 写 buildN.mcfunction，片尾 schedule 下一片 2t */ }
```

然后：`/reload` → `/datapack enable "file/<名>"` → `/function <ns>:build1` ✓

**同样的招式可用于一切批量操作**：铺灯、铺粒子、换方块、清场 ✓（本轮打击乐 1938 个载体方块也是这么秒完的 ✓）

---

## 二、★ Glissando：突破"音符盒最多 14 种音色"

**原版限制**：音符盒音色 = 下方方块材质 → 16 种乐器方块，其中 glowstone / glass 不是红石导体 → **最多 14 种** ✗
而原曲编制有 21 种乐器 ✗（钢琴 / 弦乐震音 / 拨奏 ×2 / 合成铜管 / 铜管 / 无品贝斯 / 定音鼓 + 15 种打击乐）

### 装什么

| Mod | 版本 | 说明 |
|---|---|---|
| **Glissando** | `1.2.2+1.21.1` | 服务端 + **客户端都要装** ✓（音色是客户端决定的） |
| **Fabric API** | `0.102.0+1.21` | 依赖 |
| **YACL** | **`3.6.2+1.21`** | ★ 必须用 **`+1.21`** 后缀那版 ✗ `+1.21.1` 的要求 Fabric API ≥0.104（1.21 没有）→ 启动直接崩 |
| （可选）Mod Menu | — | 图形化配置 |

### 数据格式（这是全部秘密）

```
data/<ns>/glissando/note_block_instrument/<名>.json     ← 乐器定义
{
  "blocks": "#<ns>:note_block_instruments/<名>",
  "description": { "text": "显示名" },
  "sound_event": "virus:piano_low"        ← ★ 任意命名空间 ✓ 由资源包提供采样
}
data/<ns>/tags/block/note_block_instruments/<名>.json   ← 哪些方块 = 这个乐器
{ "values": [ "minecraft:stone" ] }

pack.mcmeta: { "pack": { "pack_format": 48 } }          ← 1.21 的数据包版本号
```

资源包侧：
```
assets/virus/sounds.json
{ "<名>": { "sounds": [ { "name": "virus:<名>", "stream": false,
                          "attenuation_distance": 48 } ] } }   ← ★ 必须写 48！
assets/virus/sounds/<名>.ogg
```
**`attenuation_distance` 默认 16** ✗ → 30 格外的轨会直接听不见 ✗ 实测必须显式设 **48** ✓

### 带来什么

- **音色数量无上限** ✓✓（方块有几百种，命名空间随意）
- **一条轨能出多种音色** ✓✓：**逐音符更换下方载体方块**即可 ✓（本轮 15 种鼓声只用了 7 条轨 ✓）
- 音符盒、红石链、物理美感**全部保留** ✓
- 不再需要"覆盖原版 `note/*.ogg`"那套 workaround ✓（独立命名空间不冲突 ✓）

### 坑

0. **★ 大坑：载体方块绝不能落在 mod 内置的原版标签里（"全是错音"的元凶）**
   mod 自带 22 个 `minecraft:note_block_instruments/*` 标签，**覆盖了 612 种方块** ✗ ——
   而且它们把整个大类都圈走了：

   | 内置标签 | 圈走的方块（举要） |
   |---|---|
   | `basedrum` | `#base_stone_overworld` → **stone / deepslate / granite / diorite / andesite / tuff / calcite / dripstone / cobblestone / obsidian / purpur / prismarine / netherrack / quartz …** 几乎所有"石头系" ✗ |
   | `bass` | 各种 `*_planks` / `bamboo_block` / `jukebox` / `loom` / `composter` … |
   | `hat` | 玻璃系 |
   | `pling` | glowstone |
   | `guitar` | 羊毛系 |

   **我第一次就是选了 stone / deepslate / granite / andesite … 当钢琴载体** ✗ →
   全部被 `basedrum` 抢走 → **整首曲子变成鼓声** ✗ → 用户听到"全是错音" ✓✓

   **正确做法**：先程序化求出"安全方块集合"，再分配 ✓
   ```js
   // 解 jar 里的 data/minecraft/tags/block/note_block_instruments/*.json
   // 递归展开 #minecraft:* 引用 → 得到 occupied 集合
   // 再从候选里挑 !occupied.has(block) 的
   ```
   实测**安全**的 53 种（挑 28 个够用 ✓）：
   `moss_block, mud, packed_mud, sculk, sculk_catalyst, honeycomb_block, honey_block, slime_block,
    dried_kelp_block, amethyst_block, budding_amethyst, copper_block, exposed_copper, weathered_copper,
    oxidized_copper, waxed_*_copper, cut_copper, waxed_cut_copper, netherite_block, ancient_debris,
    lodestone, shroomlight, 三种 froglight, soul_soil, sponge, wet_sponge, melon, carved_pumpkin,
    jack_o_lantern, nether_wart_block, warped_wart_block, target, iron_bars, chain, lantern,
    soul_lantern, bell, cauldron, moss_carpet, vine, glow_lichen, cobweb, dragon_egg, turtle_egg,
    end_rod, lightning_rod, muddy_mangrove_roots, rooted_dirt`

   **验证方法（必做）**：放好后用标签断言检查无歧义 ✓
   ```
   execute if block <x> <y> <z> #<你的命名空间>:note_block_instruments/<乐器>   → 必须 Test passed
   execute if block <x> <y> <z> #minecraft:note_block_instruments/basedrum     → 必须 Test failed
   ```

1. **装完后音符盒没有 `instrument` 属性了** ✗：`setblock ... note_block[instrument=X,note=N]` 会报
   `Block minecraft:note_block does not have property 'instrument'` → 生成器里要**去掉 instrument=** ✓
2. 已建好的带子**不受影响** ✓（音符盒仍在，mod 按下方方块推导出的音色与原映射一致 ✓）
3. 数据包**必须 `/datapack enable`** ✗（`/reload` 不会自动启用新包 ✗ 它会停在 available 列表里 ✓）

---

## 三、服务端负载的两个杀手

1. **实体堆积** ✗（最狠）：强加载区块里的怪/掉落物会一直 tick ✓
   本轮实测 **9587 个实体** → 负载 **41.2ms/tick** ✗ 清掉后 **5.0ms/tick** ✓✓（8 倍）
   → 定期 `kill @e[type=!player]` ✓（配合 `doMobSpawning false` ✓）
2. **强加载区块数** ✗：随建造范围线性增长 → 造完**按需**保留 ✓（本轮 1107 个 ✓ 5ms ✓ 很轻）

---

## 四、其它本轮确认的事实

- **tick rate 不存档** ✗ 服务端重启后回到 20 → 每次重启都要重设 ✓（本曲 21.066）
- **VBS 启动脚本里的"端口检查"会被 TIME_WAIT 误判** ✗ → 停服后立刻重启会被静默跳过 ✓
  改用 `start-server-hidden.bat`（无端口检查 ✓ 本就是为 WMI 分离启动写的 ✓）
- **`pwsh` 工具走 PowerShell 7** ✓（写 UTF-8 不带 BOM ✓ 所以改 `options.txt` 是安全的 ✓）
- **内联 `node -e` 的引号必炸** ✗ → 一律写成脚本文件 ✓
- **按钮脉冲只有约 0.5 秒** ✓ → 验证要读**粒子指令方块的 `LastExecution`**（永久记录 ✓），
  不能掐时间读 `powered` ✗
- **音符盒不是方块实体** ✓ → `data get block` 查不到 ✓ 要用 `execute if block ... note_block[note=N]` ✓
- **中继器 `facing=X` = 输入来自 X 边** ✓（不是"朝 X 输出" ✗）→ 波前向东 → 全部用 `facing=west` ✓
- **长抽头会衰减到 0** ✗（本文档前述）→ 在**每条轨抽头末端统一插一个中继器** ✓
  （所有轨都 +1 刻 ⇒ 整体平移、轨间关系不变 ✓ 实测 20 轨相位一致 ✓）
