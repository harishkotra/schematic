import { standaloneSvg, svgSize } from './mermaidClient';

/**
 * The 1080x1080 share card.
 *
 * Both diagrams are rasterised from the real Mermaid SVG the browser rendered, so the
 * card cannot show a diagram the app did not actually produce. Mermaid is configured
 * with htmlLabels:false precisely so this step works: `<foreignObject>` content is not
 * drawn when an SVG is rasterised via `<img>`.
 */

const SIZE = 1080;
const PAD = 44;

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const INK = '#0a0e14';
const PANEL = '#121a26';
const PANEL_LINE = '#22304a';
const TEXT = '#e8edf5';
const MUTED = '#8b97a8';
const ACCENT_A = '#f59e0b';
const ACCENT_B = '#22d3ee';
const PASS = '#22c55e';
const FAIL = '#ef4444';

export interface ShareCardInput {
  brief: string;
  headline: string;
  a: { label: string; svg: string | null };
  b: { label: string; svg: string | null };
  checklist: Array<{ concept: string; a: boolean; b: boolean }>;
  nonce: string;
}

function ensureExplicitSize(svg: string): string {
  let out = standaloneSvg(svg);
  const { width, height } = svgSize(out);
  // Some engines refuse to rasterise an SVG whose root has no intrinsic size.
  out = out.replace(/<svg([^>]*?)\swidth="[^"]*"/, '<svg$1');
  out = out.replace(/<svg([^>]*?)\sheight="[^"]*"/, '<svg$1');
  out = out.replace('<svg', `<svg width="${Math.round(width)}" height="${Math.round(height)}"`);
  return out;
}

async function loadSvg(svg: string): Promise<HTMLImageElement | null> {
  try {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ensureExplicitSize(svg))}`;
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG could not be rasterised'));
      img.src = url;
    });
    return img;
  } catch {
    return null;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw an image aspect-fitted inside a box, centred. */
function drawFitted(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  boxX: number, boxY: number, boxW: number, boxH: number,
): void {
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildShareCard(input: ShareCardInput): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable — cannot build the share card.');

  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ── Header ────────────────────────────────────────────────────────────────
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ACCENT_B;
  ctx.font = `700 22px ${MONO}`;
  ctx.fillText('S C H E M A T I C', PAD, PAD + 22);

  ctx.fillStyle = MUTED;
  ctx.font = `500 20px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('1 identical prompt · 2 models · mermaid.js', SIZE - PAD, PAD + 22);
  ctx.textAlign = 'left';

  let y = PAD + 74;
  ctx.fillStyle = TEXT;
  ctx.font = `700 40px ${FONT}`;
  for (const line of wrap(ctx, input.brief, SIZE - PAD * 2).slice(0, 2)) {
    ctx.fillText(line, PAD, y);
    y += 46;
  }

  // ── The shareable line ────────────────────────────────────────────────────
  y += 6;
  ctx.font = `700 30px ${FONT}`;
  for (const line of wrap(ctx, input.headline, SIZE - PAD * 2).slice(0, 2)) {
    ctx.fillStyle = ACCENT_A;
    ctx.fillText(line, PAD, y);
    y += 38;
  }

  // ── Diagrams ──────────────────────────────────────────────────────────────
  const gap = 24;
  const boxW = (SIZE - PAD * 2 - gap) / 2;
  const boxH = 340;
  const boxY = y + 12;

  const images = await Promise.all([
    input.a.svg ? loadSvg(input.a.svg) : Promise.resolve(null),
    input.b.svg ? loadSvg(input.b.svg) : Promise.resolve(null),
  ]);

  const sides = [
    { label: input.a.label, accent: ACCENT_A, tag: 'A', img: images[0] },
    { label: input.b.label, accent: ACCENT_B, tag: 'B', img: images[1] },
  ];

  sides.forEach((side, i) => {
    const x = PAD + i * (boxW + gap);

    ctx.fillStyle = side.accent;
    ctx.font = `700 26px ${MONO}`;
    ctx.fillText(side.tag, x, boxY - 12);

    ctx.fillStyle = MUTED;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(side.label.slice(0, 30), x + 30, boxY - 12);

    ctx.fillStyle = PANEL;
    roundRect(ctx, x, boxY, boxW, boxH, 16);
    ctx.fill();
    ctx.strokeStyle = side.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, x, boxY, boxW, boxH, 16);
    ctx.stroke();

    if (side.img) {
      drawFitted(ctx, side.img, x + 14, boxY + 14, boxW - 28, boxH - 28);
    } else {
      ctx.fillStyle = FAIL;
      ctx.font = `600 22px ${FONT}`;
      ctx.fillText('no diagram', x + 24, boxY + boxH / 2);
    }
  });

  // ── Checklist ─────────────────────────────────────────────────────────────
  let cy = boxY + boxH + 54;
  ctx.fillStyle = MUTED;
  ctx.font = `700 20px ${MONO}`;
  ctx.fillText('C H E C K L I S T', PAD, cy);
  ctx.textAlign = 'right';
  ctx.fillStyle = ACCENT_A;
  ctx.fillText('A', PAD + boxW - 20, cy);
  ctx.fillStyle = ACCENT_B;
  ctx.fillText('B', PAD + boxW + gap + boxW - 20, cy);
  ctx.textAlign = 'left';

  cy += 16;
  const items = input.checklist;
  const perColumn = Math.ceil(items.length / 2);
  const rowH = 34;

  items.forEach((item, index) => {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    const x = PAD + column * (boxW + gap);
    const ry = cy + row * rowH + 22;

    ctx.fillStyle = TEXT;
    ctx.font = `500 20px ${FONT}`;
    const name = item.concept.length > 22 ? `${item.concept.slice(0, 21)}…` : item.concept;
    ctx.fillText(name, x, ry);

    const dotX = x + boxW - 20 - 46;
    [
      { on: item.a, cx: dotX },
      { on: item.b, cx: dotX + 46 },
    ].forEach((dot) => {
      ctx.beginPath();
      ctx.arc(dot.cx, ry - 7, 9, 0, Math.PI * 2);
      if (dot.on) {
        ctx.fillStyle = PASS;
        ctx.fill();
      } else {
        ctx.strokeStyle = FAIL;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    });
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  ctx.fillStyle = PANEL_LINE;
  ctx.fillRect(PAD, SIZE - PAD - 26, SIZE - PAD * 2, 1);

  ctx.fillStyle = MUTED;
  ctx.font = `500 17px ${MONO}`;
  ctx.fillText(`nonce ${input.nonce} · parsed & rendered by mermaid.js · no prompt reuse`, PAD, SIZE - PAD);

  ctx.textAlign = 'right';
  ctx.fillText('hollow red = not mentioned', SIZE - PAD, SIZE - PAD);
  ctx.textAlign = 'left';

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}