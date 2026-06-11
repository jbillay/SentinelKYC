// NVIDIA-hosted NIM provider (build.nvidia.com — no container, just an nvapi-… key).
//
//   { id, ocr({ imageBytes, model, baseUrl, apiKey, ocrEndpoint }),
//        chatStructured({ input, schema, prompt, model, temperature, baseUrl, apiKey, structuredMethod }),
//        health({ task, model, baseUrl, apiKey, ocrEndpoint }) }
//
// Reasoning: meta/llama-3.1-8b-instruct via @langchain/openai's ChatOpenAI against
// configuration.baseURL = https://integrate.api.nvidia.com/v1 (langchainjs quirk —
// the base URL must be nested under `configuration`, not a top-level field).
// withStructuredOutput's method is configurable (functionCalling default; jsonMode
// fallback if NIM tool-calling misbehaves). The extract.json_strict_retry wrapper
// lives in ../index.js so this provider gets it for free.
//
// OCR: NeMo Retriever OCR v2 (nvidia/nemoretriever-ocr-v2) — a dedicated OCR NIM, not
// a chat model. POST to NVIDIA_OCR_ENDPOINT (the CV /v1/infer URL, e.g.
// https://ai.api.nvidia.com/v1/cv/nvidia/nemoretriever-ocr-v2) with a base64 data-URI
// image; response is text detections + polygon bounding boxes + confidences, which we
// flatten into the reading-order text string the extractors already expect — so nothing
// downstream of ocrPage() changes. Handles the NVCF 202-poll pattern transparently.
//
// No cross-provider fallback — if NVIDIA is unreachable the run fails loudly.
const { ChatOpenAI } = require('@langchain/openai');
const { Agent, fetch: undiciFetch } = require('undici');

// Generous timeouts — NIM is fast, but a slow generation shouldn't get cut off.
const longTimeoutAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 30 * 1000,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  pipelining: 0,
});

const longFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: longTimeoutAgent });

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// --- OCR ---------------------------------------------------------------------

// build.nvidia.com CV/NVCF endpoints accept a base64 image inline only up to a
// payload limit; larger images must go through the NVCF asset-upload flow (not
// implemented — POC raster scale 1.5 stays well under it). If a future raster
// blows past this, the API returns 413 and we surface an actionable error.
const NVCF_POLL_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

function confidenceFloor() {
  const v = Number(process.env.NVIDIA_OCR_CONFIDENCE_MIN);
  return Number.isFinite(v) ? v : 0; // permissive by default
}

function mergeLevel() {
  const v = String(process.env.NVIDIA_OCR_MERGE_LEVEL || 'paragraph').toLowerCase();
  return ['word', 'sentence', 'paragraph'].includes(v) ? v : 'paragraph';
}

// Each detection's bounding_box.points is a polygon of {x,y} in 0..1 image space.
function detectionTop(d) {
  const pts = d?.bounding_box?.points || [];
  return pts.length ? Math.min(...pts.map((p) => Number(p.y) || 0)) : 0;
}
function detectionLeft(d) {
  const pts = d?.bounding_box?.points || [];
  return pts.length ? Math.min(...pts.map((p) => Number(p.x) || 0)) : 0;
}

// Flatten one image's text_detections to reading-order text: group detections into
// rough lines (top within ~1.5% of image height), order lines top→bottom and
// detections left→right within a line, drop anything below the confidence floor.
function flattenDetections(detections) {
  const floor = confidenceFloor();
  const kept = (detections || [])
    .filter((d) => (Number(d?.text_prediction?.confidence) ?? 0) >= floor)
    .map((d) => ({ text: String(d?.text_prediction?.text ?? '').trim(), top: detectionTop(d), left: detectionLeft(d) }))
    .filter((d) => d.text.length > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  for (const d of kept) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(d.top - last.top) < 0.015) {
      last.items.push(d);
    } else {
      lines.push({ top: d.top, items: [d] });
    }
  }
  return lines
    .map((line) =>
      line.items
        .sort((a, b) => a.left - b.left)
        .map((d) => d.text)
        .join(' ')
    )
    .join('\n')
    .trim();
}

async function pollNvcf(reqId, apiKey) {
  // NVCF async pattern: poll until 200 (or non-202). Generous overall budget.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await longFetch(`${NVCF_POLL_URL}/${reqId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 202) continue;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`NVIDIA OCR poll failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }
    return res.json();
  }
  throw new Error(`NVIDIA OCR poll timed out (reqId=${reqId})`);
}

async function ocr({ imageBytes, model, apiKey, ocrEndpoint }) {
  if (!apiKey) throw new Error('NVIDIA OCR provider: NVIDIA_API_KEY is not set');
  if (!ocrEndpoint) {
    throw new Error(
      'NVIDIA OCR provider: NVIDIA_OCR_ENDPOINT is not set — point it at the nemoretriever-ocr-v2 ' +
        'CV /v1/infer URL (see build.nvidia.com → nemoretriever-ocr → Deploy / API).'
    );
  }

  const b64 = Buffer.from(imageBytes).toString('base64');
  const body = {
    input: [{ type: 'image_url', url: `data:image/png;base64,${b64}` }],
    merge_levels: [mergeLevel()],
  };

  const res = await longFetch(ocrEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  let payload;
  if (res.status === 202) {
    const reqId = res.headers.get('nvcf-reqid') || res.headers.get('NVCF-REQID');
    if (!reqId) throw new Error('NVIDIA OCR: got HTTP 202 but no NVCF-REQID header to poll');
    payload = await pollNvcf(reqId, apiKey);
  } else if (res.status === 413) {
    throw new Error(
      'NVIDIA OCR: image too large for inline base64 (HTTP 413). Lower the raster scale in ' +
        'processDocuments.js, or implement the NVCF asset-upload path.'
    );
  } else if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`NVIDIA OCR (${model}) failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 400)}` : ''}`);
  } else {
    payload = await res.json();
  }

  const first = Array.isArray(payload?.data) ? payload.data[0] : payload;
  return flattenDetections(first?.text_detections);
}

// --- Reasoning ---------------------------------------------------------------

async function chatStructured({
  input,
  schema,
  prompt,
  model,
  temperature = 0,
  baseUrl,
  apiKey,
  signal,
  structuredMethod = 'functionCalling',
}) {
  if (!apiKey) throw new Error('NVIDIA reasoning provider: NVIDIA_API_KEY is not set');

  const chat = new ChatOpenAI({
    model,
    apiKey,
    temperature,
    timeout: 10 * 60 * 1000,
    // langchainjs quirk: the OpenAI-compatible base URL must be nested here.
    configuration: { baseURL: baseUrl, fetch: longFetch },
  });

  const userMessage = `${prompt}\n\n--- INPUT ---\n${input}\n--- END INPUT ---`;
  // signal: per-call timeout/abort from ../index.js (CODE_REVIEW §4.5).
  return chat
    .withStructuredOutput(schema, { method: structuredMethod })
    .invoke(userMessage, signal ? { signal } : undefined);
}

// --- Health ------------------------------------------------------------------

async function health({ task, model, baseUrl, apiKey, ocrEndpoint }) {
  if (!apiKey) return { ok: false, model: model || null, detail: 'no api key' };

  if (task === 'ocr') {
    if (!ocrEndpoint) return { ok: false, model: model || null, detail: 'NVIDIA_OCR_ENDPOINT not set' };
    const origin = hostOf(ocrEndpoint);
    if (!origin) return { ok: false, model: model || null, detail: 'NVIDIA_OCR_ENDPOINT is not a valid URL' };
    try {
      // Just probe the host is reachable + the key is shaped right; a real /v1/infer
      // call needs an image, so reachability + key presence is the bar (per P3).
      await undiciFetch(origin, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${apiKey}` },
        dispatcher: new Agent({ headersTimeout: 4000, bodyTimeout: 4000, connectTimeout: 4000 }),
      });
      return { ok: true, model: model || null, detail: 'reachable' };
    } catch (err) {
      return { ok: false, model: model || null, detail: err.cause?.code || err.message || 'unreachable' };
    }
  }

  // reasoning task — cheap /models reachability + best-effort catalog membership.
  const url = `${trimSlash(baseUrl) || 'https://integrate.api.nvidia.com/v1'}/models`;
  try {
    const res = await undiciFetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      dispatcher: new Agent({ headersTimeout: 4000, bodyTimeout: 4000, connectTimeout: 4000 }),
    });
    if (!res.ok) {
      return { ok: false, model: model || null, detail: `HTTP ${res.status}` };
    }
    let listed;
    try {
      const data = await res.json();
      const ids = (data?.data || []).map((m) => m.id);
      listed = model ? ids.includes(model) : undefined;
    } catch {
      listed = undefined;
    }
    return {
      ok: true,
      model: model || null,
      detail: listed === false ? 'reachable (model not in catalog list)' : 'reachable',
    };
  } catch (err) {
    return { ok: false, model: model || null, detail: err.cause?.code || err.message || 'unreachable' };
  }
}

module.exports = { id: 'nvidia', ocr, chatStructured, health };
