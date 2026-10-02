/**
 * rcon.ts —— 极简 Minecraft RCON 客户端（Source RCON 协议）
 *
 * 为什么自己写：build/deploy 必须在同一个进程里【串行】发命令。
 * 并行发 RCON 会互相抢锁，实战里正因如此让建造任务失去连接、进度从 1575 退回 257 并从头重跑。
 * 这里用一个串行队列保证同一时刻只有一条命令在飞。
 */
import net from 'node:net'

const TYPE_AUTH = 3
const TYPE_COMMAND = 2

export interface RconOptions {
  host: string
  port: number
  password: string
  /** 单条命令超时（毫秒），默认 15s */
  timeoutMs?: number
}

export interface RconClient {
  exec(command: string): Promise<string>
  execMany(
    commands: readonly string[],
    options?: { batchDelayMs?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<string[]>
  close(): void
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeInt8(0, 12 + payload.length)
  buf.writeInt8(0, 13 + payload.length)
  return buf
}

/** 从缓冲区头部取一条完整包；不完整返回 null */
export function decodePacket(buffer: Buffer): { id: number; type: number; body: string; size: number } | null {
  if (buffer.length < 12) return null
  const length = buffer.readInt32LE(0)
  if (length < 10 || buffer.length < length + 4) return null
  const id = buffer.readInt32LE(4)
  const type = buffer.readInt32LE(8)
  const body = buffer.toString('utf8', 12, length + 2)
  return { id, type, body, size: length + 4 }
}

export async function openRcon(options: RconOptions): Promise<RconClient> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ host: options.host, port: options.port })
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error(`连接 RCON ${options.host}:${options.port} 超时`))
    }, 8000)
    s.once('connect', () => {
      clearTimeout(timer)
      resolve(s)
    })
    s.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`连接 RCON 失败：${error.message}`))
    })
  })

  // ── 第一步：登录（认证必须在挂上通用分发器之前完成，避免两个 data 监听器争抢缓冲区）
  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const fail = (error: Error): void => {
      cleanup()
      // 认证失败/超时后必须主动断开，否则连接会挂着不释放
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('RCON 登录超时')), 8000)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const packet = decodePacket(buf)
      if (!packet) return
      cleanup()
      if (packet.id === -1) fail(new Error('RCON 认证失败（密码不对）'))
      else resolve()
    }
    const onError = (error: Error): void => {
      fail(new Error(`RCON 登录时连接出错：${error.message}`))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.write(encodePacket(1, TYPE_AUTH, options.password))
  })

  // ── 第二步：通用分发（串行队列 + 单条超时）
  let buffer = Buffer.alloc(0)
  let pending: { id: number; resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined
  let nextId = 2
  let failure: Error | undefined
  const waiters: (() => void)[] = []

  const settle = (error: Error | undefined, value?: string): void => {
    const current = pending
    pending = undefined
    const next = waiters.shift()
    if (current) {
      clearTimeout(current.timer)
      if (error) current.reject(error)
      else current.resolve(value ?? '')
    }
    if (next) next()
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const packet = decodePacket(buffer)
      if (!packet) break
      buffer = Buffer.from(buffer.subarray(packet.size))
      if (pending && packet.id === pending.id) settle(undefined, packet.body)
    }
  })
  socket.on('error', (error) => {
    failure = new Error(`RCON 连接出错：${error.message}`)
    settle(failure)
    for (const resume of waiters.splice(0)) resume()
  })
  socket.on('close', () => {
    if (pending) settle(failure ?? new Error('RCON 连接被关闭'))
  })

  const send = (command: string, timeout: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const run = (): void => {
        if (failure) {
          reject(failure)
          const next = waiters.shift()
          if (next) next()
          return
        }
        const id = nextId++
        pending = {
          id,
          resolve,
          reject,
          timer: setTimeout(() => settle(new Error(`RCON 命令超时：${command}`)), timeout),
        }
        socket.write(encodePacket(id, TYPE_COMMAND, command))
      }
      if (pending) waiters.push(run)
      else run()
    })

  return {
    exec: (command) => send(command, timeoutMs),
    async execMany(commands, runOptions) {
      const results: string[] = []
      let done = 0
      for (const command of commands) {
        results.push(await send(command, 60_000))
        done++
        runOptions?.onProgress?.(done, commands.length)
        if (runOptions?.batchDelayMs) await new Promise((r) => setTimeout(r, runOptions.batchDelayMs))
      }
      return results
    },
    close() {
      socket.end()
      socket.destroy()
    },
  }
}
