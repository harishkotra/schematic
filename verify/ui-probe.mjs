/**
 * Drives the real Schematic UI in headless Chrome over the DevTools Protocol.
 *
 * This is the one thing the rest of the suite cannot prove: that the browser app,
 * given a live backend and two local models, actually runs a comparison, renders both
 * SVGs, paints the checklist, and shows the attribution. It seeds localStorage with
 * LM Studio slots (no API key needed) so the run is fully local.
 *
 * Node 26 has a global WebSocket, so no CDP library is required.
 *
 *   node verify/ui-probe.mjs [url] [timeoutSeconds]
 */

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:4173/';
const RUN_TIMEOUT_S = Number(process.argv[3] ?? 300);
const CDP_PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* Chrome not up yet */
    }
    await sleep(500);
  }
  throw new Error(`no CDP page target on port ${CDP_PORT}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page threw: ${res.exceptionDetails.text} ${res.result?.description ?? ''}`);
    }
    return res.result?.value;
  }
}

const SEED = {
  brief: 'a URL shortener at 10M clicks/day',
  slotA: {
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    model: 'ornith-1.0-35b',
    temperature: 0,
    maxTokens: 1600,
    disableReasoning: false,
  },
  slotB: {
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    model: 'google/gemma-4-12b',
    temperature: 0,
    maxTokens: 1600,
    disableReasoning: false,
  },
};

/** Poll an expression until it returns truthy. Reloads are async; never assume. */
async function waitFor(cdp, expression, timeoutMs = 30_000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return true;
    } catch {
      /* context may be mid-navigation */
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const page = await findPageTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const cdp = new Cdp(ws);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

console.log('═══ Browser UI run: real Chrome, real backend, real local models ═══\n');

// Seed config, then reload so the app boots with LM Studio slots (no API key).
await cdp.send('Page.navigate', { url: URL_UNDER_TEST });
// Wait for a real mount before touching localStorage, or the write races the load.
await waitFor(cdp, `!!document.querySelector('.site-footer')`, 30_000, 'first mount');
await cdp.evaluate(
  `localStorage.setItem('schematic.config.v1', ${JSON.stringify(JSON.stringify(SEED))}); true`,
);

// Reload so the seeded config is what the app boots with. Page.reload is async, so wait
// for the DOM to actually come back before asserting anything about it.
await cdp.send('Page.reload', { ignoreCache: false });
await sleep(600);
await waitFor(cdp, `document.readyState === 'complete' && !!document.querySelector('.site-footer')`, 30_000, 'remount after reload');
// Wait for an idle, clickable run button. Log what the app is doing meanwhile: a
// previous run may still be settling, and that is worth seeing rather than guessing at.
{
  const deadline = Date.now() + 120_000;
  let sawIdle = false;
  while (Date.now() < deadline) {
    const st = await cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
      return {
        run: btns.find((b) => /Design both|Working/i.test(b)) ?? null,
        badges: [...document.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
      };
    })()`).catch(() => null);
    if (st) {
      console.log(`    state: run="${st.run}" badges=[${st.badges.join(', ')}]`);
      if (st.run && /Design both/i.test(st.run)) { sawIdle = true; break; }
    }
    await sleep(2000);
  }
  if (!sawIdle) throw new Error('the run button never returned to an idle "Design both" state');
}

const mounted = await cdp.evaluate(`!!document.querySelector('.site-footer')`);
check('the app mounted in a real browser', mounted === true);

const idleState = await cdp.evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
  return {
    hasDesign: btns.some((b) => /Design both/i.test(b)),
    badges: [...document.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
    presets: btns.filter((b) => /URL shortener|payments service|inference gateway|realtime chat/i.test(b)).length,
    hasFooter: !!document.querySelector('.site-footer'),
    footerText: document.querySelector('.site-footer')?.textContent?.trim() ?? '',
    footerLinks: [...document.querySelectorAll('.site-footer a')].map((a) => a.href),
  };
})()`);

check('idle state renders with all four preset briefs', idleState.presets === 4, `${idleState.presets} presets`);
check('the Design both control is present', idleState.hasDesign === true);
check(
  'before any run the badges say IDLE, not FAILED',
  idleState.badges.length === 2 && idleState.badges.every((b) => b === 'IDLE'),
  `badges: [${idleState.badges.join(', ')}]`,
);
check(
  'attribution footer renders with both links',
  idleState.hasFooter &&
    idleState.footerLinks.includes('https://harishkotra.me/') &&
    idleState.footerLinks.includes('https://dailybuild.xyz/'),
  `${idleState.footerText} → ${idleState.footerLinks.join(', ')}`,
);

// Kick off a real comparison. Re-find the button inside the page so a re-render
// between here and the click cannot leave us holding a stale node.
const clicked = await cdp.evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')]
    .find((b) => /Design both/i.test(b.textContent.trim()));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
check('clicked Design both in the browser', clicked === true);
console.log('\n  run started — waiting for both diagrams (local models, up to ' + RUN_TIMEOUT_S + 's)…');

const deadline = Date.now() + RUN_TIMEOUT_S * 1000;
let snapshot = null;
while (Date.now() < deadline) {
  await sleep(4000);
  snapshot = await cdp.evaluate(`(() => {
    const badges = [...document.querySelectorAll('.badge')].map((b) => b.textContent.trim());
    return {
      badges,
      phase: document.querySelector('.phase, .banner')?.textContent?.trim() ?? null,
      svgs: document.querySelectorAll('.svg-host svg').length,
      done: badges.filter((b) => /PARSED|FAILED/i.test(b)).length >= 2,
    };
  })()`);
  if (snapshot.done) break;
  process.stdout.write(`    … ${snapshot.badges.join(' / ') || 'working'}\n`);
}

check(
  'both panels reached a final PARSED or FAILED state',
  snapshot?.done === true,
  `badges: ${snapshot?.badges?.join(' / ')}`,
);

// Everything the UI is supposed to show, read straight out of the DOM.
const ui = await cdp.evaluate(`(() => {
  const text = document.body.innerText;
  const stats = [...document.querySelectorAll('.stat')].map((s) => s.innerText.replace(/\\s+/g, ' ').trim());
  const ticks = [...document.querySelectorAll('.tick-cell')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim());
  const present = ticks.filter((t) => !/not mentioned/i.test(t) && t !== '—');
  const svg = document.querySelector('.svg-host svg');
  return {
    svgs: document.querySelectorAll('.svg-host svg').length,
    stats: stats.slice(0, 20),
    tickCount: ticks.length,
    ticksWithLabels: present.length,
    sampleTicks: present.slice(0, 6),
    foreignObjects: document.querySelectorAll('foreignObject').length,
    textNodes: svg ? svg.querySelectorAll('text').length : 0,
    hasDiffHeadline: !!document.querySelector('.diff-strip'),
    diffText: document.querySelector('.diff-strip')?.innerText?.replace(/\\s+/g, ' ').slice(0, 240) ?? '',
    hasShareCard: /1080/.test(text),
    hasCopyJson: /Copy results as JSON/i.test(text),
    footerVisible: !!document.querySelector('.site-footer'),
  };
})()`);

check(
  'mermaid.js rendered real SVG in the browser',
  ui.svgs >= 1 && ui.textNodes > 0,
  `${ui.svgs} svg(s), ${ui.textNodes} <text> label(s) in the first one`,
);
check(
  'labels are <text>, not <foreignObject> (required for the PNG share card)',
  ui.foreignObjects === 0,
  `${ui.foreignObjects} foreignObject element(s)`,
);
check(
  'the checklist painted one row per concept per diagram',
  ui.tickCount >= 24,
  `${ui.tickCount} tick cells (12 concepts × 2 diagrams)`,
);
check(
  'ticks display the matched label, not just a score',
  ui.ticksWithLabels > 0,
  ui.sampleTicks.join(' | ').slice(0, 220),
);
check('the diff strip rendered', ui.hasDiffHeadline === true, ui.diffText);
check('the export controls are present', ui.hasShareCard && ui.hasCopyJson);
check('the attribution footer survived a full run', ui.footerVisible === true);

// The live JSON the UI is showing, for the evidence file.
const wire = await cdp.evaluate(`(() => {
  const t = document.body.innerText;
  return { excerpt: t.slice(0, 400) };
})()`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'═'.repeat(64)}`);
console.log(`  UI probe: ${passed}/${results.length} checks passed`);
console.log('═'.repeat(64));

const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('verify/evidence', { recursive: true });
writeFileSync(
  'verify/evidence/ui-probe.json',
  JSON.stringify({ url: URL_UNDER_TEST, seed: SEED, idleState, ui, wire, results }, null, 2),
);
console.log('  evidence → verify/evidence/ui-probe.json');

ws.close();
process.exit(passed === results.length ? 0 : 1);