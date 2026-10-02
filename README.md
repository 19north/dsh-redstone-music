# dsh-redstone-music

A DeepSeek Harness (DSH) plugin scaffolded by [`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide),
then filled in with a working Minecraft redstone-music pipeline.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | All (plain ESM; optional `js-synthesizer` only for SoundFont rendering) |

## What it does

Turns "make a Minecraft redstone music strip" into four tools, so any session can run the
whole pipeline instead of re-learning it:

| Tool | Purpose |
|---|---|
| `redstone_music_pitfalls` | Query the 12 hard-won pitfalls (symptom → cause → fix → how to detect) |
| `redstone_music_pipeline` | Print the fixed 9-step pipeline |
| `rm_render` | Render instrument samples from a SoundFont, align every onset with **one** rule (5 ms sliding-RMS 50 % cut + 2 ms fade), then re-measure and assert ≤ `maxOnsetMs` |
| `rm_build` | Compile song + lane table into a datapack (`mcfunction` shards of ≤8000 commands with `schedule` chaining + Glissando instrument definitions), optionally deploy it over RCON and start the build |

Three rules from real incidents are enforced in code rather than documented and forgotten:

- Glissando instrument definitions are **rejected** unless `sound_event` is a vanilla event —
  a custom namespace only exists in the client resource pack, so the server fails to load the
  whole instrument table and every note block falls back to `harp` ("everything is a wrong note").
- Carrier blocks that are non-conductive, or that sit inside Glissando's built-in
  `minecraft:note_block_instruments/*` tags (612 blocks), are **rejected** — those get their timbre
  stolen and turn a piano score into drums.
- Per-track bus delay is compensated (`xStart = originX + 2·delay`, content at `x = originX + 2u + 1`),
  so every track plays the same unit at the same tick.

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-redstone-music-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-redstone-music'
```

## Minimal example

`rm_build` takes a song plus a lane table. `examples/minimal/project.json` is a five-note,
three-lane one that the test suite keeps working (it runs on every `pnpm test`):

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

Compile it into a datapack, then build it in the world:

```jsonc
// 1) pack — writes <outputDir>/{pack.mcmeta, meta.json, data/rm_build/function/build*.mcfunction}
rm_build { "action": "pack", "namespace": "rm_build",
           "outputDir": "<serverDir>/world/datapacks/rm_build",
           "projectFile": "…/examples/minimal/project.json" }

// 2) deploy — tick rate → reload → datapack enable → segmented forceload → /function rm_build:build1
rm_build { "action": "deploy", "namespace": "rm_build",
           "projectFile": "…/examples/minimal/project.json" }
```

Samples come first, and `rm_render` is what produces them — one onset rule for every slot:

```jsonc
rm_render { "action": "render", "outDir": "…/samples", "namespace": "rm", "soundFont": "…/GeneralUser.sf2",
  "slots": [
    { "name": "piano_low", "kind": "pitched", "program": 0, "window": [40, 52], "sample": 46, "block": "minecraft:moss_block" },
    { "name": "kick", "kind": "drum", "key": 36, "block": "minecraft:netherite_block" }
  ] }
```

No SoundFont on hand? `action: "align"` with a `sourceDir` aligns wavs you already rendered instead.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable the redstone-music tools |
| `serverDir` | string | `""` | Minecraft server directory; base for the default datapack location. Empty means `rm_build` needs an explicit `outputDir` |
| `rconHost` | string | `127.0.0.1` | RCON host |
| `rconPort` | number | `25575` | RCON port |
| `rconPassword` | string | `""` | RCON password; empty means `rm_build` can only pack |
| `datapackDir` | string | `world/datapacks` | Datapack directory, relative to `serverDir` |
| `clientPackDir` | string | `""` | Client `resourcepacks` directory (empty = do not deliver) |
| `soundFont` | string | `""` | SoundFont (.sf2) path used by `rm_render`'s render mode |
| `sampleDir` | string | `""` | Default sample output directory |
| `sampleRate` | number | `44100` | Sample rate (Hz) |
| `maxOnsetMs` | number | `3` | Maximum accepted onset after alignment |

Configuration is validated by the Schemastery `Config` schema in `src/config.ts`; no tunable is hardcoded.

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-redstone-music
```

The plugin only writes where you point it: sample wavs into `outDir`, datapacks into `outputDir`
(default `<serverDir>/<datapackDir>/<namespace>`), plus whatever RCON commands you explicitly asked
it to run. Nothing else on disk is touched, so removing the plugin leaves those files behind —
delete them yourself if you don't want them.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node scripts/verify-e2e.mjs    # real song + real SoundFont end-to-end check
```

`scripts/verify-e2e.mjs` loads the built `lib/index.js`, renders three real GeneralUser samples,
and rebuilds the reference project's 20-lane arrangement from the real score. It cross-checks the
numbers against the ones measured in the field: 94.94 ms units, tick rate 21.066, x 250..3628,
7195 notes with 15 dropped, and a total command count within 1 % of 143,712.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-redstone-music contributors.
