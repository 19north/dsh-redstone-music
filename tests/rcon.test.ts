import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { decodePacket, openRcon } from '../src/music/rcon'

/** 一个最小可用的 RCON 服务端：只认对了密码的连接，并把命令回显成大写 */
function startFakeRcon(password: string): Promise<{ port: number; close: () => Promise<void>; commands: string[] }> {
  const commands: string[] = []
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const packet = decodePacket(buffer)
        if (!packet) break
        buffer = Buffer.from(buffer.subarray(packet.size))
        if (packet.type === 3) {
          const ok = packet.body === password
          // 与 Minecraft 实际行为一致：认证失败时回 id = -1
          socket.write(encode(ok ? packet.id : -1, 2, ok ? '' : 'auth failed'))
        } else if (packet.type === 2) {
          commands.push(packet.body)
          socket.write(encode(packet.id, 0, `echo:${packet.body.toUpperCase()}`))
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
        commands,
      })
    })
  })
}

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  return buf
}

const servers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

describe('RCON 包格式', () => {
  it('编码/解码能往返，且不完整时不返回', () => {
    const buffer = encode(7, 2, 'list')
    expect(decodePacket(buffer.subarray(0, 5))).toBeNull()
    expect(decodePacket(buffer)).toEqual({ id: 7, type: 2, body: 'list', size: buffer.length })
  })
})

describe('RCON 客户端', () => {
  it('登录成功后能串行执行命令并按顺序拿回结果', async () => {
    const server = await startFakeRcon('secret')
    servers.push(server.close)
    const client = await openRcon({ host: '127.0.0.1', port: server.port, password: 'secret' })
    try {
      expect(await client.exec('list')).toBe('echo:LIST')
      const results = await client.execMany(['tick rate 16', 'datapack list'])
      expect(results).toEqual(['echo:TICK RATE 16', 'echo:DATAPACK LIST'])
      expect(server.commands).toEqual(['list', 'tick rate 16', 'datapack list'])
    } finally {
      client.close()
    }
  })

  it('密码不对时报错，而不是静默把命令丢进去', async () => {
    const server = await startFakeRcon('secret')
    servers.push(server.close)
    await expect(openRcon({ host: '127.0.0.1', port: server.port, password: 'wrong' })).rejects.toThrow(/认证失败/)
    expect(server.commands).toEqual([])
  })

  it('连不上时报错（不会挂死）', async () => {
    await expect(openRcon({ host: '127.0.0.1', port: 1, password: 'x' })).rejects.toThrow(/连接 RCON 失败/)
  })
})
