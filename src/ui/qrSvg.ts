// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pure TypeScript ISO/IEC 18004 QR Code encoder & SVG renderer (zero dependencies).
 * Supports Alphanumeric & UTF-8 Byte modes across versions 1–16 with EC levels L and M.
 */

export type QrEcLevel = "L" | "M";

const ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// ISO/IEC 18004 Table 9: [ecCodewordsPerBlock, numBlocks] for Versions 1..16
// Index 0 is unused so index === version.
const EC_TABLE_L: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [7, 1],
  [10, 1],
  [15, 1],
  [20, 1],
  [26, 1],
  [18, 2],
  [20, 2],
  [24, 2],
  [30, 2],
  [18, 4],
  [20, 4],
  [24, 4],
  [26, 4],
  [30, 4],
  [22, 6],
  [24, 6],
];

const EC_TABLE_M: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [10, 1],
  [16, 1],
  [26, 1],
  [18, 2],
  [24, 2],
  [16, 4],
  [18, 4],
  [22, 4],
  [22, 5],
  [26, 5],
  [30, 5],
  [22, 8],
  [22, 9],
  [24, 9],
  [24, 10],
  [28, 10],
];

const MIN_VERSION = 1;
const MAX_VERSION = 16;

// Format info EC level indicators (ISO/IEC 18004 Table 12): L = 01, M = 00
const EC_FORMAT_BITS: Record<QrEcLevel, number> = {
  L: 1,
  M: 0,
};

// ----------------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11D: x^8 + x^4 + x^3 + x^2 + 1)
// ----------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = rem[j + 1];
    }
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// ----------------------------------------------------------------------------
// Version geometry & capacities
// ----------------------------------------------------------------------------

function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const positions: number[] = [6];
  for (let pos = size - 7; positions.length < numAlign; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

function getEcParams(version: number, ecLevel: QrEcLevel): readonly [number, number] {
  return ecLevel === "L" ? EC_TABLE_L[version] : EC_TABLE_M[version];
}

function getDataCodewordCapacity(version: number, ecLevel: QrEcLevel): number {
  const totalCodewords = Math.floor(numRawDataModules(version) / 8);
  const [ecPerBlock, numBlocks] = getEcParams(version, ecLevel);
  return totalCodewords - ecPerBlock * numBlocks;
}

// ----------------------------------------------------------------------------
// Bit buffer & payload encoding
// ----------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }
}

function isAlphanumeric(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!ALPHANUMERIC_CHARSET.includes(text[i])) {
      return false;
    }
  }
  return true;
}

function charCountBits(mode: "alphanumeric" | "byte", version: number): number {
  if (mode === "alphanumeric") {
    return version <= 9 ? 9 : 11;
  }
  return version <= 9 ? 8 : 16;
}

function encodedPayloadBits(
  mode: "alphanumeric" | "byte",
  version: number,
  alnumLen: number,
  byteLen: number,
): number {
  const header = 4 + charCountBits(mode, version);
  if (mode === "alphanumeric") {
    return header + Math.floor(alnumLen / 2) * 11 + (alnumLen % 2) * 6;
  }
  return header + byteLen * 8;
}

function encodeCodewords(
  text: string,
  ecLevel: QrEcLevel,
): { version: number; effectiveEc: QrEcLevel; codewords: Uint8Array } {
  const utf8 = new TextEncoder().encode(text);
  const mode: "alphanumeric" | "byte" = isAlphanumeric(text) ? "alphanumeric" : "byte";

  const tryLevels: QrEcLevel[] = ecLevel === "M" ? ["M", "L"] : ["L"];
  let chosenVersion = -1;
  let effectiveEc: QrEcLevel = ecLevel;

  for (const level of tryLevels) {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
      const capBits = getDataCodewordCapacity(v, level) * 8;
      const needed = encodedPayloadBits(mode, v, text.length, utf8.length);
      if (needed <= capBits) {
        chosenVersion = v;
        effectiveEc = level;
        break;
      }
    }
    if (chosenVersion !== -1) break;
  }

  if (chosenVersion === -1) {
    throw new Error(`QR 内容过长（${utf8.length} 字节），超出支持的版本上限 (V${MAX_VERSION})`);
  }

  const dataCap = getDataCodewordCapacity(chosenVersion, effectiveEc);
  const capBits = dataCap * 8;
  const buf = new BitBuffer();

  if (mode === "alphanumeric") {
    buf.append(0b0010, 4);
    buf.append(text.length, charCountBits("alphanumeric", chosenVersion));
    for (let i = 0; i < text.length; i += 2) {
      const c1 = ALPHANUMERIC_CHARSET.indexOf(text[i]);
      if (i + 1 < text.length) {
        const c2 = ALPHANUMERIC_CHARSET.indexOf(text[i + 1]);
        buf.append(c1 * 45 + c2, 11);
      } else {
        buf.append(c1, 6);
      }
    }
  } else {
    buf.append(0b0100, 4);
    buf.append(utf8.length, charCountBits("byte", chosenVersion));
    for (let i = 0; i < utf8.length; i += 1) {
      buf.append(utf8[i], 8);
    }
  }

  // Terminator (up to 4 zero bits)
  const terminatorLen = Math.min(4, capBits - buf.length);
  buf.append(0, terminatorLen);

  // Align to byte boundary
  const padZeroBits = (8 - (buf.length % 8)) % 8;
  buf.append(0, padZeroBits);

  // Pad alternating 0xEC, 0x11 codewords
  const dataBytes = new Uint8Array(dataCap);
  const writtenBytes = buf.length / 8;
  for (let i = 0; i < writtenBytes; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      byte = (byte << 1) | buf.bits[i * 8 + b];
    }
    dataBytes[i] = byte;
  }
  const padCycle = [0xec, 0x11];
  for (let i = writtenBytes; i < dataCap; i += 1) {
    dataBytes[i] = padCycle[(i - writtenBytes) % 2];
  }

  // Split into RS blocks & interleave
  const [ecPerBlock, numBlocks] = getEcParams(chosenVersion, effectiveEc);
  const shortLen = Math.floor(dataCap / numBlocks);
  const numLong = dataCap % numBlocks;
  const numShort = numBlocks - numLong;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b += 1) {
    const len = b < numShort ? shortLen : shortLen + 1;
    const block = dataBytes.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsComputeRemainder(block, ecPerBlock));
  }

  const totalLen = dataCap + numBlocks * ecPerBlock;
  const interleaved = new Uint8Array(totalLen);
  let out = 0;
  const maxDataLen = shortLen + (numLong > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      if (i < dataBlocks[b].length) {
        interleaved[out++] = dataBlocks[b][i];
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      interleaved[out++] = ecBlocks[b][i];
    }
  }

  return { version: chosenVersion, effectiveEc, codewords: interleaved };
}

// ----------------------------------------------------------------------------
// Matrix construction, BCH format/version bits, masking & penalty scoring
// ----------------------------------------------------------------------------

function computeFormatBits(ecLevel: QrEcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}

function drawFormatBits(
  modules: boolean[][],
  isFunction: boolean[][],
  ecLevel: QrEcLevel,
  mask: number,
): void {
  const size = modules.length;
  const bits = computeFormatBits(ecLevel, mask);
  const bitAt = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  // Copy 1: around top-left finder
  for (let i = 0; i <= 5; i += 1) {
    modules[i][8] = bitAt(i);
    isFunction[i][8] = true;
  }
  modules[7][8] = bitAt(6);
  isFunction[7][8] = true;
  modules[8][8] = bitAt(7);
  isFunction[8][8] = true;
  modules[8][7] = bitAt(8);
  isFunction[8][7] = true;
  for (let i = 9; i < 15; i += 1) {
    modules[8][14 - i] = bitAt(i);
    isFunction[8][14 - i] = true;
  }

  // Copy 2: top-right & bottom-left
  for (let i = 0; i < 8; i += 1) {
    modules[8][size - 1 - i] = bitAt(i);
    isFunction[8][size - 1 - i] = true;
  }
  for (let i = 8; i < 15; i += 1) {
    modules[size - 15 + i][8] = bitAt(i);
    isFunction[size - 15 + i][8] = true;
  }

  // Fixed dark module
  modules[size - 8][8] = true;
  isFunction[size - 8][8] = true;
}

function drawFunctionPatterns(
  modules: boolean[][],
  isFunction: boolean[][],
  version: number,
  ecLevel: QrEcLevel,
): void {
  const size = modules.length;

  const setFn = (x: number, y: number, dark: boolean): void => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing patterns
  for (let i = 0; i < size; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 3 Finder patterns + separators
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns
  const alignPos = alignmentPatternPositions(version);
  for (let i = 0; i < alignPos.length; i += 1) {
    for (let j = 0; j < alignPos.length; j += 1) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === alignPos.length - 1) ||
        (i === alignPos.length - 1 && j === 0)
      ) {
        continue;
      }
      const cx = alignPos[j];
      const cy = alignPos[i];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Dummy format info to reserve cells before data placement
  drawFormatBits(modules, isFunction, ecLevel, 0);

  // Version info (version >= 7)
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }
}

function drawCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  codewords: Uint8Array,
): void {
  const size = modules.length;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (!isFunction[y][x]) {
          let dark = false;
          if (bitIndex < totalBits) {
            dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex += 1;
          }
          modules[y][x] = dark;
        }
      }
    }
    upward = !upward;
  }
}

function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && maskCondition(mask, x, y)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function countFinderLikePatterns(line: boolean[]): number {
  let count = 0;
  for (let i = 0; i <= line.length - 11; i += 1) {
    // 10111010000
    const p1 =
      line[i] &&
      !line[i + 1] &&
      line[i + 2] &&
      line[i + 3] &&
      line[i + 4] &&
      !line[i + 5] &&
      line[i + 6] &&
      !line[i + 7] &&
      !line[i + 8] &&
      !line[i + 9] &&
      !line[i + 10];
    // 00001011101
    const p2 =
      !line[i] &&
      !line[i + 1] &&
      !line[i + 2] &&
      !line[i + 3] &&
      line[i + 4] &&
      !line[i + 5] &&
      line[i + 6] &&
      line[i + 7] &&
      line[i + 8] &&
      !line[i + 9] &&
      line[i + 10];
    if (p1 || p2) {
      count += 1;
    }
  }
  return count;
}

function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // Rule 1 & Rule 3: horizontal runs and finder-like patterns
  for (let y = 0; y < size; y += 1) {
    const row = modules[y];
    let runColor = row[0];
    let runLen = 1;
    for (let x = 1; x < size; x += 1) {
      if (row[x] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = row[x];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
    score += countFinderLikePatterns(row) * 40;
  }

  // Rule 1 & Rule 3: vertical runs and finder-like patterns
  const col = new Array<boolean>(size);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      col[y] = modules[y][x];
    }
    let runColor = col[0];
    let runLen = 1;
    for (let y = 1; y < size; y += 1) {
      if (col[y] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = col[y];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
    score += countFinderLikePatterns(col) * 40;
  }

  // Rule 2: 2x2 blocks of same color
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // Rule 4: balance of dark vs light modules
  let darkCount = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) darkCount += 1;
    }
  }
  const total = size * size;
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
  score += k * 10;

  return score;
}

/**
 * Generate a scannable QR Code module matrix (`true` = dark, `false` = light).
 */
export function generateQrMatrix(text: string, ecLevel: QrEcLevel = "M"): boolean[][] {
  const { version, effectiveEc, codewords } = encodeCodewords(text, ecLevel);
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  drawFunctionPatterns(modules, isFunction, version, effectiveEc);
  drawCodewords(modules, isFunction, codewords);

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(modules, isFunction, mask);
    drawFormatBits(modules, isFunction, effectiveEc, mask);
    const score = penaltyScore(modules);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(modules, isFunction, mask);
  }

  applyMask(modules, isFunction, bestMask);
  drawFormatBits(modules, isFunction, effectiveEc, bestMask);
  return modules;
}

/**
 * Render a crisp, scannable standalone SVG QR Code with a 4-module quiet zone.
 */
export function renderQrSvg(text: string, size = 220, ecLevel: QrEcLevel = "M"): string {
  const matrix = generateQrMatrix(text, ecLevel);
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const parts: string[] = [];

  for (let y = 0; y < n; y += 1) {
    const row = matrix[y];
    let x = 0;
    while (x < n) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < n && row[x]) {
        x += 1;
      }
      const run = x - start;
      parts.push(`M${start + quiet} ${y + quiet}h${run}v1h-${run}z`);
    }
  }

  const pixelSize = Math.max(1, Math.round(size));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img" aria-label="QR Code">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${parts.join("")}" fill="#000000"/>` +
    `</svg>`
  );
}
