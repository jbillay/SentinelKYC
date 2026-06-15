// Phase 0 — component smoke. Proves .vue SFCs compile and mount under jsdom via
// @vue/test-utils. CountryFlag is the simplest pure-presentational component;
// the broader component suite lands in Phase 5.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CountryFlag from '@/components/CountryFlag.vue'

describe('CountryFlag', () => {
  it('renders a flag span for a known country code', () => {
    const w = mount(CountryFlag, { props: { code: 'gb', label: 'United Kingdom' } })
    expect(w.find('.fi-gb').exists()).toBe(true)
    expect(w.text()).toContain('United Kingdom')
  })

  it('falls back to the globe glyph when no code is given', () => {
    const w = mount(CountryFlag, { props: { label: 'Unknown' } })
    expect(w.find('.country-globe').exists()).toBe(true)
    expect(w.find('.fi').exists()).toBe(false)
  })
})
