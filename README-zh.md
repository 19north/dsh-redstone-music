# dsh-redstone-music

由 [`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide) 脚手架生成，
并补齐了一整套可用的 Minecraft 红石音乐工具链的 DeepSeek Harness（DSH）插件。

## Compatibility

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | 全部（纯 ESM；只有 SoundFont 渲染用可选依赖 `js-synthesizer`） |

## What it does

把"做一条 Minecraft 红石音乐带子"固化进四个工具，任何会话都不必再从零摸一遍：

| 工具 | 作用 |
|---|---|
| `redstone_music_pitfalls` | 查 12 条硬教训（症状 → 根因 → 修法 → 怎么检测） |
| `redstone_music_pipeline` | 输出固定 9 步流程 |
| `rm_render` | 从 SoundFont 渲染乐器采样 → 用**同一条规则**对齐起音（5ms 滑动 RMS 的 50% 处裁切 + 2ms 淡入）→ 写盘后重新测量并断言 ≤ `maxOnsetMs` |
| `rm_build` | 谱面 + 轨表 → 数据包（每片 ≤8000 条命令的 mcfunction + `schedule` 接力 + Glissando 乐器定义），可选经 RCON 部署并开建 |

三条来自真实事故的规则直接写进了代码，而不是只写在文档里：

- 乐器定义的 `sound_event` **必须**是原版事件，否则直接报错 —— 自定义命名空间只存在于客户端资源包，
  服务端加载整张乐器表会失败，所有音符盒回退 `harp`（"全是错音"）；
- 红石非导体、或落在 Glissando 内置 `minecraft:note_block_instruments/*` 标签（612 种方块）里的载体方块
  一律拒绝 —— 它们会被抢走音色，把钢琴谱变成鼓声；
- 各轨总线延迟一律补偿（`xStart = originX + 2·delay`，内容按 `x = originX + 2u + 1` 摆），
  保证每条轨的同一个音乐单位在同一刻发声。

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-redstone-music-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-redstone-music'
```

## Minimal example

`rm_build` 要一份谱面 + 一张轨表。`examples/minimal/project.json` 就是一份 5 个音、3 条轨的最小示例，
并且被测试钉住（每次 `pnpm test` 都会跑它，示例不会腐烂）：

```jsonc
{
  "song": { "bpm": 120, "start": 0, "notes": [
    { "t": 0, "midi": 46, "track": 2 },
    { "t": 0.25, "midi": 60, "track": 2 },
    { "t": 0.5, "midi": 40, "track": 2 },
    { "t": 0, "midi": 36, "track": 1 },
    { "t": 0.5, "midi": 35, "track": 1 }
  ] },
  "lanes": [
    { "label": "piano-low", "instrument": "piano_low", "block": "minecraft:moss_block",
      "side": "N", "pos": 1, "window": [40, 52], "sample": 46, "tracks": [2] },
    { "label": "piano-high", "instrument": "piano_high", "block": "minecraft:mud",
      "side": "N", "pos": 2, "window": [53, 65], "sample": 59, "tracks": [2] },
    { "label": "kick", "instrument": "kick", "block": "minecraft:netherite_block",
      "side": "S", "pos": 1, "window": null, "tracks": [1], "keys": [35, 36], "tune": 12 }
  ],
  "geometry": { "originX": 250, "baseY": 180, "walkMid": 520, "laneGap": 5, "tailUnits": 4 }
}
```

先编译成数据包，再在世界里开建：

```jsonc
// 1) pack —— 写出 <outputDir>/{pack.mcmeta, meta.json, data/rm_build/function/build*.mcfunction}
rm_build { "action": "pack", "namespace": "rm_build",
           "outputDir": "<服务端目录>/world/datapacks/rm_build",
           "projectFile": "…/examples/minimal/project.json" }

// 2) deploy —— 设 tick rate → reload → 启用数据包 → 分段强加载 → /function rm_build:build1
rm_build { "action": "deploy", "namespace": "rm_build",
           "projectFile": "…/examples/minimal/project.json" }
```

采样是上一步，由 `rm_render` 产出 —— 所有槽位共用同一条起音规则：

```jsonc
rm_render { "action": "render", "outDir": "…/samples", "namespace": "rm", "soundFont": "…/GeneralUser.sf2",
  "slots": [
    { "name": "piano_low", "kind": "pitched", "program": 0, "window": [40, 52], "sample": 46, "block": "minecraft:moss_block" },
    { "name": "kick", "kind": "drum", "key": 36, "block": "minecraft:netherite_block" }
  ] }
```

手上没有 SoundFont 也行：用 `action: "align"` 配 `sourceDir`，只对齐你已经渲好的 wav。

## Configuration

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用红石音乐工具 |
| `serverDir` | string | `""` | Minecraft 服务端目录；默认数据包落点的基准。留空则 `rm_build` 必须给 `outputDir` |
| `rconHost` | string | `127.0.0.1` | RCON 主机 |
| `rconPort` | number | `25575` | RCON 端口 |
| `rconPassword` | string | `""` | RCON 密码；留空则 `rm_build` 只能 pack、不能 deploy |
| `datapackDir` | string | `world/datapacks` | 数据包目录（相对 `serverDir`） |
| `clientPackDir` | string | `""` | 客户端 `resourcepacks` 目录（留空则不自动投递） |
| `soundFont` | string | `""` | `rm_render` 的 render 模式用的 SoundFont (.sf2) 路径 |
| `sampleDir` | string | `""` | 默认采样输出目录 |
| `sampleRate` | number | `44100` | 采样率 Hz |
| `maxOnsetMs` | number | `3` | 对齐后允许的最大起音 ms |

配置由 `src/config.ts` 中的 Schemastery `Config` 模式校验；没有任何硬编码可调参数。

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-redstone-music
```

本插件只往你指定的位置写东西：采样写进 `outDir`，数据包写进 `outputDir`
（默认 `<serverDir>/<datapackDir>/<namespace>`），此外只会执行你明确要求的 RCON 命令。
磁盘上其他位置一概不碰，所以卸载后这些文件会留着——不想要就自己删掉。

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node scripts/verify-e2e.mjs    # 真实谱面 + 真实 SoundFont 的端到端校验
```

`scripts/verify-e2e.mjs` 会加载构建产物 `lib/index.js`，渲染三个真实的 GeneralUser 采样，
并用真实谱面 + 参考工程的 20 轨轨表重跑一遍建造。它把结果与当年在世界上实测到的数字逐条对照：
单位 94.94ms、tick rate 21.066、范围 x 250..3628、7195 个音里丢 15 个、命令总量与 143,712 条相差 1% 以内。

## License

[Apache License 2.0](LICENSE) © 2026 dsh-redstone-music contributors.
