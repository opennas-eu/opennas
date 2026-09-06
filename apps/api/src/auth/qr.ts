/**
 * A minimal QR encoder - byte mode, error-correction level M, versions 1-10 -
 * emitting SVG.
 *
 * It exists for exactly one payload: the `otpauth://` URI a user scans when
 * enrolling an authenticator. That URI is ~110 characters, so a full encoder
 * covering all 40 versions, four modes and Kanji would be almost entirely dead
 * code, and shipping a QR library into an appliance image to draw one square is
 * a poor trade. Version 10-M holds 213 bytes, which leaves generous room for a
 * long instance name and username.
 *
 * Reference: ISO/IEC 18004. Verified against `zbarimg` for every version it can
 * produce and against `qrencode`'s module output.
 */

type Bit = 0 | 1;

// ---- GF(256) --------------------------------------------------------------
// The field QR uses: modulo the primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = rsGenerator(ecLength);
  const rem = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
    }
  }
  return rem;
}

// ---- Version tables (error-correction level M only) -----------------------

interface VersionSpec {
  /** EC codewords per block. */
  ec: number;
  /** [blockCount, dataCodewordsPerBlock] for each of the (up to two) groups. */
  groups: [number, number][];
  /** Row/column centres of the alignment patterns. */
  align: number[];
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { ec: 10, groups: [[1, 16]], align: [] },
  2: { ec: 16, groups: [[1, 28]], align: [6, 18] },
  3: { ec: 26, groups: [[1, 44]], align: [6, 22] },
  4: { ec: 18, groups: [[2, 32]], align: [6, 26] },
  5: { ec: 24, groups: [[2, 43]], align: [6, 30] },
  6: { ec: 16, groups: [[4, 27]], align: [6, 34] },
  7: { ec: 18, groups: [[4, 31]], align: [6, 22, 38] },
  8: { ec: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  9: { ec: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] },
  10: { ec: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50] },
};

const MAX_VERSION = 10;

function dataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

/** Byte-mode character-count indicator is 8 bits below version 10, 16 at/above. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function capacityBytes(version: number): number {
  const spec = VERSIONS[version]!;
  return dataCodewords(spec) - 1 - countBits(version) / 8;
}

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (byteLength <= capacityBytes(v)) return v;
  }
  throw new Error(`payload too long for a version-${MAX_VERSION} QR code (${byteLength} bytes)`);
}

// ---- Bit stream -----------------------------------------------------------

class BitWriter {
  private bits: Bit[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push(((value >>> i) & 1) as Bit);
  }
  get length(): number {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >>> 3]! |= 0x80 >>> (i & 7);
    });
    return out;
  }
}

function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version]!;
  const total = dataCodewords(spec);
  const w = new BitWriter();
  w.push(0b0100, 4); // byte mode
  w.push(bytes.length, countBits(version));
  for (const b of bytes) w.push(b, 8);
  // Terminator, then pad to a whole codeword, then the fixed alternating pad.
  w.push(0, Math.min(4, total * 8 - w.length));
  if (w.length % 8 !== 0) w.push(0, 8 - (w.length % 8));
  const out = new Uint8Array(total);
  const written = w.toBytes();
  out.set(written);
  // Remaining codewords take the spec's fixed alternating filler.
  for (let i = written.length; i < total; i++) out[i] = (i - written.length) % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** Split into blocks, add EC, then interleave - the order the spec places them. */
function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version]!;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ec));
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

// ---- Matrix ---------------------------------------------------------------

/** `null` marks a module the data stream may still be written into. */
type Matrix = (Bit | null)[][];

function emptyMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => Array<Bit | null>(size).fill(null));
}

function placeFinder(m: Matrix, row: number, col: number): void {
  // The 7x7 finder plus its one-module separator, clipped at the edges.
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const onRing = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      m[rr]![cc] = inside && (onRing || inCore) ? 1 : 0;
    }
  }
}

function placeFunctionPatterns(m: Matrix, version: number): void {
  const size = m.length;
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const bit: Bit = i % 2 === 0 ? 1 : 0;
    m[6]![i] = bit;
    m[i]![6] = bit;
  }

  // Alignment patterns, except where they'd collide with a finder.
  const centres = VERSIONS[version]!.align;
  for (const r of centres) {
    for (const c of centres) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          m[r + dr]![c + dc] = edge || (dr === 0 && dc === 0) ? 1 : 0;
        }
      }
    }
  }

  m[size - 8]![8] = 1; // the always-dark module

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (m[8]![i] === null) m[8]![i] = 0;
    if (m[i]![8] === null) m[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8]![size - 1 - i] === null) m[8]![size - 1 - i] = 0;
    if (m[size - 1 - i]![8] === null) m[size - 1 - i]![8] = 0;
  }

  // Version information blocks (version 7 and up).
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit: Bit = ((bits >> i) & 1) as Bit;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      m[r]![c] = bit;
      m[c]![r] = bit;
    }
  }
}

/** BCH(18,6) version information, used from version 7 upwards. */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

/** BCH(15,5) format information for EC level M and the chosen mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // 00 = level M
  let rem = data << 10;
  for (let i = 0; i < 5; i++) {
    if (rem & (1 << (14 - i))) rem ^= 0x537 << (4 - i);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Write both copies of the format information. The 15 bits go out most
 * significant first, and the second copy is split 7 modules up the left of the
 * bottom-left finder and 8 along the top of the bottom-right one - the dark
 * module at (size-8, 8) sits between them and is not part of the field.
 */
function placeFormat(m: Matrix, mask: number): void {
  const size = m.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit: Bit = ((bits >> (14 - i)) & 1) as Bit;
    // Copy 1, around the top-left finder (skipping the timing row/column).
    if (i < 6) m[8]![i] = bit;
    else if (i === 6) m[8]![7] = bit;
    else if (i === 7) m[8]![8] = bit;
    else if (i === 8) m[7]![8] = bit;
    else m[14 - i]![8] = bit;
    // Copy 2, split between the other two finders.
    if (i < 7) m[size - 1 - i]![8] = bit;
    else m[8]![size - 15 + i] = bit;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Zigzag data placement: upward/downward column pairs, right to left. */
function placeData(m: Matrix, codewords: Uint8Array): [number, number][] {
  const size = m.length;
  const free: [number, number][] = [];
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is the vertical timing pattern
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m[row]![col] !== null) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        m[row]![col] = ((byte >>> (7 - (bitIndex & 7))) & 1) as Bit;
        free.push([row, col]);
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return free;
}

function penalty(m: Matrix): number {
  const size = m.length;
  const at = (r: number, c: number) => m[r]![c] === 1;
  let score = 0;

  // Rule 1 - runs of five or more identical modules.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? at(i, j) : at(j, i);
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i);
        if (cur === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 - 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3 - finder-lookalike sequences in any row or column.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const pattern of [p1, p2]) {
        let rowMatch = true;
        let colMatch = true;
        for (let k = 0; k < 11; k++) {
          if (at(i, j + k) !== (pattern[k] === 1)) rowMatch = false;
          if (at(j + k, i) !== (pattern[k] === 1)) colMatch = false;
        }
        if (rowMatch) score += 40;
        if (colMatch) score += 40;
      }
    }
  }

  // Rule 4 - deviation from a 50/50 light/dark balance.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** Encode `text` and return the module grid (true = dark). */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;

  const m = emptyMatrix(size);
  placeFunctionPatterns(m, version);
  const free = placeData(m, buildCodewords(encodeData(bytes, version), version));

  // Try all eight masks and keep the lowest-penalty one, as the spec requires.
  let best: { mask: number; grid: Matrix } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = m.map((row) => row.slice());
    for (const [r, c] of free) {
      if (MASKS[mask]!(r, c)) candidate[r]![c] = (candidate[r]![c] === 1 ? 0 : 1) as Bit;
    }
    placeFormat(candidate, mask);
    const score = penalty(candidate);
    if (!best || score < penalty(best.grid)) best = { mask, grid: candidate };
  }
  return best!.grid.map((row) => row.map((v) => v === 1));
}

/**
 * Render `text` as an SVG QR code. Sized in module units with a viewBox, so the
 * caller controls the pixel size with CSS and it stays crisp at any scale.
 */
export function qrSvg(text: string, options: { quietZone?: number } = {}): string {
  const quiet = options.quietZone ?? 4; // the spec's minimum margin
  const modules = qrMatrix(text);
  const size = modules.length;
  const total = size + quiet * 2;

  // One path for every dark module beats one <rect> each - roughly a third the
  // bytes, and the browser draws it in a single fill.
  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}
