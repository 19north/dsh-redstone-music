import Schema from '@deepseek-ai/schemastery'

// Tunable configuration must be a Schemastery Schema, never a plain object:
// the harness validates it at load time and fails loud on invalid values, and
// every key can be changed from cordis.yml without editing code (guide §3.6).
export interface Config {
  /** 是否启用本插件（便于临时关闭） */
  enabled: boolean
  /** Minecraft 服务端目录（RCON 脚本、数据包、日志都在这里） */
  serverDir: string
  /** RCON 主机 */
  rconHost: string
  /** RCON 端口 */
  rconPort: number
  /** RCON 密码（留空则 rm_build 只能 pack、不能 deploy） */
  rconPassword: string
  /** 目标世界的数据包目录（相对 serverDir） */
  datapackDir: string
  /** 客户端资源包目录（可选；填了就自动投递打包好的 zip） */
  clientPackDir: string
  /** 默认 SoundFont（.sf2）路径；rm_render 的渲染源 */
  soundFont: string
  /** 默认采样输出目录（rm_render 未显式给 outDir 时用） */
  sampleDir: string
  /** 采样率（Hz）：渲染与起音对齐都用它 */
  sampleRate: number
  /** 起音对齐后允许的最大起音（ms）；超过即判不合格 */
  maxOnsetMs: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用红石音乐工具。'),
  serverDir: Schema.string().default('').description('Minecraft 服务端目录（rm_build 默认数据包落点的基准；留空则必须给 outputDir）。'),
  rconHost: Schema.string().default('127.0.0.1').description('RCON 主机。'),
  rconPort: Schema.number().default(25575).description('RCON 端口。'),
  rconPassword: Schema.string().default('').description('RCON 密码（留空则 rm_build 不能 deploy）。'),
  datapackDir: Schema.string().default('world/datapacks').description('数据包目录（相对服务端目录）。'),
  clientPackDir: Schema.string().default('').description('客户端 resourcepacks 目录（留空则不自动投递）。'),
  soundFont: Schema.string().default('').description('SoundFont (.sf2) 路径；rm_render 的 render 模式需要它（align 模式不需要）。'),
  sampleDir: Schema.string().default('').description('采样输出目录（留空则用 rm_render 的 outDir 参数）。'),
  sampleRate: Schema.number().default(44100).description('采样率 Hz。'),
  maxOnsetMs: Schema.number().default(3).description('起音对齐后允许的最大起音 ms。'),
})
