// P1 R7 — structured logging (pino).
//
// One root logger per process. JSON to stdout by default; set LOG_PRETTY=true
// for human-readable dev output (pino-pretty must be installed — it is a dev
// dependency). LOG_LEVEL defaults to 'info'.
//
// `processKind` distinguishes web vs worker lines when both write to the same
// terminal/file: index.js calls setProcessKind('web'), worker.js 'worker'.
// childLogger({ runId, threadId, nodeId, ... }) is the per-run context hook —
// withFragment uses it so every node line carries its identity.
//
// No log shipping infra (POC). scripts/*-smoke.js and eval/ keep console.* —
// they are CLIs and pretty output is the point.

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const pretty = String(process.env.LOG_PRETTY || '').toLowerCase() === 'true';

const logger = pino({
  level,
  base: { pid: process.pid },
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid' },
        },
      }
    : {}),
});

let bound = logger;

// Stamp the process kind once at boot; all subsequent childLogger() calls
// inherit it. Returns the rebased root so boot code can use it directly.
function setProcessKind(kind) {
  bound = logger.child({ processKind: kind });
  return bound;
}

function getLogger() {
  return bound;
}

function childLogger(bindings = {}) {
  return bound.child(bindings);
}

// Call-time delegation so modules that `require` this before setProcessKind()
// runs at boot still emit lines carrying processKind.
const log = {
  debug: (...a) => bound.debug(...a),
  info: (...a) => bound.info(...a),
  warn: (...a) => bound.warn(...a),
  error: (...a) => bound.error(...a),
  child: (b) => bound.child(b),
};

module.exports = { logger, getLogger, setProcessKind, childLogger, log };
