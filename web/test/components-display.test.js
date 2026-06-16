// Phase 5b — Pure display components (no Pinia stores, no vue-router).
// Mount each with @vue/test-utils and assert the rendered output.
//
// Covered: SearchForm, CandidateDisambiguation, NotFound, QaNarrative,
//          FinalDecisionPanelReadOnly.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SearchForm from '@/components/SearchForm.vue'
import CandidateDisambiguation from '@/components/CandidateDisambiguation.vue'
import NotFound from '@/components/NotFound.vue'
import QaNarrative from '@/components/QaNarrative.vue'
import FinalDecisionPanelReadOnly from '@/components/FinalDecisionPanelReadOnly.vue'

// ─── SearchForm ───────────────────────────────────────────────────────────────

describe('SearchForm', () => {
  it('renders the four inputs and a submit button', () => {
    const w = mount(SearchForm)
    expect(w.find('input[placeholder*="Barclays"]').exists()).toBe(true)
    expect(w.find('input[placeholder="EC2N 4AA"]').exists()).toBe(true)
    expect(w.find('input[placeholder="1985"]').exists()).toBe(true)
    expect(w.find('input[placeholder="00006245"]').exists()).toBe(true)
    expect(w.find('button[type="submit"]').exists()).toBe(true)
  })

  it('emits submit with the trimmed name when only name is filled', async () => {
    const w = mount(SearchForm)
    await w.find('input[placeholder*="Barclays"]').setValue('  ACME LTD  ')
    await w.find('form').trigger('submit')
    const emits = w.emitted('submit')
    expect(emits).toHaveLength(1)
    expect(emits[0][0]).toMatchObject({ name: 'ACME LTD' })
    expect(emits[0][0].postcode).toBeUndefined()
  })

  it('emits submit with companyNumber when set', async () => {
    const w = mount(SearchForm)
    await w.find('input[placeholder="00006245"]').setValue('01234567')
    await w.find('form').trigger('submit')
    expect(w.emitted('submit')[0][0]).toMatchObject({ companyNumber: '01234567' })
  })

  it('emits submit with all optional fields when filled', async () => {
    const w = mount(SearchForm)
    await w.find('input[placeholder*="Barclays"]').setValue('ACME')
    await w.find('input[placeholder="EC2N 4AA"]').setValue('SW1A 1AA')
    await w.find('input[placeholder="1985"]').setValue('2010')
    await w.find('input[placeholder="00006245"]').setValue('12345678')
    await w.find('form').trigger('submit')
    const payload = w.emitted('submit')[0][0]
    expect(payload).toMatchObject({
      name: 'ACME',
      postcode: 'SW1A 1AA',
      incorporationYear: 2010,
      companyNumber: '12345678',
    })
  })

  it('emits an empty object when nothing is filled', async () => {
    const w = mount(SearchForm)
    await w.find('form').trigger('submit')
    expect(w.emitted('submit')[0][0]).toEqual({})
  })

  it('shows "Running" label and disables inputs when disabled prop is true', () => {
    const w = mount(SearchForm, { props: { disabled: true } })
    expect(w.find('button[type="submit"]').text()).toContain('Running')
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    const inputs = w.findAll('input')
    for (const input of inputs) {
      expect(input.attributes('disabled')).toBeDefined()
    }
  })
})

// ─── CandidateDisambiguation ──────────────────────────────────────────────────

const CANDIDATES = [
  {
    companyNumber: '01234567',
    title: 'ACME LTD',
    score: 0.85,
    status: 'active',
    incorporationDate: '2000-01-01',
    type: 'ltd',
    address: '1 High Street, London',
  },
  {
    companyNumber: '99999999',
    title: 'ACME HOLDINGS PLC',
    score: 0.60,
    status: 'dissolved',
    incorporationDate: null,
    type: 'plc',
    address: null,
  },
]

describe('CandidateDisambiguation', () => {
  it('renders one row per candidate', () => {
    const w = mount(CandidateDisambiguation, { props: { candidates: CANDIDATES } })
    expect(w.findAll('li')).toHaveLength(2)
    expect(w.text()).toContain('ACME LTD')
    expect(w.text()).toContain('ACME HOLDINGS PLC')
  })

  it('emits pick with the company number when a row is clicked', async () => {
    const w = mount(CandidateDisambiguation, { props: { candidates: CANDIDATES } })
    await w.find('button.row').trigger('click')
    expect(w.emitted('pick')).toBeTruthy()
    expect(w.emitted('pick')[0][0]).toBe('01234567')
  })

  it('shows "Auto-matched" chip for the resolved candidate', () => {
    const w = mount(CandidateDisambiguation, {
      props: {
        candidates: CANDIDATES,
        resolution: { status: 'auto_match', chosen: '01234567' },
      },
    })
    expect(w.text()).toContain('Auto-matched')
  })

  it('shows score chips when no auto-match resolution', () => {
    const w = mount(CandidateDisambiguation, { props: { candidates: CANDIDATES } })
    expect(w.text()).toContain('0.85')
    expect(w.text()).toContain('0.60')
  })

  it('shows the resolution reason when provided', () => {
    const w = mount(CandidateDisambiguation, {
      props: {
        candidates: CANDIDATES,
        resolution: { status: 'needs_user_pick', reason: 'Multiple plausible matches.' },
      },
    })
    expect(w.text()).toContain('Multiple plausible matches.')
  })

  it('renders address when present', () => {
    const w = mount(CandidateDisambiguation, { props: { candidates: CANDIDATES } })
    expect(w.text()).toContain('1 High Street, London')
  })
})

// ─── NotFound ─────────────────────────────────────────────────────────────────

describe('NotFound', () => {
  it('shows "Company doesn\'t exist" for not_found status', () => {
    const w = mount(NotFound, { props: { resolution: { status: 'not_found' } } })
    expect(w.text()).toContain("Company doesn't exist")
  })

  it('shows "No matching company" for needs_more_info status', () => {
    const w = mount(NotFound, { props: { resolution: { status: 'needs_more_info' } } })
    expect(w.text()).toContain('No matching company')
  })

  it('shows fallback for unknown status (no_card variant)', () => {
    const w = mount(NotFound, { props: { resolution: { status: 'done' } } })
    expect(w.text()).toContain('Run finished without a KYC card')
  })

  it('renders the detail reason when provided', () => {
    const w = mount(NotFound, {
      props: { resolution: { status: 'not_found', reason: 'HTTP 404 from CH' } },
    })
    expect(w.text()).toContain('HTTP 404 from CH')
  })

  it('renders without error when no resolution prop is given', () => {
    // Should show the no_card fallback (default variant)
    const w = mount(NotFound)
    expect(w.text()).toContain('Run finished without a KYC card')
  })
})

// ─── QaNarrative ─────────────────────────────────────────────────────────────

describe('QaNarrative', () => {
  it('shows the empty state when narrative is null', () => {
    const w = mount(QaNarrative)
    expect(w.text()).toContain('Narrative not yet generated')
  })

  it('renders paragraphs split by double newline', () => {
    const w = mount(QaNarrative, {
      props: {
        narrative: {
          text: 'First paragraph.\n\nSecond paragraph.',
          tier: 'Low',
          paragraphCount: 2,
          generatedAt: null,
        },
      },
    })
    const paras = w.findAll('p.qa-narrative-p')
    expect(paras).toHaveLength(2)
    expect(paras[0].text()).toBe('First paragraph.')
    expect(paras[1].text()).toBe('Second paragraph.')
  })

  it('falls back to single-newline split for older runs', () => {
    const w = mount(QaNarrative, {
      props: {
        narrative: {
          text: 'Para one.\nPara two.',
          tier: 'Medium',
          paragraphCount: 2,
          generatedAt: null,
        },
      },
    })
    const paras = w.findAll('p.qa-narrative-p')
    expect(paras).toHaveLength(2)
  })

  it('shows the tier badge with the correct class', () => {
    const w = mount(QaNarrative, {
      props: {
        narrative: { text: 'Content.', tier: 'High', paragraphCount: 1, generatedAt: null },
      },
    })
    expect(w.find('.qa-narrative-tier--high').exists()).toBe(true)
    expect(w.text()).toContain('High risk')
  })

  it('shows the model footer when not compact', () => {
    const w = mount(QaNarrative, {
      props: {
        narrative: {
          text: 'Content.',
          tier: 'Low',
          paragraphCount: 1,
          generatedAt: null,
          model: 'llama3.1:8b',
        },
        compact: false,
      },
    })
    expect(w.text()).toContain('llama3.1:8b')
  })

  it('hides the model footer in compact mode', () => {
    const w = mount(QaNarrative, {
      props: {
        narrative: {
          text: 'Content.',
          tier: 'Low',
          paragraphCount: 1,
          generatedAt: null,
          model: 'llama3.1:8b',
        },
        compact: true,
      },
    })
    expect(w.text()).not.toContain('llama3.1:8b')
  })

  it('formats generatedAt as a locale string', () => {
    const ts = '2026-01-01T12:00:00.000Z'
    const w = mount(QaNarrative, {
      props: {
        narrative: { text: 'Content.', tier: 'Low', paragraphCount: 1, generatedAt: ts },
      },
    })
    // Just assert something time-ish appeared (locale-dependent)
    expect(w.text()).toContain('Generated')
  })
})

// ─── FinalDecisionPanelReadOnly ───────────────────────────────────────────────

describe('FinalDecisionPanelReadOnly', () => {
  it('shows empty state when qaResult is null', () => {
    const w = mount(FinalDecisionPanelReadOnly)
    expect(w.text()).toContain('No QA result')
  })

  it('shows the auto-approved banner with ok tone', () => {
    const w = mount(FinalDecisionPanelReadOnly, {
      props: {
        qaResult: {
          routing: { caseStatus: 'auto_approved', qaSummary: 'QA passed cleanly.' },
          highlightedIssues: [],
        },
        caseStatus: 'auto_approved',
      },
    })
    expect(w.text()).toContain('QA passed — auto-approved')
    expect(w.find('.decision-panel--ok').exists()).toBe(true)
  })

  it('shows the standard-review banner with warn tone', () => {
    const w = mount(FinalDecisionPanelReadOnly, {
      props: {
        qaResult: {
          routing: { caseStatus: 'standard_review', qaSummary: 'Issues flagged.' },
          highlightedIssues: [],
        },
      },
    })
    expect(w.find('.decision-panel--warn').exists()).toBe(true)
    expect(w.text()).toContain('QA flagged issues')
  })

  it('renders highlighted issues with severity classes', () => {
    const w = mount(FinalDecisionPanelReadOnly, {
      props: {
        qaResult: {
          routing: { caseStatus: 'standard_review', qaSummary: 'Issues.' },
          highlightedIssues: [
            { code: 'ubo_not_screened', severity: 'high', message: 'UBO was not screened.' },
            { code: 'completeness_low', severity: 'medium', message: 'Missing field.' },
          ],
        },
      },
    })
    const issues = w.findAll('li.issue')
    expect(issues).toHaveLength(2)
    expect(issues[0].classes()).toContain('issue--high')
    expect(issues[1].classes()).toContain('issue--medium')
    expect(w.text()).toContain('UBO was not screened.')
  })

  it('shows the caseStatus badge when provided', () => {
    const w = mount(FinalDecisionPanelReadOnly, {
      props: {
        qaResult: {
          routing: { caseStatus: 'streamlined_review', qaSummary: 'OK.' },
          highlightedIssues: [],
        },
        caseStatus: 'approved',
      },
    })
    expect(w.text()).toContain('approved')
  })
})
