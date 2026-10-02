#!/usr/bin/env node
/**
 * check-listing.mjs —— 上架自检：在本地先跑一遍 awesome-dsh-plugin 会查的东西
 *
 * 上游 CI 查四件事：每 PR ≤3 条条目、`dsh.bundle` manifest、仓库创建满 1 天、awesome-lint 与站点构建。
 * 这里把【本地能查的】全部查掉（第 3 项要仓库真的存在，只能建完再等一天）。再加上市场端的关联规则：
 * npm 包的 `repository` 必须指回被收录的仓库，否则两者不关联。
 *
 * 用法：node scripts/check-listing.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const args = process.argv.slice(2)
const asJson = args.includes('--json')

/** 上游 contributing.md 里列出的分类取值 */
const CATEGORIES = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser',
  'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
]
/** 描述里不该出现的营销词（上游："只说功能，不带营销词"） */
const MARKETING = ['best ', 'the best', 'amazing', 'awesome', 'powerful', 'revolutionary', 'ultimate', 'world-class', '第一', '最强', '无敌']

const results = []
const check = (ok, id, detail) => results.push({ ok, id, detail })
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

// ── 1. package.json 与 dsh.bundle manifest（CI 的第二项，最常见的被拒原因）
const manifest = JSON.parse(read(path.join(ROOT, 'package.json')) ?? '{}')
check(typeof manifest.name === 'string' && manifest.name !== '', 'manifest-name', `name = ${manifest.name}`)
check(typeof manifest.dsh?.bundle?.patch === 'string', 'dsh-bundle', `dsh.bundle.patch = ${manifest.dsh?.bundle?.patch ?? '(缺失)'}`)
const patchPath = path.join(ROOT, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
check(fs.existsSync(patchPath), 'patch-exists', `cordis.patch.yml：${fs.existsSync(patchPath) ? '存在' : '不存在'}`)
const patch = read(patchPath) ?? ''
const rowIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
const rowNames = [...patch.matchAll(/^\s*name:\s*(\S+)/gm)].map((m) => m[1])
check(rowIds.length > 0 && rowNames.includes(manifest.name), 'patch-rows', `行 id=${rowIds.join(',')} name=${rowNames.join(',')}`)
check(new Set(rowIds).size === rowIds.length, 'patch-ids-unique', '行 id 唯一')

// ── 2. 入口与产物（npm 装完必须能 require 到 lib/index.js）
check(manifest.main === 'lib/index.js', 'main', `main = ${manifest.main}`)
check(fs.existsSync(path.join(ROOT, 'lib/index.js')), 'built-entry', 'lib/index.js 已构建（先跑 pnpm run build）')
check(Array.isArray(manifest.files) && manifest.files.includes('lib') && manifest.files.includes('cordis.patch.yml'), 'files-whitelist', `files = ${JSON.stringify(manifest.files)}`)

// ── 3. 描述与关键词（描述会被逐句对着代码核对，所以必须是一句实话）
check(typeof manifest.description === 'string' && manifest.description.length > 20, 'description', manifest.description)
const marketing = MARKETING.filter((word) => manifest.description.toLowerCase().includes(word))
check(marketing.length === 0, 'description-no-marketing', marketing.length ? `含有营销词：${marketing.join(', ')}` : '无营销词')
const keywords = manifest.keywords ?? []
check(['dsh', 'dsh-plugin', 'deepseek-harness'].every((k) => keywords.includes(k)), 'keywords', keywords.join(', '))

// ── 4. npm ↔ 仓库关联（市场靠 repository 把包和仓库绑在一起）
const repoUrl = manifest.repository?.url ?? ''
const repoMatch = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repoUrl.replace(/^git\+/, ''))
check(repoMatch !== null, 'repository', repoUrl || '(缺失)')
const owner = repoMatch?.[1] ?? ''
const repo = repoMatch?.[2] ?? ''
check(
  owner !== '' && owner !== 'OWNER',
  'owner-known',
  owner === 'OWNER'
    ? 'repository 里还是占位符 OWNER —— 拿到 GitHub 用户名后跑：node scripts/set-owner.mjs <用户名>'
    : `owner = ${owner}`,
)
check(owner !== '' && manifest.homepage?.includes(`${owner}/${repo}`), 'homepage', manifest.homepage ?? '(缺失)')
check(owner !== '' && manifest.bugs?.url?.includes(`${owner}/${repo}`), 'bugs', manifest.bugs?.url ?? '(缺失)')

// ── 5. 官方包必须走 peerDependencies（上游明确要求）
const officialInDeps = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
check(officialInDeps.length === 0, 'official-not-in-deps', officialInDeps.length ? `这些不该出现在 dependencies：${officialInDeps.join(', ')}` : '官方包都在 peer/dev')
const peerNames = Object.keys(manifest.peerDependencies ?? {})
check(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'].every((n) => peerNames.includes(n)), 'peers', peerNames.join(', '))

// ── 6. 许可证与五语 README（awesome-lint 要求双语一致）
check(typeof manifest.license === 'string' && fs.existsSync(path.join(ROOT, 'LICENSE')), 'license', manifest.license ?? '(缺失)')
const readmes = ['README.md', 'README-zh.md', 'README-es.md', 'README-hi.md', 'README-pt.md']
const missingReadmes = readmes.filter((f) => !fs.existsSync(path.join(ROOT, f)))
check(missingReadmes.length === 0, 'readmes-present', missingReadmes.length ? `缺：${missingReadmes.join(', ')}` : readmes.join(', '))
/** 提取 `## ` 级标题（忽略代码块里的井号） */
function headings(text) {
  const out = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    else if (!inFence && /^##\s+/.test(line)) out.push(line.replace(/^##\s+/, '').trim())
  }
  return out
}
const headingSets = readmes.filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => ({ file: f, list: headings(read(path.join(ROOT, f)) ?? '') }))
const mismatch = headingSets.filter((entry) => entry.list.length !== headingSets[0]?.list.length)
check(mismatch.length === 0, 'readme-headings-parity', mismatch.length ? `标题数不一致：${mismatch.map((m) => `${m.file}(${m.list.length})`).join(', ')}` : `五语各 ${headingSets[0]?.list.length} 个二级标题`)
const enHeadings = (read(path.join(ROOT, 'README.md')) ?? '').toLowerCase()
check(enHeadings.includes('## uninstall'), 'readme-uninstall', 'README 有卸载说明')
check(enHeadings.includes('## minimal example'), 'readme-example', 'README 有最小示例')

// ── 7. 提交条目：格式、分类、与 repository 一致
const entryDir = path.join(ROOT, 'publish', 'awesome-dsh-plugin', 'data', 'plugins')
const entryFile = owner && repo ? path.join(entryDir, `${owner}__${repo}.yml`) : ''
const entry = entryFile ? read(entryFile) : null
check(entry !== null, 'entry-file', entryFile ? path.relative(ROOT, entryFile) : '(repository 未定，无法推断条目文件名)')
if (entry) {
  const url = /^url:\s*(\S+)\s*$/m.exec(entry)?.[1] ?? ''
  const name = /^name:\s*(\S+)\s*$/m.exec(entry)?.[1] ?? ''
  const category = /^category:\s*(\S+)\s*$/m.exec(entry)?.[1] ?? ''
  const en = /^\s*en:\s*(.+)$/m.exec(entry)?.[1]?.trim() ?? ''
  const zh = /^\s*zh:\s*(.+)$/m.exec(entry)?.[1]?.trim() ?? ''
  check(url === `https://github.com/${owner}/${repo}`, 'entry-url', `url 与 package.json#repository 一致：${url}`)
  check(name === `${owner}/${repo}`, 'entry-name', name)
  check(CATEGORIES.includes(category), 'entry-category', `category = ${category}`)
  check(en.length > 20 && /[.!]$/.test(en.replace(/^['"]|['"]$/g, '')), 'entry-description-en', en)
  check(!/:\s/.test(en) || /^['"]/.test(en), 'entry-yaml-quoting', /:\s/.test(en) ? '描述含 ": "，已加引号' : '无需引号')
  check(zh.length === 0 || /[。！？]$/.test(zh.replace(/^['"]|['"]$/g, '')), 'entry-description-zh', zh || '(未写，维护者会补)')
}

// ── 8. 仓库卫生
const gitignore = read(path.join(ROOT, '.gitignore')) ?? ''
check(/node_modules/.test(gitignore), 'gitignore', gitignore ? '忽略 node_modules' : '(缺 .gitignore)')

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
} else {
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} [${r.id}] ${r.detail}`)
  console.log(`\n${failed.length === 0 ? '本地能查的都过了 ✓' : `${failed.length} 项未过 ✗`}`)
  console.log('还剩两件本地查不了的：① 仓库创建满 1 天（CI 自动查）② 描述与代码逐句核对（维护者人工查）。')
}
process.exit(failed.length === 0 ? 0 : 1)
