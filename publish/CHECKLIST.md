# 上架清单（awesome-dsh-plugin → dsh-market）

> 收录机制：**市场没有"上传"入口**，收录 = 向精选列表提 PR；列表发布成 npm 包
> `dsh-plugin-catalog`，市场每次请求实时拉取。权威依据：上游 `contributing.md`（2026-10-02 读取）。
>
> **当前状态：owner 已设置为 `19north`**（`package.json` 与提交条目都是它，本地 git 仓库已 init + commit，
> 远端 `origin` 已指向 `https://github.com/19north/dsh-redstone-music.git`）。
> 本文里出现的 `<GITHUB_OWNER>` 只是给读者看的占位写法，不影响任何文件。

---

## 0. 先跑自检

```powershell
cd 'F:\desktop\project 2\dsh-redstone-music'
pnpm install
pnpm run build
pnpm run check:listing     # 本地能查的上架条件（owner 占位符会在这里报错，属预期）
pnpm test                  # 46 项
pnpm run verify:e2e        # 真实谱面 + 真实 SoundFont 的端到端
```

## 1. 唯一一位输入：GitHub 用户名

```powershell
node scripts/set-owner.mjs <你的用户名>
```

它改两处（必须一致，否则市场不会把 npm 包和仓库关联起来）：

- `package.json` 的 `repository` / `homepage` / `bugs`；
- `publish/awesome-dsh-plugin/data/plugins/<用户名>__dsh-redstone-music.yml`（连文件名一起改）。

改完 `pnpm run check:listing` 应该全绿。可逆：再跑一次换个名字即可。

## 2. 建公开仓库并推送

`set-owner.mjs` 会把下面这几条按你的用户名填好并打印出来，照抄即可：

```powershell
cd 'F:\desktop\project 2\dsh-redstone-music'
git init -b main
git add -A
git commit -m "feat: redstone-music toolkit (rm_render / rm_build)"
git remote add origin https://github.com/<GITHUB_OWNER>/dsh-redstone-music.git
git push -u origin main
```

仓库建好后在 GitHub 上加 topic：**`dsh-plugin`**（上游明确要求）。

> ⏳ **仓库必须创建满 1 天**，CI 会自动查这一条。所以顺序是：**先把仓库建好推上去，隔天再提 PR。**
> 这不是质量问题，只是为了过滤「提 PR 前几分钟才建的仓库」。

## 3. 发布 npm（可选，但强烈建议）

不发 npm 也能收录（走 `github:` 源码安装），但用户安装时要批准构建脚本
（我们的 `prepare` 会跑 tsdown），而且市场里没有下载量数字。

```powershell
npm login                       # npm 账号与 GitHub 是两套注册，没有就要单独注册
npm publish --access public     # dsh-redstone-music 这个名字在 npm 上未被占用
```

两条硬规则：

- 包的 `repository` 字段必须指回被收录的那个仓库（`set-owner.mjs` 已写好）；
- **条目 yml 里不能手写 `npm:` 字段**，映射由上游从 registry 自动采集，手写会被校验拒绝。

## 4. 提 PR

只加一个文件——内容已备好，就在本目录：

```
publish/awesome-dsh-plugin/data/plugins/<GITHUB_OWNER>__dsh-redstone-music.yml
   →  上游仓库的  data/plugins/<GITHUB_OWNER>__dsh-redstone-music.yml
```

先 fork `awesome-dsh-plugin/awesome-dsh-plugin`，在你的 fork 里把那个文件原样拷进 `data/plugins/`，
提交、推分支，然后开 PR。要点：

- **不要手工编辑上游的 README.md / README-zh.md**——它们由 `data/plugins/*.yml` 生成；
- 一个 PR 最多 3 条条目；
- PR 里只动自己那一条。

CI 依次查：条目数 ≤3 → `dsh.bundle` manifest → 仓库年龄 ≥1 天 → awesome-lint 与站点构建。
CI 过了还会有人读源码核对描述（描述夸大是唯一会被打回的原因）。

## 5. 合并之后

README/站点自动重建，条目进入 npm 包 `dsh-plugin-catalog`，市场里随即出现，不需要再做任何事。
之后改描述推自己的仓库即可；想控制市场详情页的截图，按上游约定在仓库根放 `screenshots.json`。

---

## 已知会在市场卡片上披露的能力标签

上游会对安装物做静态扫描并展示 `capabilities`（是披露，不是拒绝）。本插件预期命中：

| 标签 | 来源 |
|---|---|
| `fs-read` | 读谱面/轨表/SoundFont/采样 |
| `fs-write` | 写采样 wav、写数据包 |
| `network` | deploy 时连 RCON（TCP） |
| `credentials` | 配置项 `rconPassword` |

## 复查上游规则

上游规则会变，重新确认时读这两处（本机直连 GitHub 慢，走 jsDelivr 最快）：

- https://cdn.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/contributing.md
- https://cdn.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/README.md
