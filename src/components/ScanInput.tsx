"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui";

/**
 * Scanning a code, two ways, with no barcode library in the bundle.
 *
 * 1. A HANDHELD SCANNER IS A KEYBOARD. A USB or Bluetooth barcode gun types the
 *    code into whatever has focus and presses Enter. That is the path that actually
 *    gets used on a floor — it works in gloves, in bad light, at arm's length, and
 *    it costs us one focused input. It is listed first here because it is the one
 *    worth buying, not the fallback.
 *
 * 2. THE TABLET CAMERA, via the browser's own `BarcodeDetector`. Chrome and Android
 *    ship it; Safari does not. So it is offered only where it exists, and where it
 *    does not the field is still there to be typed into or scanned with a gun. No
 *    dead button, no "your browser is unsupported" wall in front of the work.
 *
 * What this component never does is decide what a code MEANS. It hands the string
 * up and the page decides — so the same control works for finding a lot, receiving
 * against one, or anything added later.
 */

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export function ScanInput({
  onScan,
  placeholder = "Scan or type a batch code",
  label = "Find a lot",
  autoFocus = false,
}: {
  onScan: (code: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /*
    Whether this browser can scan with its camera.

    Read through useSyncExternalStore rather than an effect that calls setState.
    The server has no `window`, so the server snapshot is simply `false` and the
    button is absent in the HTML; the client snapshot is the real answer. Doing it
    in an effect instead works, but renders once with the wrong answer and then
    again with the right one, which is a visible flicker on the slowest device in
    the building. The subscribe function is a no-op because the answer cannot
    change without a page load.
  */
  const cameraSupported = useSyncExternalStore(
    () => () => {},
    () => detectorCtor() !== null,
    () => false
  );

  const submit = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    onScan(trimmed);
    setValue("");
    // Straight back to the field: a receiving bench scans a dozen pallets in a row
    // and should never have to reach for the screen between them.
    inputRef.current?.focus();
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  };

  useEffect(() => {
    if (!cameraOn) return;
    const Ctor = detectorCtor();
    if (!Ctor) return;

    let cancelled = false;
    let raf = 0;
    const detector = new Ctor({
      formats: ["code_128", "code_39", "qr_code", "ean_13", "data_matrix"],
    });

    (async () => {
      try {
        // The rear camera, because nobody scans a pallet with the selfie lens.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found.length > 0 && found[0].rawValue) {
              submit(found[0].rawValue);
              stopCamera();
              return;
            }
          } catch {
            // A single failed frame is normal — motion blur, bad angle. Keep going.
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
      } catch (err) {
        setCameraError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera access was declined. Type the code, or use a handheld scanner."
            : "Could not open the camera. Type the code, or use a handheld scanner."
        );
        setCameraOn(false);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // `submit` is stable enough for this: it closes over `onScan`, which the pages
    // here define inline and never change between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  return (
    <div>
      <label className="block">
        <span className="text-xs text-gray-500">{label}</span>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            ref={inputRef}
            value={value}
            autoFocus={autoFocus}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // A barcode gun ends its transmission with Enter. So does a person
              // who has finished typing. Same handler, deliberately.
              if (e.key === "Enter") {
                e.preventDefault();
                submit(value);
              }
            }}
            placeholder={placeholder}
            className="min-h-11 min-w-56 flex-1 rounded-lg border-0 bg-white ring-1 ring-inset ring-gray-300 px-3 font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <Button onClick={() => submit(value)} disabled={!value.trim()}>
            Find
          </Button>
          {cameraSupported && (
            <Button
              tone="secondary"
              onClick={() => {
                setCameraError(null);
                if (cameraOn) stopCamera();
                else setCameraOn(true);
              }}
            >
              {cameraOn ? "Stop camera" : "Use camera"}
            </Button>
          )}
        </div>
      </label>

      {cameraOn && (
        <div className="mt-3 overflow-hidden rounded-lg ring-1 ring-inset ring-gray-300 bg-gray-950">
          <video ref={videoRef} playsInline muted className="block max-h-64 w-full object-cover" />
          <p className="px-3 py-2 text-xs text-white/70">
            Hold the label steady in frame. It reads on its own — there is no shutter.
          </p>
        </div>
      )}

      {cameraError && <p className="mt-2 text-sm text-danger-700">{cameraError}</p>}


    </div>
  );
}
