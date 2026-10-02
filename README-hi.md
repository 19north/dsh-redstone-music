# dsh-redstone-music

[`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide) से बनाया गया एक DeepSeek Harness (DSH) प्लगइन।

## Compatibility

| सतह | स्थिति |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| प्लेटफ़ॉर्म | सभी (शुद्ध ESM; कोई नेटिव कोड नहीं, कोई नेटवर्क नहीं) |

## What it does

Minecraft रेडस्टोन संगीत की पट्टी बनाने के लिए चार टूल पंजीकृत करता है:

| टूल | उद्देश्य |
|---|---|
| `redstone_music_pitfalls` | 12 कड़े सबक खोजें (लक्षण → कारण → समाधान → पहचान कैसे करें) |
| `redstone_music_pipeline` | तय 9-चरणीय प्रक्रिया दिखाएँ |
| `rm_render` | SoundFont से इंस्ट्रुमेंट सैंपल रेंडर करें, हर अटैक को **एक ही** नियम से संरेखित करें (5ms स्लाइडिंग RMS का 50% पर कट + 2ms फ़ेड), फिर दोबारा मापकर ≤ `maxOnsetMs` सुनिश्चित करें |
| `rm_build` | गाना + लेन तालिका को डेटापैक में बदलें (≤8000 कमांड के `mcfunction` टुकड़े + `schedule` श्रृंखला + Glissando इंस्ट्रुमेंट परिभाषाएँ), और चाहें तो RCON से तैनात करके निर्माण शुरू करें |

हर इंस्ट्रुमेंट का `sound_event` वनीला इवेंट होना ही चाहिए: कस्टम नेमस्पेस केवल क्लाइंट रिसोर्स पैक
में होता है, इसलिए सर्वर पूरी इंस्ट्रुमेंट तालिका लोड नहीं कर पाता और सभी नोट ब्लॉक `harp` पर लौट
जाते हैं («सब ग़लत सुर»)। प्लगइन इसे दस्तावेज़ित करने के बजाय सीधे अस्वीकार करता है।

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-redstone-music-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-redstone-music'
```

## Minimal example

`rm_build` को एक गाना और एक लेन तालिका चाहिए। `examples/minimal/project.json` पाँच नोट और तीन लेन
वाला न्यूनतम उदाहरण है, जिसे टेस्ट सूट ज़िंदा रखता है (हर `pnpm test` पर चलता है):

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

इसे डेटापैक में संकलित करें, फिर दुनिया में बनाएँ:

```jsonc
// 1) pack — <outputDir>/{pack.mcmeta, meta.json, data/rm_build/function/build*.mcfunction} लिखता है
rm_build { "action": "pack", "namespace": "rm_build",
           "outputDir": "<serverDir>/world/datapacks/rm_build",
           "projectFile": "…/examples/minimal/project.json" }

// 2) deploy — tick rate → reload → datapack enable → खंडों में forceload → /function rm_build:build1
rm_build { "action": "deploy", "namespace": "rm_build",
           "projectFile": "…/examples/minimal/project.json" }
```

सैंपल पहले आते हैं, और उन्हें `rm_render` बनाता है — सभी स्लॉट के लिए एक ही अटैक नियम:

```jsonc
rm_render { "action": "render", "outDir": "…/samples", "namespace": "rm", "soundFont": "…/GeneralUser.sf2",
  "slots": [
    { "name": "piano_low", "kind": "pitched", "program": 0, "window": [40, 52], "sample": 46, "block": "minecraft:moss_block" },
    { "name": "kick", "kind": "drum", "key": 36, "block": "minecraft:netherite_block" } ] }
```

SoundFont नहीं है? `action: "align"` के साथ `sourceDir` देकर पहले से रेंडर किए wav संरेखित करें।

## Configuration

| कुंजी | प्रकार | डिफ़ॉल्ट | विवरण |
|---|---|---|---|
| `enabled` | boolean | `true` | रेडस्टोन संगीत टूल सक्षम करें |
| `serverDir` | string | `""` | Minecraft सर्वर निर्देशिका; डिफ़ॉल्ट डेटापैक स्थान का आधार। खाली = `rm_build` को `outputDir` देना होगा |
| `rconHost` | string | `127.0.0.1` | RCON होस्ट |
| `rconPort` | number | `25575` | RCON पोर्ट |
| `rconPassword` | string | `""` | RCON पासवर्ड; खाली = `rm_build` केवल पैक कर सकता है |
| `datapackDir` | string | `world/datapacks` | डेटापैक निर्देशिका (`serverDir` के सापेक्ष) |
| `clientPackDir` | string | `""` | क्लाइंट `resourcepacks` निर्देशिका (खाली = वितरित न करें) |
| `soundFont` | string | `""` | `rm_render` के render मोड में प्रयुक्त SoundFont (.sf2) का पथ |
| `sampleDir` | string | `""` | डिफ़ॉल्ट सैंपल आउटपुट निर्देशिका |
| `sampleRate` | number | `44100` | सैंपल दर (Hz) |
| `maxOnsetMs` | number | `3` | संरेखण के बाद स्वीकार्य अधिकतम अटैक |

कॉन्फ़िगरेशन `src/config.ts` में Schemastery `Config` स्कीमा से मान्य होता है; कोई भी सेटिंग हार्डकोडेड नहीं है।

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-redstone-music
```

प्लगइन केवल वहीं लिखता है जहाँ आप कहते हैं: सैंपल `outDir` में, डेटापैक `outputDir` में
(डिफ़ॉल्ट `<serverDir>/<datapackDir>/<namespace>`), और केवल वे RCON कमांड जो आप स्पष्ट रूप से कहें।
डिस्क पर और कुछ नहीं छूता, इसलिए अनइंस्टॉल करने पर वे फ़ाइलें वहीं रहती हैं — न चाहिए तो खुद हटा दें।

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node scripts/verify-e2e.mjs    # असली गाने और असली SoundFont के साथ एंड-टू-एंड जाँच
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-redstone-music contributors.
