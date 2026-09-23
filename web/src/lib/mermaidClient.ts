import mermaid from 'mermaid';

/**
 * Client-side Mermaid.
 *
 * `htmlLabels: false` is deliberate and load-bearing: with HTML labels Mermaid emits
 * `<foreignObject>`, and browsers refuse to draw foreignObject content when an SVG is
 * rasterised through an `<img>` — which is exactly how the 1080x1080 PNG share card is
 * built. Plain `<text>` labels also make the exported SVG open cleanly in Figma.
 */
let initialized = false;

function init(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    htmlLabels: false,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis', padding: 16 },
    themeVariables: {
      darkMode: true,
      background: '#0f1521',
      primaryColor: '#1b2536',
      primaryTextColor: '#e8edf5',
      primaryBorderColor: '#3b4a63',
      secondaryColor: '#1b2536',
      tertiaryColor: '#131b28',
      lineColor: '#8b9bb4',
      textColor: '#e8edf5',
      mainBkg: '#1b2536',
      nodeBorder: '#3b4a63',
      clusterBkg: '#131b28',
      clusterBorder: '#2c3a4f',
      edgeLabelBackground: '#0f1521',
      titleColor: '#e8edf5',
      fontSize: '17px',
    },
  });
  initialized = true;
}

export interface RenderOutcome {
  svg: string | null;
  error: string | null;
}

/** Real parse, in the browser, on the actual Mermaid build that renders the diagram. */
export async function parseMermaid(source: string): Promise<{ ok: boolean; error: string | null }> {
  init();
  try {
    // Mermaid v11 resolves a ParseResult, or rejects with the parser's message.
    await mermaid.parse(source, { suppressErrors: false });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function renderMermaid(id: string, source: string): Promise<RenderOutcome> {
  init();
  try {
    const { svg } = await mermaid.render(id, source);
    return { svg, error: null };
  } catch (err) {
    return { svg: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Mermaid leaves its measuring node behind when it throws.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Make a rendered SVG standalone so it downloads and rasterises correctly. */
export function standaloneSvg(svg: string): string {
  let out = svg.trim();
  if (!/xmlns=/.test(out)) {
    out = out.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/xmlns:xlink=/.test(out)) {
    out = out.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return out;
}

/** Read the rendered viewBox so the share card can scale each diagram to fit. */
export function svgSize(svg: string): { width: number; height: number } {
  const viewBox = /viewBox="([\d.\-\s]+)"/.exec(svg);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const w = /width="([\d.]+)"/.exec(svg);
  const h = /height="([\d.]+)"/.exec(svg);
  return { width: Number(w?.[1] ?? 800), height: Number(h?.[1] ?? 600) };
}