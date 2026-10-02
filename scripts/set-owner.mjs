#!/usr/bin/env node
/**
 * set-owner.mjs —— 把占位符 OWNER 一次替换成你的 GitHub 用户名
 *
 * 要一起改三处，改漏任何一处市场都不会把 npm 包和仓库关联起来：
 *   1) package.json 的 repository / homepage / bugs（npm 靠 repository 认领仓库）
 *   2) publish/awesome-dsh-plugin/data/plugins/<owner>__dsh-redstone-music.yml（连文件名一起改）
 *   3) publish/CHECKLIST.md 里给你的那几条 push 命令
 *
 * 用法：node scripts/set-owner.mjs <github-username>
 * 幂等：再跑一次换个名字也安全（它会先读出当前 owner）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const REPO = 'dsh-redstone-music'
const PLACEHOLDER = 'OWNER'

const next = process.argv[2]?.trim()
if (!next) {
  console.error('用法：node scripts/set-owner.mjs <github-username>')
  process.exit(2)
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(next)) {
  console.error(`"${next}" 不像合法的 GitHub 用户名（字母数字与连字符，不能以连字符开头/结尾）`)
  process.exit(2)
}

// ── 当前 owner：从 package.json#repository 读，读不出来就当成还是占位符
const manifestPath = path.join(ROOT, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const current = /github\.com[/:]([A-Za-z0-9-]+)\//.exec(String(manifest.repository?.url ?? ''))?.[1] ?? PLACEHOLDER
if (current === next) {
  console.log(`owner 已经是 ${next}，无需改动。`)
  process.exit(0)
}

const changed = []

// ── 1) package.json
manifest.repository = { type: 'git', url: `git+https://github.com/${next}/${REPO}.git` }
manifest.homepage = `https://github.com/${next}/${REPO}#readme`
manifest.bugs = { url: `https://github.com/${next}/${REPO}/issues` }
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
changed.push('package.json（repository / homepage / bugs）')

// ── 2) 条目 yml：改内容 + 改文件名
const entryDir = path.join(ROOT, 'publish', 'awesome-dsh-plugin', 'data', 'plugins')
const entryFiles = fs.existsSync(entryDir) ? fs.readdirSync(entryDir).filter((f) => f.endsWith(`__${REPO}.yml`)) : []
for (const file of entryFiles) {
  const from = path.join(entryDir, file)
  const text = fs.readFileSync(from, 'utf8').replaceAll(`github.com/${current}/`, `github.com/${next}/`).replaceAll(`name: ${current}/`, `name: ${next}/`)
  const to = path.join(entryDir, `${next}__${REPO}.yml`)
  fs.writeFileSync(from, text, 'utf8')
  if (from !== to) fs.renameSync(from, to)
  changed.push(`publish/awesome-dsh-plugin/data/plugins/${next}__${REPO}.yml`)
}

// CHECKLIST.md 刻意不动：说明文字里的 owner 一律写成 `<GITHUB_OWNER>` 占位（自我描述、一眼能替），
// 让 set-owner 去重写散文只会把它改脏。这里改为把填好用户名的命令直接打出来。
console.log(`已把 owner 从 ${current} 改成 ${next}：`)
for (const item of changed) console.log(`  · ${item}`)
console.log('\n接下来（命令已填好你的用户名）：')
console.log(`  cd '${ROOT}'`)
console.log('  git init -b main && git add -A && git commit -m "feat: redstone-music toolkit (rm_render / rm_build)"')
console.log(`  git remote add origin https://github.com/${next}/${REPO}.git`)
console.log('  git push -u origin main')
console.log('\n然后：pnpm run check:listing   （核对 url/name/文件名是否一致）')
