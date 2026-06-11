// SSE runtime + run-thread registry.
//
// This module owns the in-memory state for every active LangGraph thread:
// buffered SSE events, the live `res` stream (if any), per-thread bookkeeping
// for cancellation / interrupt / persistence, and the lazy dossier+run row
// creation. The Express layer talks to it via the RunRegistry class — there
// are no module-level mutable maps any more. See CODE_REVIEW §4.1.
const { Command } = require('@langchain/langgraph');
const repo = require('../db/repo');
const { buildScreeningReport } = require('../services/screening/report');
const { InMemorySink } = require('../services/eventSink');
const { log } = require('../services/log');

// SSE backpressure + thread lifecycle constants.
//
// - MAX_BUFFERED_EVENTS caps per-thread `events` array so a long-running run
//   with no live consumer doesn't grow without bound. Replay falls behind
//   (older events drop) but that's strictly better than OOM.
// - THREAD_GC_DELAY_MS keeps a terminated thread in memory briefly so a
//   late-arriving GET /api/stream/:threadId can still replay the tail
//   (frontend reconnect on transient network blips). After that, deleted.
// - THREAD_HARD_TIMEOUT_MS reaps any thread that has been running for an
//   absurd length of time — defensive guard against an abandoned run that
//   never reaches a terminus.
// (The per-thread buffer cap now lives in services/eventSink.js InMemorySink.)
const THREAD_GC_DELAY_MS = 5 * 60_000; // 5 min after terminus
const THREAD_HARD_TIMEOUT_MS = 2 * 60 * 60_000; // 2 h
const HARD_REAP_INTERVAL_MS = 10 * 60_000;

function createThreadState() {
  return {
    events: [],
    sseRes: null,
    lastTraceLen: 0,
    lastErrorLen: 0,
    lastFragmentLen: 0,
    lastScreeningHitLen: 0,
    lastScreeningEvalLen: 0,
    qaResultPersisted: false,
    qaNarrativePersisted: false,
    latestState: null,
    interrupted: false,
    interruptKind: null,
    runId: null,
    dossierId: null,
    companyNumber: null,
    companyName: null,
    runClosed: false,
    cancelled: false,
    trigger: 'initial',
    lastInput: null,
    startedAt: Date.now(),
    pendingFragments: [],
    gcTimer: null,
    caseStatus: null,
    workerId: null,
    workerStamped: false,
  };
}

class RunRegistry {
  constructor() {
    this.threads = new Map();
    this._hardReapTimer = null;
    // Default sink: in-process buffer + live res (inline mode). The worker
    // process swaps in a NotifySink at boot via setSink().
    this.sink = new InMemorySink();
  }

  setSink(sink) {
    this.sink = sink;
  }

  // Await any pending async event delivery for a thread (NotifySink). No-op
  // for the in-memory sink. Called at every run terminus so a process can
  // guarantee the terminal event is persisted before it stops.
  async drainSink(threadId) {
    try {
      await this.sink.drain(threadId);
    } catch (err) {
      log.error(`[sink] drain failed: ${err.message}`);
    }
  }

  ensure(threadId) {
    if (!this.threads.has(threadId)) {
      this.threads.set(threadId, createThreadState());
    }
    return this.threads.get(threadId);
  }

  has(threadId) {
    return this.threads.has(threadId);
  }

  get(threadId) {
    return this.threads.get(threadId) || null;
  }

  delete(threadId) {
    this.threads.delete(threadId);
  }

  entries() {
    return this.threads.entries();
  }

  pushEvent(threadId, event) {
    const t = this.ensure(threadId);
    // Delegate to the installed sink. InMemorySink buffers + writes to the live
    // res (inline mode); NotifySink persists to run_events + NOTIFY so the web
    // process can replay across the worker boundary (queue mode).
    this.sink.write(threadId, t, event);
  }

  // Lazy dossier + run persistence. Triggered on the first chunk that carries
  // companyNumber on state. Buffered fragments are flushed in one batch.
  async ensureRunPersisted(threadId, { companyNumber, companyName } = {}) {
    const t = this.ensure(threadId);
    if (t.runId) return t.runId;
    const cn = companyNumber || t.companyNumber;
    if (!cn) return null;

    try {
      const dossier = await repo.upsertDossier({ companyNumber: cn, companyName: companyName || null });
      t.dossierId = dossier.id;
      t.companyNumber = cn;
      let run;
      try {
        run = await repo.createRun({
          dossierId: dossier.id,
          threadId,
          trigger: t.trigger,
        });
      } catch (err) {
        // runs_one_running_per_dossier conflict: another run is already
        // executing for this dossier (start-by-name races bypass the route
        // pre-check because the company isn't known until now). Without this
        // branch the graph would keep executing as a ghost — full LLM cost,
        // zero persistence, zero audit trail. Cancel the thread instead and
        // rethrow so runGraph stops the stream. See CODE_REVIEW §4.1.
        if (err?.code === '23505' && /runs_one_running_per_dossier/.test(err?.message || err?.detail || '')) {
          t.cancelled = true;
          this.pushEvent(threadId, {
            type: 'error',
            node: 'run',
            ts: Date.now(),
            message: `a run is already in progress for company ${cn} — this run was stopped`,
          });
          this.pushEvent(threadId, {
            type: 'cancelled',
            node: 'run',
            ts: Date.now(),
            msg: 'duplicate run cancelled (one running run per dossier)',
          });
          const dup = new Error(`duplicate concurrent run for dossier ${cn}`);
          dup.code = 'run_in_progress';
          throw dup;
        }
        throw err;
      }
      t.runId = run.id;

      if (t.pendingFragments.length) {
        const batch = t.pendingFragments.map((buf) => ({ ...buf, runId: t.runId }));
        t.pendingFragments = [];
        try {
          await repo.appendFragmentsBatch(batch);
        } catch (err) {
          log.error(`[run] flush fragments (batch) failed: ${err.message}`);
          for (const row of batch) {
            try {
              await repo.appendFragment(row);
            } catch (perRowErr) {
              log.error(`[run] flush fragment (fallback) failed: ${perRowErr.message}`);
            }
          }
        }
      }
      return t.runId;
    } catch (err) {
      // Duplicate-run cancellation must propagate so emitDelta/runGraph stop
      // the graph; everything else stays best-effort (persistence failures
      // shouldn't kill a run mid-flight).
      if (err.code === 'run_in_progress') throw err;
      log.error(`[run] ensureRunPersisted failed: ${err.message}`);
      return null;
    }
  }

  // Schedule a thread for removal from the Map after a grace period.
  // Idempotent: re-scheduling clears the previous timer.
  scheduleGc(threadId, delayMs = THREAD_GC_DELAY_MS) {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (t.gcTimer) clearTimeout(t.gcTimer);
    t.gcTimer = setTimeout(() => {
      const cur = this.threads.get(threadId);
      if (!cur) return;
      if (cur.sseRes) {
        cur.gcTimer = null;
        return;
      }
      this.threads.delete(threadId);
    }, delayMs);
    if (typeof t.gcTimer.unref === 'function') t.gcTimer.unref();
  }

  // Hard-reap loop: catches abandoned threads that never reached a terminus
  // (e.g. server crashed mid-run and was restarted, leaving an in-memory
  // thread that nothing will ever finish). Cheap.
  startHardReap() {
    if (this._hardReapTimer) return;
    this._hardReapTimer = setInterval(() => {
      const now = Date.now();
      for (const [threadId, t] of this.threads.entries()) {
        if (t.runClosed || t.cancelled) continue;
        if (now - (t.startedAt || now) > THREAD_HARD_TIMEOUT_MS) {
          log.warn(`[threads] hard-reaping abandoned thread ${threadId}`);
          if (t.sseRes) {
            try { t.sseRes.end(); } catch { /* noop */ }
            t.sseRes = null;
          }
          this.threads.delete(threadId);
        }
      }
    }, HARD_REAP_INTERVAL_MS);
    if (typeof this._hardReapTimer.unref === 'function') this._hardReapTimer.unref();
  }

  // For introspection (GET /api/runs/active).
  activeSnapshot() {
    const active = [];
    for (const [threadId, t] of this.threads.entries()) {
      if (t.cancelled || t.runClosed) continue;
      let phase = 'running';
      if (t.interrupted) {
        phase = t.interruptKind === 'final_decision' ? 'awaiting_decision' : 'needs_user_pick';
      }
      const candidates = t.latestState?.candidates || [];
      const resolution = t.latestState?.resolution || null;
      const isFinalDecision = phase === 'awaiting_decision';
      active.push({
        threadId,
        phase,
        startedAt: t.startedAt,
        companyNumber: t.companyNumber || null,
        companyName: t.companyName || null,
        lastInput: t.lastInput || null,
        candidates: phase === 'needs_user_pick' ? candidates : [],
        resolution: phase === 'needs_user_pick' ? resolution : null,
        trigger: t.trigger,
        // Final-decision pauses survive page reloads: the Run page needs
        // runId + qaResult + kycCard to mount the decision panel before any
        // new SSE event arrives.
        runId: isFinalDecision ? t.runId || null : null,
        qaResult: isFinalDecision ? t.latestState?.qaResult || null : null,
        qaNarrative: isFinalDecision ? t.latestState?.qaNarrative || null : null,
        kycCard: isFinalDecision ? t.latestState?.kycCard || null : null,
      });
    }
    active.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    return active;
  }
}

const registry = new RunRegistry();

// Derivative: turn each chunk's state delta into SSE events + persistence
// writes. Single-writer for dossier+run rows (lazy creation), fragments
// (batched insert), screening hits/evaluations, and the QA result.
async function emitDelta(threadId, chunk) {
  const t = registry.ensure(threadId);
  t.latestState = chunk;

  const trace = chunk.trace || [];
  if (trace.length > t.lastTraceLen) {
    for (let i = t.lastTraceLen; i < trace.length; i++) {
      registry.pushEvent(threadId, { type: 'trace', ...trace[i] });
    }
    t.lastTraceLen = trace.length;
  }

  const errors = chunk.errors || [];
  if (errors.length > t.lastErrorLen) {
    for (let i = t.lastErrorLen; i < errors.length; i++) {
      registry.pushEvent(threadId, { type: 'error', ...errors[i] });
    }
    t.lastErrorLen = errors.length;
  }

  // Lazy dossier+run creation: triggered by the first appearance of
  // companyNumber on state.
  if (chunk.companyNumber && !t.runId) {
    const companyName =
      chunk.profile?.company_name ||
      chunk.candidates?.find((c) => c.companyNumber === chunk.companyNumber)?.title ||
      null;
    if (companyName) t.companyName = companyName;
    await registry.ensureRunPersisted(threadId, {
      companyNumber: chunk.companyNumber,
      companyName,
    });
  }

  // R2: stamp the driving worker once the run row exists (queue mode only —
  // t.workerId is null inline). Observability + boot-reconciliation liveness.
  if (t.workerId && t.runId && !t.workerStamped) {
    t.workerStamped = true;
    try {
      await repo.setRunWorker(t.runId, t.workerId);
    } catch (err) {
      log.warn(`[run] setRunWorker failed: ${err.message}`);
    }
  }

  if (t.companyNumber && chunk.profile?.company_name) {
    t.companyName = chunk.profile.company_name;
    try {
      await repo.updateDossierMeta(t.companyNumber, {
        companyName: chunk.profile.company_name,
      });
    } catch {
      // best-effort
    }
  }

  const fragments = chunk.fragments || [];
  if (fragments.length > t.lastFragmentLen) {
    const batchToPersist = [];
    for (let i = t.lastFragmentLen; i < fragments.length; i++) {
      const f = fragments[i];
      const sequence = i;
      registry.pushEvent(threadId, {
        type: 'fragment',
        ts: Date.now(),
        fragment: { ...f, sequence },
      });
      const persisted = {
        id: f.id,
        parentFragmentId: f.parentFragmentId ?? null,
        nodeId: f.nodeId,
        sequence,
        kind: f.kind,
        status: f.status,
        startedAt: f.startedAt,
        durationMs: f.durationMs,
        summary: f.summary,
        inputs: f.inputs,
        outputs: f.outputs,
        error: f.error,
      };
      if (t.runId) batchToPersist.push({ runId: t.runId, ...persisted });
      else t.pendingFragments.push(persisted);
    }
    if (batchToPersist.length) {
      try {
        await repo.appendFragmentsBatch(batchToPersist);
      } catch (err) {
        log.error(`[run] appendFragmentsBatch failed: ${err.message}`);
        for (const row of batchToPersist) {
          try {
            await repo.appendFragment(row);
          } catch (perRowErr) {
            log.error(`[run] appendFragment fallback failed: ${perRowErr.message}`);
          }
        }
      }
    }
    t.lastFragmentLen = fragments.length;
  }

  const screeningHits = chunk.screeningHits || [];
  if (screeningHits.length > t.lastScreeningHitLen) {
    for (let i = t.lastScreeningHitLen; i < screeningHits.length; i++) {
      const h = screeningHits[i];
      registry.pushEvent(threadId, { type: 'screening_hit', ts: Date.now(), hit: h });
      if (t.runId) {
        try {
          await repo.appendScreeningHit({
            id: h.hitId,
            runId: t.runId,
            // Phase 2: forward party_id when screen_* attached one.
            partyId: h.partyId ?? null,
            subjectId: h.subjectId,
            subjectName: h.subjectName,
            subjectKind: h.subjectKind,
            subjectSource: h.subjectSource,
            listSource: h.listSource,
            listEntryId: h.listEntryId ?? null,
            matchScore: h.matchScore == null ? null : h.matchScore,
            matchedFields: h.matchedFields ?? null,
            rawEntry: h.rawEntry ?? {},
          });
        } catch (err) {
          log.error(`[run] appendScreeningHit failed: ${err.message}`);
        }
      }
    }
    t.lastScreeningHitLen = screeningHits.length;
  }

  const screeningEvals = chunk.screeningEvaluations || [];
  if (screeningEvals.length > t.lastScreeningEvalLen) {
    for (let i = t.lastScreeningEvalLen; i < screeningEvals.length; i++) {
      const ev = screeningEvals[i];
      registry.pushEvent(threadId, {
        type: 'screening_hit_evaluated',
        ts: Date.now(),
        hitId: ev.hitId,
        decision: ev.decision,
        llmScore: ev.llmScore,
        fragmentId: ev.fragmentId,
      });
      if (t.runId) {
        try {
          await repo.appendScreeningEvaluation({
            hitId: ev.hitId,
            decision: ev.decision,
            category: ev.category ?? null,
            severity: ev.severity ?? null,
            llmReasoning: ev.llmReasoning,
            llmScore: ev.llmScore == null ? null : ev.llmScore,
            fragmentId: ev.fragmentId ?? null,
            humanOverride: ev.humanOverride ?? null,
            overrideReason: ev.overrideReason ?? null,
          });
        } catch (err) {
          log.error(`[run] appendScreeningEvaluation failed: ${err.message}`);
        }
      }
    }
    t.lastScreeningEvalLen = screeningEvals.length;
  }

  if (chunk.qaResult && !t.qaResultPersisted && t.runId && t.companyNumber) {
    try {
      // mirrorCaseStatus: false — the case_status flip is the human reviewer's
      // job, made through the await_decision interrupt. QA just records its
      // routing recommendation on the run.
      await repo.finalizeRunQa(
        t.runId,
        t.companyNumber,
        chunk.qaResult,
        { mirrorCaseStatus: false },
      );
    } catch (err) {
      log.error(`[run] finalizeRunQa failed: ${err.message}`);
    }
    t.qaResultPersisted = true;
  }

  // qaNarrative lands one node after qa_check; persist it to runs.qa_narrative
  // off the same chunk channel as qaResult. Single-writer, latch-once per
  // thread to avoid re-writes on subsequent deltas.
  if (chunk.qaNarrative && !t.qaNarrativePersisted && t.runId) {
    try {
      await repo.setRunQaNarrative(t.runId, chunk.qaNarrative);
    } catch (err) {
      log.error(`[run] setRunQaNarrative failed: ${err.message}`);
    }
    t.qaNarrativePersisted = true;
  }
}

// Stream a LangGraph compiled graph, fan its state deltas into SSE events,
// close the run row at terminus (interrupt / cancel / done / error).
async function runGraph(threadId, inputOrCommand, opts = {}) {
  const {
    forceFresh = false,
    autoResume = null,
    graph,
    workerId = null,
  } = opts;
  if (!graph) throw new Error('runGraph: opts.graph is required');
  const t = registry.ensure(threadId);
  if (workerId) t.workerId = workerId;

  const emitProgress = (payload) => {
    const promoted = payload && typeof payload === 'object' && payload.kind
      ? { type: payload.kind, ts: Date.now(), ...payload }
      : { type: 'progress', ts: Date.now(), ...(payload || {}) };
    registry.pushEvent(threadId, promoted);
  };

  const configurable = {
    thread_id: threadId,
    emitProgress,
    forceFresh,
    threadId,
    dossierId: t.dossierId ?? null,
    runId: t.runId ?? null,
  };
  const config = { configurable };
  const syncIds = () => {
    if (t.dossierId && configurable.dossierId !== t.dossierId) configurable.dossierId = t.dossierId;
    if (t.runId && configurable.runId !== t.runId) configurable.runId = t.runId;
  };

  try {
    const stream = await graph.stream(inputOrCommand, { ...config, streamMode: 'values' });
    for await (const chunk of stream) {
      await emitDelta(threadId, chunk);
      syncIds();
    }

    const snapshot = await graph.getState(config);
    const interrupts = snapshot?.tasks?.flatMap((task) => task.interrupts || []) || [];
    if (interrupts.length > 0) {
      t.interrupted = true;
      if (autoResume) {
        return runGraph(threadId, new Command({ resume: autoResume }), { forceFresh, graph, workerId });
      }
      // Identify which node interrupted us by inspecting the snapshot tasks.
      // Two interrupt nodes exist: await_confirmation (entity-selection pause)
      // and await_decision (post-QA reviewer pause). The kind drives the SSE
      // shape so the frontend can render the right panel.
      const interruptedTask = (snapshot?.tasks || []).find(
        (task) => Array.isArray(task.interrupts) && task.interrupts.length > 0,
      );
      const node = interruptedTask?.name || 'await_confirmation';
      const kind = node === 'await_decision' ? 'final_decision' : 'entity_selection';
      const last = interrupts[interrupts.length - 1];
      t.interruptKind = kind;
      // For the final-decision pause the run id has already been persisted
      // (qa_check runs late in the graph). Inject it into the SSE payload so
      // the Run page can POST to /api/dossiers/:cn/runs/:runId/decision
      // without having to fetch the dossier first.
      const payload =
        kind === 'final_decision'
          ? { ...(last.value || {}), runId: t.runId || null }
          : last.value;
      registry.pushEvent(threadId, {
        type: 'interrupt',
        node,
        kind,
        ts: Date.now(),
        msg: kind === 'final_decision' ? 'awaiting reviewer decision' : 'awaiting user pick',
        payload,
      });
      // Persist the interrupt event before returning so a web reconnect (queue
      // mode) can replay the pause from run_events.
      await registry.drainSink(threadId);
    } else {
      t.interrupted = false;
      if (t.cancelled) return;
      const finalState = t.latestState || {};
      const resolutionStatus = finalState.resolution?.status;
      let runStatus = 'done';
      if (resolutionStatus === 'not_found') runStatus = 'not_found';
      else if (resolutionStatus === 'needs_more_info') runStatus = 'failed';

      if (t.runId && !t.runClosed) {
        try {
          await repo.closeRun(t.runId, {
            status: runStatus,
            finalKycCard: finalState.kycCard || null,
            finalShareholderGraph: finalState.shareholderGraph || null,
            finalDocuments: finalState.documents || null,
            finalScreeningReport: finalState.screeningReport || null,
            finalRiskAssessment: finalState.riskAssessment || null,
            finalProfile: finalState.profile || null,
            finalOfficers: finalState.officers || null,
            finalPsc: finalState.psc || null,
          });
          t.runClosed = true;
        } catch (err) {
          log.error(`[run] closeRun failed: ${err.message}`);
        }
      }

      // case_status on the dossier is now flipped exclusively by applyDecision
      // (inside the /decision endpoint, before this resume runs). Re-read it
      // here so the `done` SSE event reflects the human decision rather than
      // the QA-routed recommendation that no longer mirrors to the dossier.
      let dossierCaseStatus = null;
      if (t.companyNumber) {
        try {
          const dossier = await repo.getDossier(t.companyNumber);
          dossierCaseStatus = dossier?.caseStatus || null;
        } catch (err) {
          log.warn(`[run] dossier reread for done event failed: ${err.message}`);
        }
      }

      registry.pushEvent(threadId, {
        type: 'done',
        ts: Date.now(),
        node: '__end__',
        msg: 'graph complete',
        state: {
          companyNumber: finalState.companyNumber,
          resolution: finalState.resolution,
          kycCard: finalState.kycCard,
          shareholderGraph: finalState.shareholderGraph,
          documents: finalState.documents,
          profile: finalState.profile,
          screeningReport: finalState.screeningReport,
          riskAssessment: finalState.riskAssessment,
          qaResult: finalState.qaResult,
          qaNarrative: finalState.qaNarrative,
          caseStatus: dossierCaseStatus,
          runId: t.runId,
          dossierId: t.dossierId,
        },
      });
      await registry.drainSink(threadId);
      registry.scheduleGc(threadId);
    }
  } catch (err) {
    if (t.cancelled) {
      log.warn(`[run] error during cancellation (suppressed for UI): ${err.message}`);
      await registry.drainSink(threadId);
      registry.scheduleGc(threadId);
      return;
    }
    registry.pushEvent(threadId, {
      type: 'error',
      node: 'graph',
      ts: Date.now(),
      message: err.message,
    });
    if (t.runId && !t.runClosed) {
      try {
        await repo.closeRun(t.runId, { status: 'failed', error: err.message });
        t.runClosed = true;
      } catch (closeErr) {
        log.error(`[run] closeRun (error path) failed: ${closeErr.message}`);
      }
    }
    await registry.drainSink(threadId);
    registry.scheduleGc(threadId);
  }
}

// Re-derive runs.final_screening_report after an override flip. Shared by
// the screening route handler; lives here so the SSE writer's persistence
// neighbours can reuse it if needed.
async function rebuildScreeningReport(run) {
  const detail = await repo.getRunScreening(run.id);
  const priorReport = run.finalScreeningReport || {};
  const subjects = (priorReport.perSubject || []).map((p) => ({
    id: p.subjectId,
    name: p.name,
    kind: p.kind,
    source: p.source,
  }));
  const hitsForReport = detail.hits.map((h) => ({
    hitId: h.id,
    subjectId: h.subjectId,
    listSource: h.listSource,
  }));
  return buildScreeningReport({ subjects, hits: hitsForReport, evaluations: detail.evaluations });
}

module.exports = {
  registry,
  emitDelta,
  runGraph,
  rebuildScreeningReport,
};
