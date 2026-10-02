import { describe, expect, it } from 'vitest'
import { matchPitfalls } from '../src/tools'
import { PITFALLS, PIPELINE } from '../src/knowledge'

describe('knowledge', () => {
  it('至少收录 12 条硬教训', () => {
    expect(PITFALLS.length).toBeGreaterThanOrEqual(12)
  })

  it('每条都必须有症状/根因/修法/检测', () => {
    for (const p of PITFALLS) {
      expect(p.id).toBeTruthy()
      expect(p.symptom.length).toBeGreaterThan(4)
      expect(p.cause.length).toBeGreaterThan(4)
      expect(p.fix.length).toBeGreaterThan(4)
      expect(typeof p.detect).toBe('string')
    }
  })

  it('id 不重复', () => {
    const ids = PITFALLS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('流程有 9 步', () => {
    expect(PIPELINE.length).toBe(9)
  })
})

describe('matchPitfalls', () => {
  it('无参返回全部', () => {
    expect(matchPitfalls(undefined, undefined).length).toBe(PITFALLS.length)
  })

  it('能按症状关键词命中“全是错音”这条', () => {
    const hit = matchPitfalls('错音', undefined)
    expect(hit.length).toBeGreaterThan(0)
    expect(hit.some((p) => p.id === 'glissando-sound-event')).toBe(true)
  })

  it('area 过滤生效', () => {
    const hit = matchPitfalls(undefined, '音频')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit.every((p) => p.area === '音频')).toBe(true)
  })

  it('匹配不到时返回空数组而不是抛错', () => {
    expect(matchPitfalls('这个词肯定不存在zzz', undefined)).toEqual([])
  })
})
