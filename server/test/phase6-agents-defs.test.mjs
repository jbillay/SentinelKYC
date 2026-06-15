import { describe, it, expect } from 'vitest'
import { AGENTS, getAgentDef, listAgentDefs, secretFieldKeys } from '../agents/defs.js'

describe('agents/defs — registry', () => {
  it('lists the six pipeline agents with unique ids', () => {
    const ids = listAgentDefs().map((a) => a.id)
    expect(ids).toEqual([
      'entity-resolution',
      'document-manager',
      'ubo-structure',
      'screening',
      'risk-assessment',
      'qa',
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(AGENTS).toBe(listAgentDefs())
  })

  it('only entity-resolution is required', () => {
    expect(getAgentDef('entity-resolution').required).toBe(true)
    expect(getAgentDef('screening').required).toBe(false)
  })

  it('getAgentDef throws on an unknown id', () => {
    expect(() => getAgentDef('nope')).toThrow(/Unknown agent id: nope/)
  })

  it('every agent default body satisfies its own schema', () => {
    for (const def of listAgentDefs()) {
      const parsed = def.schema.safeParse(def.defaults)
      expect(parsed.success, `${def.id} defaults must validate`).toBe(true)
    }
  })

  it('no agent declares secret fields yet', () => {
    for (const def of listAgentDefs()) {
      expect(secretFieldKeys(def)).toEqual([])
    }
  })
})

describe('agents/defs — schema edge cases', () => {
  it('entity-resolution rejects an out-of-range threshold and an unknown vendor', () => {
    const def = getAgentDef('entity-resolution')
    expect(def.schema.safeParse({ ...def.defaults, autoMatchThreshold: 1.5 }).success).toBe(false)
    expect(def.schema.safeParse({ ...def.defaults, enrichmentVendors: ['orbis'] }).success).toBe(false)
    expect(def.schema.safeParse({ ...def.defaults, enrichmentVendors: ['mock'] }).success).toBe(true)
  })

  it('entity-resolution is strict (rejects unknown keys)', () => {
    const def = getAgentDef('entity-resolution')
    expect(def.schema.safeParse({ ...def.defaults, surprise: true }).success).toBe(false)
  })

  it('document-manager enforces integer pageCap bounds', () => {
    const def = getAgentDef('document-manager')
    expect(def.schema.safeParse({ ...def.defaults, pageCap: 0 }).success).toBe(false)
    expect(def.schema.safeParse({ ...def.defaults, pageCap: 51 }).success).toBe(false)
    expect(def.schema.safeParse({ ...def.defaults, pageCap: 2.5 }).success).toBe(false)
    expect(def.schema.safeParse({ ...def.defaults, pageSelection: 'random' }).success).toBe(false)
  })

  it('screening validates the GDELT timespan regex', () => {
    const def = getAgentDef('screening')
    expect(def.schema.safeParse({ ...def.defaults, gdeltTimespan: '24m' }).success).toBe(true)
    expect(def.schema.safeParse({ ...def.defaults, gdeltTimespan: '1y' }).success).toBe(true)
    expect(def.schema.safeParse({ ...def.defaults, gdeltTimespan: 'soon' }).success).toBe(false)
  })

  it('risk-assessment and qa accept just { enabled }', () => {
    expect(getAgentDef('risk-assessment').schema.safeParse({ enabled: true }).success).toBe(true)
    expect(getAgentDef('qa').schema.safeParse({ enabled: false }).success).toBe(true)
    expect(getAgentDef('qa').schema.safeParse({ enabled: 'yes' }).success).toBe(false)
  })

  it('every agent declares io.reads and io.writes arrays', () => {
    for (const def of listAgentDefs()) {
      expect(Array.isArray(def.io.reads)).toBe(true)
      expect(Array.isArray(def.io.writes)).toBe(true)
    }
  })
})
