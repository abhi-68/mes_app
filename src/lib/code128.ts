/**
 * Code 128 barcode, encoded to bar widths. No runtime dependency.
 *
 * WHERE THIS TABLE CAME FROM, AND WHY THAT MATTERS.
 *
 * The first version of this file had a pattern table written from memory. It was
 * wrong — two spurious entries shifted every symbol past index 34, which produced
 * barcodes that looked entirely convincing on screen and would not have scanned.
 * That is the worst failure mode available here, because a label gets printed and
 * stuck on a pallet long before anyone tries to read it back.
 *
 * So the table below is not remembered. It was extracted symbol by symbol from
 * bwip-js, a maintained implementation, and `tests/code128.test.ts` re-derives it
 * from bwip-js on every run and fails if a single width has drifted. bwip-js is a
 * devDependency only: the shop tablet ships these ninety lines, and the library
 * exists to keep them honest.
 *
 * Code B throughout: it covers upper and lower case, digits and punctuation, which
 * is every character a batch or heat number contains. Code C would pack digit pairs
 * more tightly and is not worth a second code path.
 *
 * The output is bar widths in modules, starting with a bar, alternating bar/space.
 * The caller turns that into rectangles; nothing here knows about SVG.
 */

/** The 107 Code 128 patterns, as module widths. Index = the symbol's value. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;

/** True when every character can be encoded in Code B (ASCII 32..126). */
export function isEncodable(text: string): boolean {
  return [...text].every((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c <= 126;
  });
}

/**
 * Module widths for `text`, or null when it contains a character Code B cannot
 * carry. Null rather than a throw: a label that cannot be drawn should degrade to
 * printed text, not take the page down.
 */
export function code128Widths(text: string): number[] | null {
  if (!text || !isEncodable(text)) return null;

  const values: number[] = [START_B];
  for (const ch of text) values.push(ch.charCodeAt(0) - 32);

  // Checksum: start value plus each symbol weighted by its position, mod 103.
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);

  const widths: number[] = [];
  for (const value of values) {
    for (const digit of PATTERNS[value]) widths.push(Number(digit));
  }
  return widths;
}

export type BarcodeGeometry = {
  /** x, width pairs for the dark bars only. Spaces are the gaps between them. */
  bars: { x: number; width: number }[];
  /** Total width in the same units as the bars. */
  width: number;
};

/**
 * Bars laid out left to right at `moduleWidth` units per module.
 *
 * A quiet zone of ten modules is included at each end. It looks like wasted margin
 * and it is not: without it a scanner reads the edge of the label as a bar and the
 * whole code fails, which is the single most common reason a home-made label will
 * not scan.
 */
export function code128Geometry(text: string, moduleWidth = 2): BarcodeGeometry | null {
  const widths = code128Widths(text);
  if (!widths) return null;

  const quiet = 10 * moduleWidth;
  const bars: { x: number; width: number }[] = [];
  let x = quiet;
  let isBar = true; // patterns always start with a bar

  for (const modules of widths) {
    const w = modules * moduleWidth;
    if (isBar) bars.push({ x, width: w });
    x += w;
    isBar = !isBar;
  }

  return { bars, width: x + quiet };
}
