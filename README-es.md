# dsh-redstone-music

Un plugin de DeepSeek Harness (DSH) generado con [`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide).

## Compatibility

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sin código nativo, sin red) |

## What it does

Registra cuatro herramientas para producir una cinta de música de redstone de Minecraft:

| Herramienta | Propósito |
|---|---|
| `redstone_music_pitfalls` | Consulta las 12 lecciones aprendidas a golpes (síntoma → causa → arreglo → cómo detectarlo) |
| `redstone_music_pipeline` | Imprime el flujo fijo de 9 pasos |
| `rm_render` | Renderiza muestras de instrumento desde un SoundFont, alinea cada ataque con **una sola** regla (corte en el 50 % del RMS deslizante de 5 ms + fundido de 2 ms) y vuelve a medir exigiendo ≤ `maxOnsetMs` |
| `rm_build` | Compila canción + tabla de pistas en un datapack (fragmentos `mcfunction` de ≤8000 comandos con encadenado por `schedule` + definiciones de instrumento de Glissando) y, opcionalmente, lo despliega por RCON e inicia la construcción |

El `sound_event` de cada instrumento debe ser un evento vanilla: un espacio de nombres propio solo
existe en el resource pack del cliente, así que el servidor no carga la tabla de instrumentos y todos
los bloques de nota vuelven a `harp` («todo suena mal»). El plugin lo rechaza en vez de documentarlo.

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-redstone-music-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-redstone-music'
```

## Minimal example

`rm_build` necesita una canción y una tabla de pistas. `examples/minimal/project.json` es un ejemplo
mínimo de cinco notas y tres pistas que la suite de pruebas mantiene vivo (se ejecuta en cada `pnpm test`):

```jsonc
{
  "song": { "bpm": 120, "start": 0, "notes": [
    { "t": 0, "midi": 46, "track": 2 }, { "t": 0.25, "midi": 60, "track": 2 }, { "t": 0.5, "midi": 40, "track": 2 },
    { "t": 0, "midi": 36, "track": 1 }, { "t": 0.5, "midi": 35, "track": 1 } ] },
  "lanes": [
    { "label": "piano-low", "instrument": "piano_low", "block": "minecraft:moss_block",
      "side": "N", "pos": 1, "window": [40, 52], "sample": 46, "tracks": [2] },
    { "label": "piano-high", "instrument": "piano_high", "block": "minecraft:mud",
      "side": "N", "pos": 2, "window": [53, 65], "sample": 59, "tracks": [2] },
    { "label": "kick", "instrument": "kick", "block": "minecraft:netherite_block",
      "side": "S", "pos": 1, "window": null, "tracks": [1], "keys": [35, 36], "tune": 12 } ],
  "geometry": { "originX": 250, "baseY": 180, "walkMid": 520, "laneGap": 5, "tailUnits": 4 }
}
```

Compílalo en un datapack y luego constrúyelo en el mundo:

```jsonc
// 1) pack — escribe <outputDir>/{pack.mcmeta, meta.json, data/rm_build/function/build*.mcfunction}
rm_build { "action": "pack", "namespace": "rm_build",
           "outputDir": "<serverDir>/world/datapacks/rm_build",
           "projectFile": "…/examples/minimal/project.json" }

// 2) deploy — tick rate → reload → datapack enable → forceload por segmentos → /function rm_build:build1
rm_build { "action": "deploy", "namespace": "rm_build",
           "projectFile": "…/examples/minimal/project.json" }
```

Las muestras van primero, y `rm_render` es quien las produce — una sola regla de ataque para todos los slots:

```jsonc
rm_render { "action": "render", "outDir": "…/samples", "namespace": "rm", "soundFont": "…/GeneralUser.sf2",
  "slots": [
    { "name": "piano_low", "kind": "pitched", "program": 0, "window": [40, 52], "sample": 46, "block": "minecraft:moss_block" },
    { "name": "kick", "kind": "drum", "key": 36, "block": "minecraft:netherite_block" } ] }
```

¿Sin SoundFont? `action: "align"` con `sourceDir` alinea los wav que ya hayas renderizado.

## Configuration

| Clave | Tipo | Valor por defecto | Descripción |
|---|---|---|---|
| `enabled` | boolean | `true` | Activa las herramientas de música de redstone |
| `serverDir` | string | `""` | Directorio del servidor de Minecraft; base de la ubicación por defecto del datapack. Vacío = `rm_build` exige `outputDir` |
| `rconHost` | string | `127.0.0.1` | Host RCON |
| `rconPort` | number | `25575` | Puerto RCON |
| `rconPassword` | string | `""` | Contraseña RCON; vacía = `rm_build` solo puede empaquetar |
| `datapackDir` | string | `world/datapacks` | Directorio de datapacks, relativo a `serverDir` |
| `clientPackDir` | string | `""` | Directorio `resourcepacks` del cliente (vacío = no entregar) |
| `soundFont` | string | `""` | Ruta al SoundFont (.sf2) que usa el modo render de `rm_render` |
| `sampleDir` | string | `""` | Directorio de salida de muestras por defecto |
| `sampleRate` | number | `44100` | Frecuencia de muestreo (Hz) |
| `maxOnsetMs` | number | `3` | Ataque máximo aceptado tras la alineación |

La configuración se valida con el esquema Schemastery `Config` de `src/config.ts`; ningún ajuste está codificado de forma fija.

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-redstone-music
```

El plugin solo escribe donde tú lo indicas: muestras en `outDir`, datapacks en `outputDir`
(por defecto `<serverDir>/<datapackDir>/<namespace>`), más los comandos RCON que pidas explícitamente.
No toca nada más del disco, así que al desinstalar esos archivos quedan ahí — bórralos tú si no los quieres.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node scripts/verify-e2e.mjs    # verificación de extremo a extremo con canción y SoundFont reales
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-redstone-music contributors.
