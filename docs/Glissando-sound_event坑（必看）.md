# ★ Glissando 最关键的坑：sound_event 必须是【服务端认得的事件】

> 2026-10-02 找到并修复。这个坑导致《Beethoven Virus》**从头到尾"全是错音"**，
> 排查花了一整晚（把编排、红石时序、采样起音全查了一遍，全是好的 ✗，最后才发现是这里）。

---

## 症状

- 音符盒**会响**，但**音色和音高全不对** —— 用户描述"全是错音""很乱""同一时间的两个钢琴有时差"
- 世界数据完全正确 ✓（note 值逐音验证差值全 +0 ✓）
- 红石时序完全正确 ✓（各轨 LastExecution 同刻 ✓）
- 采样起音也对齐了 ✓（全部 ≤10ms ✓）
- **但听起来就是不对** ✗

## 真凶

服务端启动日志里躺着这几行（**一定要先看这里** ✗）：

```
> Errors in registry glissando:note_block_instrument:
java.lang.IllegalStateException: Failed to parse virus:glissando/note_block_instrument/brass.json
Caused by: Failed to get element ResourceKey[minecraft:sound_event / virus:brass]
Caused by: Failed to get element ResourceKey[minecraft:sound_event / virus:vibraslap]
java.lang.IllegalStateException: Failed to load registries due to above errors
```

**原因**：
- Glissando 的乐器表是**数据包注册表** ✓，里面的 `sound_event` 字段会被**服务端**解析 ✗
- 我写的是 `"sound_event": "virus:piano_low"` ✗ —— **自定义命名空间**
- 但 `virus:*` 这些音效事件**只存在于【客户端资源包】的 `sounds.json`** ✗
- **服务端的 `minecraft:sound_event` 注册表里没有它们** ✗ → **解析失败** ✗
- → **整张乐器表加载失败** ✗✗ → **所有音符盒回退到原版默认音色（harp）** ✗✗✗
- → **一本钢琴谱被 harp 音色演奏** ✗ → **音高全错** ✓✓✓

**为什么极具迷惑性**：
1. 音符盒还是响的 ✗（回退音色 ✓）→ 不像"配置坏了"
2. 我最早的**测试**用的是 `minecraft:block.note_block.harp` ✓ **—— 原版事件 → 测试通过 ✓**
   换成自己的命名空间时就坏了 ✗ —— **测试通过和实际使用不是一回事** ✗✗
3. 报错只在**服务端启动日志**里 ✗，`/reload` 时不一定刷出来 ✓

## 正确做法

**乐器的 `sound_event` 必须写【原版音效事件】** ✓，然后再用资源包把这些事件**覆盖**成自己的采样 ✓✓：

```json
// data/virus/glissando/note_block_instrument/piano_low.json   ✓ 正确
{
  "blocks": "#virus:note_block_instruments/piano_low",
  "description": { "text": "大钢琴·低" },
  "sound_event": "minecraft:block.note_block.harp"      ← ★ 原版事件 ✓
}
```

```json
// 资源包 assets/minecraft/sounds.json   ✓ 把它覆盖成我们的 ogg
{
  "block.note_block.harp": {
    "sounds": [{ "name": "virus2/piano_low", "stream": false, "attenuation_distance": 48 }]
  }
}
```

**可用的事件数量**：16 个 `block.note_block.*` ✓（反正我们不用原版音色 ✓）
+ 任意冷门原版事件 ✓（实体音效/方块音效都行，几百个可选 ✓）
→ **音色数量依然不受限** ✓✓

**要覆盖的事件清单**（28 个，见 `sound/event-map.json`）：
```
block.note_block.{harp,basedrum,snare,hat,bass,flute,bell,guitar,chime,
                  xylophone,iron_xylophone,cow_bell,didgeridoo,bit,banjo,pling}
entity.llama.angry / fox.screech / panda.sneeze / axolotl.idle_air / dolphin.play /
parrot.imitate.creeper / bat.takeoff / cat.purreow / rabbit.attack
block.conduit.activate / respawn_anchor.set_spawn
item.trident.throw
```

## 检查清单（以后配 Glissando 必做）

1. **服务端启动日志里搜** `Errors in registry` / `Failed to get element` ✓ —— **有就是没配好** ✗
2. `datapack list` 确认数据包已启用 ✓
3. 标签断言：`execute if block <x> <y> <z> #<ns>:note_block_instruments/<乐器>` 必须 passed ✓
4. **别用自定义命名空间的 sound_event** ✗ —— 服务端不认 ✓

## 附：这次一起发现并修掉的其他真问题

| 问题 | 症状 | 修法 |
|---|---|---|
| **服务器被压垮** | 148ms/tick → 波前跑 1/3 速度 → "忽快忽慢" | 红石灯 67400→5620 盏、粒子 67400→8440 个、清 2 万实体 → **4.5ms/tick** |
| **中继器全弹掉** | 链条推进一格就断 | fx 清场时把中继器**支撑层清成空气** ✗ → 改清成白混凝土 ✓ |
| **粒子/灯不触发** | 指令方块永不执行 | 放在**偶数 x（中继器列）** ✗ 中继器不向下供电 → 改到**奇数 x（载体列）** ✓ |
| **采样起音不齐** | 钢琴 4 轨峰值差 12~61ms | 统一裁到 **5ms 滑动 RMS 的 50% 点** ✓ → 全部 ≤10ms |
| **forceload 丢失** | 所有验证假失败（"position is not loaded"） | `-Force` 杀服务端会丢未保存的 forceload ✗ → 重启后必须**重新加** ✓ |
