# dsh-redstone-music

Um plugin do DeepSeek Harness (DSH) gerado com [`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide).

## Compatibility

| Superfície | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sem código nativo, sem rede) |

## What it does

Registra quatro ferramentas para produzir uma fita de música de redstone do Minecraft:

| Ferramenta | Propósito |
|---|---|
| `redstone_music_pitfalls` | Consulta as 12 lições aprendidas na prática (sintoma → causa → correção → como detectar) |
| `redstone_music_pipeline` | Imprime o fluxo fixo de 9 passos |
| `rm_render` | Renderiza amostras de instrumento a partir de um SoundFont, alinha cada ataque com **uma única** regra (corte em 50 % do RMS deslizante de 5 ms + fade de 2 ms) e mede de novo exigindo ≤ `maxOnsetMs` |
| `rm_build` | Compila música + tabela de pistas em um datapack (fragmentos `mcfunction` de ≤8000 comandos com encadeamento por `schedule` + definições de instrumento do Glissando) e, opcionalmente, implanta por RCON e inicia a construção |

O `sound_event` de cada instrumento precisa ser um evento vanilla: um namespace próprio só existe no
resource pack do cliente, então o servidor não carrega a tabela de instrumentos e todos os blocos de
nota voltam para `harp` («está tudo desafinado»). O plugin recusa em vez de apenas documentar.

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-redstone-music-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-redstone-music'
```

## Minimal example

`rm_build` precisa de uma música e de uma tabela de pistas. `examples/minimal/project.json` é um
exemplo mínimo de cinco notas e três pistas que a suíte de testes mantém vivo (roda em cada `pnpm test`):

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

Compile em um datapack e depois construa no mundo:

```jsonc
// 1) pack — grava <outputDir>/{pack.mcmeta, meta.json, data/rm_build/function/build*.mcfunction}
rm_build { "action": "pack", "namespace": "rm_build",
           "outputDir": "<serverDir>/world/datapacks/rm_build",
           "projectFile": "…/examples/minimal/project.json" }

// 2) deploy — tick rate → reload → datapack enable → forceload em segmentos → /function rm_build:build1
rm_build { "action": "deploy", "namespace": "rm_build",
           "projectFile": "…/examples/minimal/project.json" }
```

As amostras vêm antes, e quem as produz é o `rm_render` — uma única regra de ataque para todos os slots:

```jsonc
rm_render { "action": "render", "outDir": "…/samples", "namespace": "rm", "soundFont": "…/GeneralUser.sf2",
  "slots": [
    { "name": "piano_low", "kind": "pitched", "program": 0, "window": [40, 52], "sample": 46, "block": "minecraft:moss_block" },
    { "name": "kick", "kind": "drum", "key": 36, "block": "minecraft:netherite_block" } ] }
```

Sem SoundFont? `action: "align"` com `sourceDir` alinha wavs que você já renderizou.

## Configuration

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `enabled` | boolean | `true` | Ativa as ferramentas de música de redstone |
| `serverDir` | string | `""` | Diretório do servidor Minecraft; base do local padrão do datapack. Vazio = `rm_build` exige `outputDir` |
| `rconHost` | string | `127.0.0.1` | Host RCON |
| `rconPort` | number | `25575` | Porta RCON |
| `rconPassword` | string | `""` | Senha RCON; vazia = `rm_build` só empacota |
| `datapackDir` | string | `world/datapacks` | Diretório de datapacks, relativo a `serverDir` |
| `clientPackDir` | string | `""` | Diretório `resourcepacks` do cliente (vazio = não entregar) |
| `soundFont` | string | `""` | Caminho do SoundFont (.sf2) usado pelo modo render do `rm_render` |
| `sampleDir` | string | `""` | Diretório de saída de amostras padrão |
| `sampleRate` | number | `44100` | Taxa de amostragem (Hz) |
| `maxOnsetMs` | number | `3` | Ataque máximo aceito após o alinhamento |

A configuração é validada pelo schema Schemastery `Config` em `src/config.ts`; nenhum ajuste fica fixo no código.

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-redstone-music
```

O plugin só grava onde você aponta: amostras em `outDir`, datapacks em `outputDir`
(padrão `<serverDir>/<datapackDir>/<namespace>`), além dos comandos RCON que você pedir explicitamente.
Não toca em mais nada no disco, então ao desinstalar esses arquivos continuam lá — apague-os se não quiser.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node scripts/verify-e2e.mjs    # verificação ponta a ponta com música e SoundFont reais
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-redstone-music contributors.
