/**
 * dsh-redstone-music —— 把"制作 Minecraft 红石音乐"的全套能力做成 DSH 插件
 *
 * 装上它，任何会话都能：
 *   ① 查这一整套流程里【踩过的所有坑】（12 条硬教训，含症状/根因/修法/检测命令）
 *   ② 按固定 9 步流程做一条带子
 *
 * 已实现：redstone_music_pitfalls / redstone_music_pipeline / rm_render / rm_build
 * 规划中（见 src/knowledge.ts 的 PIPELINE）：
 *   rm_analyze / rm_plan / rm_pack / rm_verify / rm_fx
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { applyTools } from './tools'

export const name = 'dsh-redstone-music'
export const inject = ['tools']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

// Every registration is an effect: `ctx.tools.register` returns the disposer that
// removes the tool on unload, so the plugin stays hot-reloadable (guide §3.3).
export function apply(ctx: Context, config: ConfigShape): void {
  if (config.enabled === false) return
  applyTools(ctx, config)
}
