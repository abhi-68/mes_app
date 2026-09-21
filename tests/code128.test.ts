import { test, describe } from "node:test";
import assert from "node:assert/strict";
import bwipjs from "bwip-js/node";
import { code128Widths, code128Geometry, isEncodable } from "../src/lib/code128";

/**
 * Our Code 128 encoder, checked against a maintained one.
 *
 * This file exists because the first version of `src/lib/code128.ts` had a pattern
 * table written from memory, and it was wrong: two spurious entries shifted every
 * symbol past index 34. The barcodes it produced looked completely convincing on
 * screen and would not have scanned — which, on a label printed and stuck to a
 * pallet, is discovered at the worst possible moment by the worst possible person.
 *
 * So nothing here asserts a remembered constant. Every expectation is derived from
 * bwip-js at run time, and the widths are compared symbol for symbol. bwip-js is a
 * devDependency: it never ships, it just refuses to let our table drift.
 *
 * `raw()` returns `sbs` — the space/bar sequence in modules, starting with a bar —
 * which is exactly what `code128Widths` returns, so the comparison is direct.
 */

const reference = (text: string): number[] =>
  (bwipjs.raw({ bcid: "code128", text }) as { sbs: number[] }[])[0].sbs;

/**
 * Modules a pure Code B encoding of `text` would take: start, one six-module symbol
 * per character, checksum, then the seven-module stop.
 *
 * bwip-js optimises — it switches to Code C to pack runs of digits two to a symbol,
 * which is a shorter and equally valid barcode of the same data. Our encoder stays
 * in Code B throughout, deliberately: one code path, and a batch number is a dozen
 * characters where the saving is a few millimetres of label. So a length mismatch
 * means bwip chose a different MODE, not that our widths are wrong, and those cases
 * are compared on structure instead of module for module.
 */
const codeBLength = (text: string) => 6 * (1 + text.length + 1) + 7;

/**
 * True when bwip has no reason to reach for Code C.
 *
 * Code C packs DIGIT PAIRS, so a string with no two adjacent digits cannot benefit
 * from it and bwip stays in Code B throughout. Matching on the encoded LENGTH was
 * tried first and is not safe: a string can switch into Code C and back and land on
 * the same total, which produces a length that agrees and widths that do not.
 */
const staysInCodeB = (text: string) => !/\d\d/.test(text);

describe("code 128", () => {
  test("B1 matches the reference encoder character for character", () => {
    // Every printable character on its own. This is what catches a single
    // misplaced row in the pattern table, which is precisely what went wrong.
    for (let v = 0; v <= 94; v++) {
      const ch = String.fromCharCode(v + 32);
      assert.deepEqual(code128Widths(ch), reference(ch), `character ${JSON.stringify(ch)} (value ${v})`);
    }
  });

  test("B2 matches the reference on the codes this system actually prints", () => {
    // A spread of the shapes this system prints: generated lot codes, mill heat
    // numbers, pallet labels and order numbers.
    const codes = ["307290-1", "EB7728", "L260917-A4F2", "Pallet-01", "WO-1001-04", "A-4-F-2", "Bay 01"];
    let compared = 0;
    for (const code of codes) {
      assert.equal(code128Widths(code)!.length, codeBLength(code), `${code} structure`);
      if (!staysInCodeB(code)) continue; // bwip packs the digit run into Code C
      assert.deepEqual(code128Widths(code), reference(code), code);
      compared++;
    }
    assert.ok(compared > 0, "the mode check must not turn this into a no-op");
  });

  test("B3 the checksum is right across many random codes", () => {
    // The checksum is the only arithmetic in the encoder, and a wrong one is
    // invisible until a scanner rejects the label. A wide random sweep is worth
    // more here than one worked example.
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      let text = "";
      const n = 1 + Math.floor(Math.random() * 12);
      for (let j = 0; j < n; j++) text += String.fromCharCode(32 + Math.floor(Math.random() * 95));
      assert.equal(code128Widths(text)!.length, codeBLength(text), text);
      if (!staysInCodeB(text)) continue;
      assert.deepEqual(code128Widths(text), reference(text), text);
      checked++;
    }
    assert.ok(checked > 100, `only ${checked} strings were comparable in Code B`);
  });

  test("B4 structure: start, one symbol per character, checksum, stop", () => {
    const widths = code128Widths("307290-1")!;
    // Every symbol is six modules except the stop pattern, which is seven.
    assert.equal((widths.length - 7) % 6, 0);
    assert.equal((widths.length - 7) / 6, 1 + 8 + 1, "start + 8 characters + checksum");
  });

  test("B5 unencodable input returns null rather than throwing", () => {
    // A label that cannot be drawn should fall back to printed text, not take the
    // page down while somebody is trying to book a delivery in.
    assert.equal(code128Widths("café"), null);
    assert.equal(code128Widths(""), null);
    assert.equal(isEncodable("café"), false);
    assert.equal(isEncodable("307290-1"), true);
  });

  test("B6 geometry alternates bar and space, and leaves a quiet zone", () => {
    const geo = code128Geometry("307290-1", 2)!;
    assert.ok(geo.bars.length > 0);

    // Nothing starts at zero: the first ten modules are the quiet zone, without
    // which a scanner reads the label edge as a bar and the code fails. This is
    // the most common reason a home-made label will not scan.
    assert.equal(geo.bars[0].x, 20);

    for (let i = 1; i < geo.bars.length; i++) {
      const prevEnd = geo.bars[i - 1].x + geo.bars[i - 1].width;
      assert.ok(geo.bars[i].x > prevEnd, `bar ${i} overlaps its predecessor`);
    }

    const last = geo.bars[geo.bars.length - 1];
    assert.equal(geo.width - (last.x + last.width), 20, "same quiet zone at the end");
  });

  test("B7 module width scales the whole symbol linearly", () => {
    const one = code128Geometry("EB7728", 1)!;
    const three = code128Geometry("EB7728", 3)!;
    assert.equal(three.width, one.width * 3);
    assert.equal(three.bars.length, one.bars.length);
  });
});
