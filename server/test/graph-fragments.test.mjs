// Phase 4 — the withFragment wrapper + fragment builders. Pure (crypto/metrics/
// log only); the single highest-leverage hook every node flows through.
import { describe, it, expect } from 'vitest';
import { GraphInterrupt } from '@langchain/langgraph';
import { withFragment, makeFragment, kindOf, DECISION_NODES } from '../graph/fragments.js';

describe('kindOf', () => {
  it('classifies decision vs audit nodes', () => {
    expect(kindOf('assess_risk')).toBe('decision');
    expect(kindOf('qa_check')).toBe('decision');
    expect(kindOf('gather_input')).toBe('audit');
    expect(DECISION_NODES.has('synthesize_card')).toBe(true);
  });
});

describe('makeFragment', () => {
  it('builds a fragment with sensible defaults', () => {
    const f = makeFragment({ nodeId: 'assess_risk', startedAt: Date.now() - 5, summary: 's' });
    expect(f.id).toBeTruthy();
    expect(f.nodeId).toBe('assess_risk');
    expect(f.kind).toBe('decision'); // derived from nodeId
    expect(f.status).toBe('ok');
    expect(f.sequence).toBe(-1); // assigned at persistence
    expect(f.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('withFragment', () => {
  it('strips __fragment and emits one fragment, preserving the node partial', async () => {
    const node = withFragment('select_documents', async () => ({
      documents: [{ category: 'accounts' }],
      __fragment: { summary: 'picked 1', outputs: { selected: 1 } },
    }));
    const out = await node({}, {});
    expect(out.documents).toEqual([{ category: 'accounts' }]);
    expect(out.__fragment).toBeUndefined();
    expect(out.fragments).toHaveLength(1);
    expect(out.fragments[0]).toMatchObject({ nodeId: 'select_documents', summary: 'picked 1', status: 'ok' });
  });

  it('builds a default fragment when the node returns none', async () => {
    const node = withFragment('gather_input', async () => ({ ok: true }));
    const out = await node({}, {});
    expect(out.fragments).toHaveLength(1);
    expect(out.fragments[0].summary).toBe('gather_input');
  });

  it('expands a __fragments array (parent + children) and honours supplied durationMs', async () => {
    const node = withFragment('evaluate_sanctions_hits', async () => ({
      __fragments: [
        { summary: 'parent', id: 'p1' },
        { summary: 'child', parentFragmentId: 'p1', durationMs: 42 },
      ],
    }));
    const out = await node({}, {});
    expect(out.fragments).toHaveLength(2);
    expect(out.fragments[1].parentFragmentId).toBe('p1');
    expect(out.fragments[1].durationMs).toBe(42);
  });

  it('catches a non-interrupt throw → empty partial + failed fragment + errors entry', async () => {
    const node = withFragment('fetch_apis', async () => {
      throw new Error('CH down');
    });
    const out = await node({}, {});
    expect(out.fragments).toHaveLength(1);
    expect(out.fragments[0].status).toBe('failed');
    expect(out.fragments[0].error).toBe('CH down');
    expect(out.errors).toEqual([expect.objectContaining({ node: 'fetch_apis', message: 'CH down' })]);
  });

  it('re-throws a GraphInterrupt so the runtime can pause', async () => {
    const node = withFragment('await_confirmation', async () => {
      throw new GraphInterrupt([{ value: 'pick', when: 'during' }]);
    });
    await expect(node({}, {})).rejects.toBeInstanceOf(GraphInterrupt);
  });

  it('concatenates onto fragments already present in the node partial', async () => {
    const node = withFragment('resolve_parties', async () => ({
      fragments: [makeFragment({ nodeId: 'resolve_parties', startedAt: Date.now(), summary: 'pre' })],
      __fragment: { summary: 'main' },
    }));
    const out = await node({}, {});
    expect(out.fragments).toHaveLength(2);
    expect(out.fragments.map((f) => f.summary)).toEqual(['pre', 'main']);
  });
});
