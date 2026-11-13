import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";

/* Running the worker on the main thread keeps everything inside one bundle.
   This matters because blob: URLs — used both by classic workers and by
   <object>/<iframe> PDF embeds — are blocked in opaque-origin (sandboxed)
   contexts, which is exactly where this app can run. Canvas rendering has
   no such restriction, so drawing the pages ourselves always works. */
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;
pdfjs.GlobalWorkerOptions.workerSrc = "";

type Props = { data: ArrayBuffer; scale: number; downloadUrl: string; name: string };

export default function PdfViewer({ data, scale, downloadUrl, name }: Props) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    let doc: pdfjs.PDFDocumentProxy | null = null;

    async function render() {
      setStatus("loading");
      try {
        // pdf.js transfers (and detaches) the buffer, so hand it a copy.
        // Recent pdf.js releases removed eval-based code generation entirely.
        loadingTask = pdfjs.getDocument({ data: data.slice(0) });
        doc = await loadingTask.promise;
        if (cancelled) return;

        const host = holder.current;
        if (!host) return;
        host.replaceChildren();

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // Fit the first page to the panel width, then apply the user's zoom.
        const first = await doc.getPage(1);
        const unit = first.getViewport({ scale: 1 });
        const fit = Math.max(0.2, (host.clientWidth - 32) / unit.width);
        const effective = fit * scale;

        for (let n = 1; n <= doc.numPages; n += 1) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: effective });
          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.scale(dpr, dpr);
          host.append(canvas);
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
        }
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not read this PDF.");
        setStatus("error");
      }
    }

    render();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    };
  }, [data, scale]);

  return (
    <div className="pdf-wrap">
      {status === "loading" && <div className="pdf-status">Rendering PDF…</div>}
      {status === "error" && (
        <div className="pdf-status error">
          <p>{error}</p>
          <a className="util-go" href={downloadUrl} download={name}>Download instead</a>
        </div>
      )}
      <div className="pdf-pages" ref={holder} hidden={status !== "ready"} />
    </div>
  );
}
