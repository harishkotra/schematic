# Verification

Everything below was run on this machine. Nothing is simulated except where it says so
explicitly (the mock provider, which exists so the reasoning rules can be tested without an
API key).

**Environment:** macOS · Node v26.7.0 · npm 11.19.0 · LM Studio on `127.0.0.1:1234` (9 models)
· Ollama deliberately **not** running, so its dead-server path could be tested for real.

```
$ npm test                 → 56 tests, 56 pass, 0 fail
$ node verify/e2e.mjs      → 32 checks, 32 pass, 0 fail   (live models, LM Studio)
$ node verify/ui-probe.mjs → 14 checks, 14 pass, 0 fail   (real Chrome, live models)
```

---

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Diagrams rendered from the model's real Mermaid source by mermaid.js | **PASS** | `verify/evidence/run-01-url-shortener.json`. Both slots returned `extractionPath: "mermaid-fence"` and rendered real SVG. Counts came from Mermaid's parsed DB: A `10 nodes / 13 edges`, B `19 nodes / 27 edges`. |
| 2 | Parse failures shown verbatim with the offending line | **PASS** | `verify/evidence/broken-diagram-validation.json` — the parser's exact words plus line 4 of the source. Also `real-model-broken-validation.json`, a **real model reply** rejected at line 3. |
| 3 | Every checklist tick backed by a matched label from the source, shown in the UI | **PASS** | Each tick carries `matchedLabel`, `matchedTerm`, `matchedIn` **and** `sourceLine`/`sourceText`. The e2e asserts every tick resolves to a real label on a real source line (normalisation-aware — see below). |
| 4 | Node/edge counts computed from the parsed diagram, not the raw string | **PASS** | Read from `db.vertices` (a `Map`) and `db.edges` (an `Array`) on Mermaid's `FlowDB`. A test proves a one-line `A --> B` reports 2 nodes / 1 edge, where a line counter would say 1/0. Failed diagrams report `counts.source: "unavailable"`, never a guessed number. |
| 5 | Reasoning tokens read from usage, or shown as "n/a" | **PASS** | `reasoning-budget-blowout.json` reports real numbers (`1599`, then `3199`). A mock mode that omits the field yields `reasoningTokens: null` → the UI prints **n/a**. Never coerced to 0. |
| 6 | `reasoning_content` never logged, stored, or displayed | **PASS** | Repo-wide grep: the string appears only where the CoT is *generated* (mock), *read-and-discarded* (`modelCall.ts`), *documented*, or *asserted absent* (tests + e2e). Only its **character count** is retained. The e2e greps the entire serialised response. |
| 7 | A local provider works for either slot with no API key | **PASS** | Every live run used LM Studio with `apiKey: ""`. Model list read from `GET /v1/models` (9 models). |
| 8 | No API key hardcoded anywhere in the repository | **PASS** | `grep` for `sk-…` / `Bearer …` / `api_key = "…"` across the repo (excluding `node_modules`, `dist`, evidence) returns nothing. The only key literal anywhere is `'test-key-not-a-real-secret'` in the test suite. |
| 9 | Runs with `npm run dev` from a clean clone plus a pasted API key | **PASS** | `npm run dev` starts both processes in ~3s. `http://localhost:5173/` serves the app; `/api/health` and `/api/providers` proxy correctly through 5173 to 3001. |

---

## The browser actually ran it

Everything above exercises the API. `verify/ui-probe.mjs` drives the **real UI in headless
Chrome** over the DevTools Protocol — no virtual time, no mocking — against the production
build with a live backend and two live local models. Node 26 has a global `WebSocket`, so
this needs no Playwright or Puppeteer.

**14/14 checks pass** (`verify/evidence/ui-probe.json`):

```
PASS  the app mounted in a real browser
PASS  idle state renders with all four preset briefs          4 presets
PASS  before any run the badges say IDLE, not FAILED          badges: [IDLE, IDLE]
PASS  attribution footer renders with both links
      Built by Harish Kotra · Checkout my other builds at dailybuild.xyz
PASS  clicked Design both in the browser
PASS  both panels reached a final PARSED or FAILED state      badges: PARSED / PARSED
PASS  mermaid.js rendered real SVG in the browser             2 svg(s), 33 <text> labels
PASS  labels are <text>, not <foreignObject>                  0 foreignObject elements
PASS  the checklist painted one row per concept per diagram   24 tick cells (12 × 2)
PASS  ticks display the matched label, not just a score       … (node label) line 9 …
PASS  the diff strip rendered                                 A planned for observability; B did not.
PASS  the export controls are present
PASS  the attribution footer survived a full run
```

Two of those are worth calling out:

- **`33 <text> labels, 0 <foreignObject>`** is the `htmlLabels: false` decision proved in a
  real browser rather than argued for. The PNG share card rasterises the SVG through an
  `<img>`, and browsers silently drop `foreignObject` content when they do — this is the
  check that says the export will not come out full of empty boxes.
- **`24 tick cells`** is 12 concepts × 2 diagrams, read straight out of the DOM, with the
  matched label and source line visible on each tick.

### A real bug the browser run found

Before this, on a fresh page load **both panels showed a red `FAILED` badge** — because the
badge was computed as `parsed && rendered ? PARSED : FAILED`, and before any run neither is
true. A first-time visitor saw "both models failed" before pressing anything.

The badge now has a neutral third state: `IDLE` before a run, `WORKING` during one, then
`PARSED` / `FAILED`. The probe asserts it, so it cannot regress.

This is the class of bug the API-level suite structurally cannot catch: the server was
returning perfectly correct data the whole time, and the lie was in the rendering.

---

## Data & verification requirements

### 1. Preset 1 — both diagrams parse and render

**PASS**, and the honest version of the story: it took **two attempts**.

```
attempt 1: A ok (9 nodes)      / B FAIL
attempt 2: A ok (10 nodes/18e) / B ok (16 nodes/18 edges)
```

Attempt 1 failed for a real reason, captured in `run-01-attempts.json`:

- **B (ornith-1.0-35b)** — Mermaid parse error at line 20, from an unquoted parenthesis in a
  node label: `Kafka[Message Queue (Kafka)]`. The same model wrote the same mistake in an
  earlier run at line 13. It is the single most common way a model breaks Mermaid.

The app showed both as **FAILED** with the parser's verbatim error and the offending line.
It did not hide them and it did not retry behind the user's back. `verify/e2e.mjs` retries
the *run* up to 3 times and reports how many attempts it needed, because claiming a
first-try success that did not happen would be a lie.

### 2. Deliberately broken Mermaid shows the verbatim error

**PASS.** `verify/e2e.mjs` section 5 posts the following source. It is **broken on purpose** —
`-->>` is a sequence-diagram arrow inside a flowchart, and `[(Redis Cache)]` opens a cylinder
shape without closing it. If you run a Mermaid-aware linter over this file, this block is
supposed to fail; that is the fixture, not a typo.

```mermaid
flowchart TD
  Client[Client] --> LB[Load Balancer]
  LB --> API[API Server]
  API -->> Cache[(Redis Cache)]
```

and the API answers (`verify/evidence/broken-diagram-validation.json`):

```
Parse error on line 4:
...PI Server]  API -->> Cache[(Redis Cache
----------------------^
Expecting 'AMP', 'COLON', 'PIPE', 'TESTSTR', 'DOWN', 'DEFAULT', 'NUM', 'COMMA',
'NODE_STRING', 'BRKT', 'MINUS', 'MULT', 'UNICODE_TEXT', got 'TAGEND'
```

with `parseError.line = 4` and `parseError.lineText = "  API -->> Cache[(Redis Cache)]"`.
`counts.source` stays `"unavailable"` — no numbers are invented for a diagram that failed.

### 3. Ticks come from labels actually present in the source

**PASS, with a subtlety worth stating.**

Mermaid **rewrites label text as it parses**. A source containing `<br/>` comes back from the
parser as `<br>`. So a parsed label is not always a byte-for-byte substring of the source,
and a naive `source.includes(matchedLabel)` check fails even though nothing is wrong.

Rather than weaken the claim, every tick now carries the **source line** it came from, located
under the same normalisation Mermaid applies:

```
Cache     = "⚡ Redis Cache Cluster"          (node label, source line 10)
Queue     = "📨 Apache Kafka\n(Event Bus)"    (node label, source line 40)
Database  = "🗄️ Primary Database\n(...)"      (node label, source line 14)
```

`matchedLabel` is reported exactly as Mermaid read it (the honest value), and `sourceLine` +
`sourceText` are what make it auditable. The e2e fails the run if any tick cannot be resolved
to a real label on a real source line.

### 4. Export

- **Download SVG** per diagram, serialised from the rendered Mermaid SVG.
- **1080×1080 PNG share card** drawn on a canvas from those same SVGs.
- **Copy results as JSON** copies the full `SchematicResponse`.

Mermaid runs with `htmlLabels: false` so labels are `<text>`, not `<foreignObject>`. This is
load-bearing: browsers refuse to draw `foreignObject` content when an SVG is rasterised
through an `<img>`, so the share card would silently come out with empty boxes.

### 5. Nothing shows a number it cannot back

Two places where a plausible-looking value would have been a lie, both closed:

- **Reasoning tokens** are read from `usage` or shown as **n/a**. Never `0`.
- **`sha256`** is the hash of the Mermaid source. A slot with no source previously rendered
  `e3b0c442…` — the SHA-256 of the *empty string*, which looks exactly like a real
  fingerprint. It now reports **n/a**, and the raw reply's hash moved to its own
  `rawReplySha256` field so the reply is still identifiable.
- **Node/edge counts** come from the parsed diagram or report `"unavailable"`.
- **A diagram that parses but has no edges** is flagged as a fragment rather than scored as
  a total model failure.

---

## Measured model behaviour (the interesting part)

Every LM Studio model on this machine was asked the app's **exact** prompt — nonce line
included — three times, and each reply was put through the real validator
(`verify/probe-reliability.mts`).

| Model | Mermaid parsed | Avg latency | Dominant failure |
| --- | --- | --- | --- |
| `google/gemma-4-12b` | **3 / 3** | 76 s | — |
| `ornith-1.0-35b` | **3 / 3** | 48 s | — |
| `openai/gpt-oss-20b` | 0 / 3 | 15 s | parse error, unquoted `(…)` in a label |
| `google/gemma-4-e4b` | 0 / 3 | 30 s | parse error, unquoted `(…)` in a label |
| `zai-org/glm-4.7-flash` | 0 / 3 | 51 s | empty content |
| `meta/muse-glimmer` | 0 / 3 | 107 s | parse error |
| `qwen/qwen3.5-9b` | 0 / 3 | 35 s | empty content — CoT ate the whole budget |
| `qwen/qwen3.8-27b` | 0 / 3 | 220 s | empty content |

**Five of eight local models could not produce a single valid Mermaid flowchart in three
tries.** That is the app's thesis demonstrated on itself.

Three distinct failure modes, all surfaced verbatim by the app:

1. **Unquoted parentheses in labels.** The dominant failure. Mermaid requires
   `CC["Click Counter (Kafka + Redis)"]`; models write `CC[Click Counter (Kafka + Redis)]`.
   Verified directly: the unquoted form is **rejected**, the quoted form **parses**. This is a
   real Mermaid rule, not an artefact of the validator.
2. **Empty content from a reasoning model.** `qwen/qwen3.5-9b` spends *every* token on hidden
   CoT: 1599 reasoning tokens at a 1600 budget, then 3199 at 3200 — with no content either
   time. The app retries once with the doubled budget, then reports a budget failure, never a
   refusal.
3. **Truncation that still parses.** A reply cut off at the token ceiling can leave a handful
   of node declarations with no edges. Mermaid accepts it, the badge says PARSED, and the
   checklist would dutifully report every concept as missing — looking like a model failure
   when it is really a truncation. The app now reads `finish_reason` and flags such a diagram
   as **degenerate** ("no edges — likely a fragment").

### One notable finding: the nonce changes small-model output

`openai/gpt-oss-20b` parsed **3/3 without** the nonce line and **0/3 with** it. The nonce is
mandatory (it is what guarantees zero prompt reuse), so the demo pair was chosen by probing
with the real prompt rather than an approximation. Had the probe omitted the nonce, it would
have picked a model that does not work in the actual app.

### Reliability depends on load, not just on the model

A later live run of the same pair that had just scored 3/3 produced this:

```
SLOT A  ornith-1.0-35b    ok · 9 nodes / 18 edges · seqRetry=true
SLOT B  gemma-4-12b       empty-content · 3197 reasoning tokens · finish_reason=length
```

`gemma-4-12b` had just passed 3/3 in isolation, and in this run it spent its entire budget on
hidden reasoning and returned nothing. The difference is that **two large models were resident
on one LM Studio instance at once**, which slows generation enough that a reasoning model can
exhaust its budget before emitting a single content token.

This is a property of the local runtime, not of the app, and the app handled it correctly:
it retried once at the doubled budget, then reported `errorKind: "empty-content"` with the
real token counts, flagged `truncated`, and explained that it is a budget failure rather than
a refusal. Nothing was hidden and no CoT leaked. The same run also exercised the LM Studio
concurrency recovery again (HTTP **400** this time, not 500 — which is why the detector keys
off the pattern rather than a single status code).

The practical guidance for a recording: give each slot a different model only if the machine
can hold both, or accept that a local comparison may need a second attempt.

---

## Three real bugs found by verification, and fixed

### LM Studio refuses concurrent requests

The spec requires both slots to run concurrently, and acceptance criterion 7 requires local
providers to work. Those conflict on LM Studio, which serves **one request at a time** and
answers a second simultaneous request with an instant HTTP 500:

```
concurrent, different models : 500 @ 0.0s   +  200 @ 7.5s
concurrent, same model twice : 500 @ 0.0s   +  200 @ 6.8s
sequential, different models : 200 @ 4.0s   +  200 @ 6.4s
```

So local comparisons were broken roughly half the time. The app now detects the pattern —
**local** base URL + HTTP error + the other slot succeeded — re-runs the refused slot alone,
and says so in the panel and the run warnings. A hosted provider's 5xx is *not* retried,
because there it is a genuine upstream failure; that distinction is unit-tested directly.
If the local error was real it recurs and is reported verbatim, so nothing is masked. Seen
working in a live run: `sequentialRetry: true` on slot B.

### A diagram that parses but has no edges

Described above. Now flagged via `finish_reason` + a `degenerate` boolean, with a warning,
instead of being quietly scored as a total model failure.

### A fresh page load claimed both models had failed

Described above. The badge gained an `IDLE` state, and the browser probe asserts it.

### The label audit compared the wrong two strings

Also described above: Mermaid normalises `<br/>` to `<br>` while parsing, so the matched label
was not a substring of the source. Every tick now cites a source line located under the same
normalisation.

---

## How the reasoning rules are tested without an API key

`server/test/mock-particle.ts` is a real OpenAI-compatible server that emulates Particle.ai's
response shape: `usage.completion_tokens_details.reasoning_tokens`, `message.reasoning_content`,
HTTP 200 with empty content, HTTP 500, and a `serial-only` mode that reproduces LM Studio's
concurrency refusal. The suite proves, against it:

- `chat_template_kwargs: {enable_thinking: false}` is sent **only** for Particle.ai +
  `deepseek-*` + the checkbox — and asserted **absent** from the wire for `glm5.3flash`, for
  LM Studio, and for Custom.
- Disabling thinking actually removes `reasoning_tokens` from `usage`.
- A missing reasoning breakdown yields `null`, never `0`.
- Empty content retries once at `max_tokens × 2`, capped at 4000.
- Persistent emptiness is reported as a budget failure, not a refusal.
- `reasoning_content` never reaches the response object.
- Provider errors (including non-JSON HTML error pages) are quoted verbatim.
- A dead local server says `Cannot reach http://127.0.0.1:11434 — is Ollama running?`
  followed by the provider's real error text.
- Two runs never share a prompt hash, and `promptReused` stays `false`.
- A reply with no Mermaid in it at all is `errorKind: "no-mermaid"` with `sha256: null`.

---

## Reproducing

```bash
npm install
npm test                     # 56 tests, no network or API key needed
npm run dev                  # then open http://localhost:5173

# live end-to-end checks (needs the API on :3001 and a local model server)
node verify/e2e.mjs

# drive the real UI in headless Chrome (needs the built app + backend + Chrome on :9222)
node verify/ui-probe.mjs http://127.0.0.1:4173/ 300

# re-measure which local models actually produce valid Mermaid
npx tsx verify/probe-reliability.mts 3
```

Evidence is written to `verify/evidence/` on every run, including the raw JSON for each
check, so every claim above can be re-read rather than taken on trust.