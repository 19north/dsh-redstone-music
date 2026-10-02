/**
 * tools.ts —— 红石音乐插件的工具集
 *
 * 已实现：
 *   redstone_music_pitfalls   查踩坑清单（按症状/领域过滤）
 *   redstone_music_pipeline   输出固定制作流程
 *   rm_render                 渲染采样 → 起音对齐 → 自验证
 *   rm_build                  谱面 + 轨表 → 数据包（mcfunction 分片）→ 可选部署开建
 * 规划中（见 knowledge.ts 的 PIPELINE）：
 *   rm_analyze（MIDI 分析）/ rm_plan（轨表设计）/ rm_pack（资源包）/ rm_verify / rm_fx
 *
 * 设计约定（对齐官方契约）：
 *  - execute 只返回 output.schema 声明的规范 JSON；
 *  - 人类可读文本放 output.render（纯函数，禁 I/O）；
 *  - 必填字段用【逐属性 required: true】，不是 JSON Schema 的 required 数组
 *    （value schema DSL 只认前者，写数组会在注册工具时直接抛错）；
 *  - 一切注册走 ctx.tools.register（返回 disposer，可热重载）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { PITFALLS, PIPELINE, type Pitfall } from './knowledge'
import type { Config } from './config'
import { registerRenderTool } from './tool-render'
import { registerBuildTool } from './tool-build'

/** 纯函数：按关键词/领域过滤（便于单测，无 I/O） */
export function matchPitfalls(query: string | undefined, area: string | undefined): Pitfall[] {
  const q = (query ?? '').trim().toLowerCase()
  return PITFALLS.filter((p) => {
    if (area && p.area !== area) return false
    if (!q) return true
    const hay = `${p.id} ${p.area} ${p.title} ${p.symptom} ${p.cause} ${p.fix} ${p.detect}`.toLowerCase()
    return q.split(/\s+/).every((tok) => hay.includes(tok))
  })
}

function fmt(p: Pitfall): string {
  return [
    `【${p.area}】${p.title}`,
    `  症状：${p.symptom}`,
    `  根因：${p.cause}`,
    `  修法：${p.fix}`,
    `  检测：${p.detect}`,
  ].join('\n')
}

export function applyTools(ctx: Context, config: Config): void {
  // ① 踩坑清单
  ctx.tools.register(
    defineTool({
      name: 'redstone_music_pitfalls',
      description:
        '查询"制作 Minecraft 红石音乐"的踩坑清单（12 条硬教训，含症状/根因/修法/检测方法）。' +
        '遇到"全是错音""有时差""很乱""卡顿""链条断了""音符盒不触发"等问题时先查这里。',
      parameters: {
        query: { type: 'string', description: '关键词（会匹配症状/根因/修法），如"错音" "时差" "卡" "中继器"' },
        area: { type: 'string', enum: ['音频', '时序', '性能', '数据包', '方块', '工具'], description: '按领域过滤（可选）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number', required: true },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  area: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  symptom: { type: 'string', required: true },
                  cause: { type: 'string', required: true },
                  fix: { type: 'string', required: true },
                  detect: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.count === 0
                ? '没有匹配的条目。试试更短的关键词，或去掉 area。'
                : `命中 ${value.count} 条：\n\n${value.items.map((item) => fmt(item as Pitfall)).join('\n\n')}`,
          },
        ],
      },
      async execute(args) {
        const list = matchPitfalls(args.query, args.area)
        return { count: list.length, items: list.map((p) => ({ ...p })) }
      },
    }),
  )

  // ② 制作流程
  ctx.tools.register(
    defineTool({
      name: 'redstone_music_pipeline',
      description: '输出制作 Minecraft 红石音乐的固定 9 步流程（顺序错一步就会出问题）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { steps: { type: 'array', required: true, items: { type: 'string' } } },
        },
        render: (_args, value) => [{ type: 'text', text: value.steps.join('\n') }],
      },
      async execute() {
        return { steps: [...PIPELINE] }
      },
    }),
  )

  // ③④ 渲染与建造
  registerRenderTool(ctx, config)
  registerBuildTool(ctx, config)
}
