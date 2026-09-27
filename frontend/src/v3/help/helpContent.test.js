import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP_SECTIONS, HELP_SECTION_IDS } from './helpContent'

const V3 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.jsx?$/.test(f) && !f.includes('.test.') ? [p] : []
  })
}

describe('help content', () => {
  it('every ? button and openHelp() call points at an existing section', () => {
    const used = new Set()
    for (const file of sources(V3)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/<HelpButton[^>]*section="([\w-]+)"/g)) used.add(m[1])
      for (const m of src.matchAll(/openHelp\('([\w-]+)'\)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(5)
    for (const id of used) expect(HELP_SECTION_IDS).toContain(id)
  })

  it('sections have unique ids and every entry has a term and an explanation', () => {
    expect(new Set(HELP_SECTION_IDS).size).toBe(HELP_SECTION_IDS.length)
    for (const s of HELP_SECTIONS) {
      expect(s.title).toBeTruthy()
      for (const i of s.items) {
        expect(i.term.length).toBeGreaterThan(1)
        expect(i.body.length).toBeGreaterThan(10)
      }
    }
  })
})
