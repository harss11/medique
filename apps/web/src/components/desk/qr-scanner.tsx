"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { Alert, Button } from "@/components/ui";

/** The browser's built-in detector (Chrome/Android/Edge); absent in Safari and Firefox. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

function nativeDetector(): BarcodeDetectorLike | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  try {
    return ctor ? new ctor({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

/**
 * Camera scanner for patients' check-in QR codes. Uses BarcodeDetector where the browser has
 * it and jsQR everywhere else. The video never leaves the device. Closing the dialog (or a
 * successful scan) stops the camera.
 */
export function QrScannerDialog({
  open,
  onClose,
  onCode,
}: {
  open: boolean;
  onClose: () => void;
  onCode: (code: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser cannot use the camera here. Type the code instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        setProblem("Camera access was blocked. Allow it in the browser, or type the code instead.");
        return;
      }
      const el = video.current;
      if (stopped || !el) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      el.srcObject = stream;
      await el.play().catch(() => undefined);

      const detector = nativeDetector();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let busy = false;
      timer = setInterval(async () => {
        if (busy || stopped || el.readyState < 2 || !el.videoWidth) return;
        busy = true;
        try {
          let text: string | null = null;
          if (detector) {
            text = (await detector.detect(el))[0]?.rawValue ?? null;
          } else if (ctx) {
            // Scan a downscaled frame: plenty for a QR code and much cheaper.
            const scale = Math.min(1, 640 / el.videoWidth);
            canvas.width = Math.round(el.videoWidth * scale);
            canvas.height = Math.round(el.videoHeight * scale);
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            text = jsQR(image.data, image.width, image.height)?.data ?? null;
          }
          if (text && !stopped) {
            stopped = true;
            onCode(text.trim());
          }
        } catch {
          // A frame that cannot be read is simply skipped.
        } finally {
          busy = false;
        }
      }, 250);
    }
    void start();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, onCode]);

  function close() {
    setProblem(null);
    onClose();
  }

  return (
    <Modal open={open} title="Scan check-in QR" onClose={close}>
      <div className="space-y-4">
        {problem ? (
          <Alert>{problem}</Alert>
        ) : (
          <div className="overflow-hidden rounded-xl bg-slate-900">
            <video ref={video} playsInline muted className="aspect-square w-full object-cover" />
          </div>
        )}
        <p className="text-sm text-slate-600">
          Hold the patient&apos;s phone (or printed slip) in front of the camera.
        </p>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
