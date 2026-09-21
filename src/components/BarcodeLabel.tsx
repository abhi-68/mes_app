import { code128Geometry } from "@/lib/code128";

/**
 * A printable lot label: barcode, code, and the two lines a person needs when the
 * scanner is across the shop.
 *
 * Deliberately readable by eye as well as by machine. A label that only a scanner
 * can read is useless the moment the scanner's battery dies, and the human-readable
 * line under a barcode is not decoration — it is the fallback, which is why the code
 * is repeated in mono beneath the bars.
 *
 * Rendered as inline SVG with no runtime: it prints correctly, scales to any label
 * stock, and works on a machine that has never heard of this application.
 */
export function BarcodeLabel({
  code,
  itemName,
  sku,
  heatNumber,
  quantity,
  unit,
  storageLocation,
  compact = false,
}: {
  code: string;
  itemName?: string;
  sku?: string;
  heatNumber?: string | null;
  quantity?: number;
  unit?: string;
  storageLocation?: string | null;
  /** Bars only, for a table cell. The full card is for printing. */
  compact?: boolean;
}) {
  const geo = code128Geometry(code, compact ? 1 : 2);
  const height = compact ? 28 : 56;

  return (
    <div
      className={
        compact
          ? "inline-block"
          : "inline-block break-inside-avoid rounded-lg border border-steel-300 bg-white p-4 print:border-black"
      }
    >
      {!compact && itemName && (
        <div className="mb-2">
          <p className="text-sm font-semibold leading-tight text-steel-900">{itemName}</p>
          <p className="tnum text-xs text-steel-500">
            {sku}
            {heatNumber ? ` · heat ${heatNumber}` : ""}
          </p>
        </div>
      )}

      {geo ? (
        <svg
          viewBox={`0 0 ${geo.width} ${height}`}
          width={compact ? 150 : 260}
          height={compact ? 28 : 56}
          role="img"
          aria-label={`Barcode for ${code}`}
          className="block"
        >
          {/* White ground is not optional: a transparent barcode printed onto
              anything but paper-white loses contrast and stops scanning. */}
          <rect x="0" y="0" width={geo.width} height={height} fill="#ffffff" />
          {geo.bars.map((bar, i) => (
            <rect key={i} x={bar.x} y="0" width={bar.width} height={height} fill="#000000" />
          ))}
        </svg>
      ) : (
        <p className="text-xs text-blocked-fg">
          {code ? `“${code}” cannot be encoded — use letters, digits and punctuation` : "No code"}
        </p>
      )}

      <p
        className={`tnum text-center font-mono tracking-wider text-steel-900 ${
          compact ? "text-[10px]" : "mt-1 text-sm"
        }`}
      >
        {code}
      </p>

      {!compact && (quantity !== undefined || storageLocation) && (
        <p className="tnum mt-1 text-center text-xs text-steel-500">
          {quantity !== undefined ? `${quantity} ${unit ?? ""}`.trim() : ""}
          {quantity !== undefined && storageLocation ? " · " : ""}
          {storageLocation ?? ""}
        </p>
      )}
    </div>
  );
}
