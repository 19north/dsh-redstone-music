# 插件设计与踩坑记录：rm_render / rm_build

> 2026-10-02 实现。这份文档记的是**本插件自己的**工程决策与坑，
> 红石音乐本身的坑（音色/时序/负载）在 `knowledge.ts` 与同目录另四份文档里。

---

## 一、工具划分

| 工具 | 对应 PIPELINE | 关键契约 |
|---|---|---|
| `rm_render` | 第 4 步 | 所有采样用**同一条**裁切规则（5ms 滑动 RMS 50% 处裁切 + 2ms 淡入 + 指数衰减），写盘后**读回来重测**并断言 ≤ `maxOnsetMs` |
| `rm_build` | 第 5/7/8 步 | 谱面 + 轨表 → 数据包（分片 mcfunction + Glissando 乐器定义 + meta.json）；`action=deploy` 才碰 RCON |

`rm_render` 两种模式：`render`（从 .sf2 渲染，用可选依赖 `js-synthesizer`）、`align`（只对齐已有 wav）。
没装 fluidsynth 也能用 align 模式，这是刻意的降级路径。

`rm_build` 只碰世界的时机是 deploy；pack 模式纯粹写文件，可以离线跑、反复跑。

---

## 二、模块结构（全部纯函数优先，便于单测）

```
src/music/wav.ts             WAV 编解码 + RMS 包络 + 起音指标 + 对齐算法（无依赖）
src/music/sample-render.ts   槽表校验 + 渲染/对齐流水线 + js-synthesizer 惰性加载
src/music/lane-layout.ts     轨摊平坐标、总线阶梯、刷新中继器、各轨延迟补偿
src/music/score.ts           谱面 → 轨/槽位分配（每轨每刻 ≤3 个音符盒、移调最小、抽稀、镜像）
src/music/commands.ts        命令生成（清场/铺底/元件）、mcfunction 分片、强加载分段
src/music/datapack.ts        数据包写盘（含乐器定义 + 方块标签；强制原版 sound_event）
src/music/build.ts           串起来：planBuild() + 载体方块/乐器校验
src/music/rcon.ts            极简 RCON 客户端（登录 → 串行队列 → 单条超时）
src/tool-render.ts / tool-build.ts   两个工具的 defineTool 定义与 execute
```

---

## 三、踩到的坑（都已在代码里防住）

### 1. pnpm 11 让 `pnpm run` 全灭

`esbuild` 带安装脚本，pnpm 默认拒绝执行 → `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 退出 1；
而 pnpm 在执行**任何** `pnpm run <script>` 前会先做一次依赖状态检查（内部再跑 install），
于是 build/test/typecheck 全部连带失败。

修法：**pnpm 11 不再读 `package.json` 的 `pnpm` 字段**（写了会被忽略并告警），设置要放
`pnpm-workspace.yaml`：

```yaml
allowBuilds:
  esbuild: true
```

### 2. tsdown 的产物名与 `package.json#main` 对不上

`platform: 'node'` 时 `fixedExtension` 默认为 true → 产出 `lib/index.mjs` + `index.d.mts`，
而脚手架写的 `main` 是 `lib/index.js` → 插件加载时找不到入口。
修法：tsdown 配置里 `fixedExtension: false`（产物落回 `.js` / `.d.ts`）。

### 3. dsh-tools 的 value schema DSL：`required` 是【逐属性】的

写 JSON Schema 风格的 `required: ['count','items']` 数组会在**注册工具时直接抛错**：

```
unsupported JSON schema: schema.required is not supported by the value schema DSL
```

正确写法是每个必填属性自己带 `required: true`：

```ts
properties: { count: { type: 'number', required: true } }
```

`items` 里的对象同样不能用数组形式（`schema.properties.items.items.required is not supported`）。

### 4. 给工具参数传 `null` 会被参数校验拦下

`window: { type: 'array' }` 收到 `window: null` → `"lanes[13].window" must be an array`。
要允许 null 得显式写 `oneOf`：

```ts
window: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }] }
```

### 5. 总线范围必须包含走道与拉杆

只按各轨 z 取 `zMin/zMax` 时，如果走道（拉杆所在 z）落在范围外，
总线阶梯算不出那一格的高度 → 直接抛「阶梯过渡来不及」（实测就是这么炸的）。
`layoutLanes` 现在把 `walkZ` 一起算进范围。

### 6. 起音指标有"5ms 窗口"自带的地板

- 真实乐器（快起音 + 指数衰减）：对齐后 **1.5~2.7ms** ✓（与文档实测 0.25~1.45ms 同档）
- **慢起音音色**（如 Tremolo Strings，250ms 才涨到位）：对齐后仍在 **3.2~5ms** ——
  不是对齐没做，而是源本身还在涨。所以 `maxOnsetMs` 超限时**照实报出来**并提示换音色，
  而不是把阈值调大糊过去（`rm_render` 的 warnings 就是这么做的）。

### 7. RCON 认证失败必须主动断开

认证失败/超时后若只 `reject` 不断开 socket，连接会一直挂着（实测让测试 teardown 卡 10 秒）。
另外 Minecraft 的认证失败回包是 **id = -1**（不是 type），判据要用 id。

---

## 四、验证方式（改完必跑）

```sh
pnpm install && pnpm run typecheck && pnpm test && pnpm run build
node scripts/verify-e2e.mjs
```

`verify-e2e.mjs` 跑的是构建产物 `lib/index.js`，用**真实谱面**（`beethoven-virus.json`）+
**真实 SoundFont**（GeneralUser）+ 参考工程的 20 轨轨表，并把结果与当年在世界里实测的数字对照：
单位 94.94ms、tick rate 21.066、x 250..3628、7195 个音丢 15 个、命令总量与 143,712 相差 <1%；
最后用一个假 RCON 服务端验 deploy 的命令顺序（tick rate → reload → datapack enable → forceload 分段 → function → datapack list）。
