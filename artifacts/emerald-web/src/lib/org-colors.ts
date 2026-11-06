// One distinct line colour per organisation (the Trends chart had 13 colours for 21 organisations, so eight pairs shared one).
//
// Colours are chosen by farthest-point sampling in CIE Lab: each new colour is the candidate that is furthest from every colour
// already chosen. Two properties follow:
//  - the first k colours never change when more organisations are added (colour k depends only on k), so an organisation keeps
//    its colour as the list grows;
//  - the candidates are limited to lightness 44-60 and real chroma, which keeps every colour at 3:1 or better against both the
//    white card and the dark card (a line must stand out in both themes).

type Lab = [number, number, number];

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function rgbToLab([r, g, b]: [number, number, number]): Lab {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const hex = ([r, g, b]: [number, number, number]) => "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
export const colourDistance = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

interface Candidate { hex: string; lab: Lab }

function candidates(): Candidate[] {
  // Every hue at every saturation and lightness, kept only when its perceived lightness (CIE L*) is 44-60 and it is properly
  // coloured. L* 44-60 is the band that holds 3:1 against both the white and the dark card; a hue like green needs a much
  // darker HSL lightness than blue to land in it, which is why lightness is searched and not fixed.
  const out: Candidate[] = [];
  for (let h = 0; h < 360; h += 3) {
    for (const s of [0.55, 0.7, 0.85, 1]) {
      for (let l = 0.2; l <= 0.75; l += 0.025) {
        const rgb = hslToRgb(h, s, l);
        const lab = rgbToLab(rgb);
        if (lab[0] >= 44 && lab[0] <= 60 && Math.hypot(lab[1], lab[2]) >= 42) out.push({ hex: hex(rgb), lab });
      }
    }
  }
  return out;
}

const MAX = 48;
let sequence: string[] | null = null;
let labs: Lab[] = [];

function build(): string[] {
  const pool = candidates();
  // start from the app's blue, then always take the candidate furthest from everything chosen so far
  const start = pool.reduce((best, c) => (Math.abs(c.lab[1] - 10) + Math.abs(c.lab[2] + 60) < Math.abs(best.lab[1] - 10) + Math.abs(best.lab[2] + 60) ? c : best), pool[0]);
  const chosen: Candidate[] = [start];
  while (chosen.length < MAX) {
    let best = pool[0], bestD = -1;
    for (const c of pool) {
      const d = Math.min(...chosen.map((x) => colourDistance(c.lab, x.lab)));
      if (d > bestD) { bestD = d; best = c; }
    }
    chosen.push(best);
  }
  labs = chosen.map((c) => c.lab);
  return chosen.map((c) => c.hex);
}

/** The colour of the n-th organisation (0-based). */
export function orgColour(n: number): string {
  if (!sequence) sequence = build();
  return sequence[n % sequence.length];
}

/** The smallest distance (CIE76 ΔE) between any two of the first n colours: bigger is easier to tell apart. */
export function minColourDistance(n: number): number {
  if (!sequence) sequence = build();
  let min = Infinity;
  for (let i = 0; i < Math.min(n, MAX); i++) for (let j = i + 1; j < Math.min(n, MAX); j++) min = Math.min(min, colourDistance(labs[i], labs[j]));
  return min;
}
