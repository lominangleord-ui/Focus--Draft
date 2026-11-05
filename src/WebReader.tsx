import { useEffect, useRef, useState } from "react";

/* Most large sites (Google, Gemini, ChatGPT, Claude, YouTube, Reddit…) send
   X-Frame-Options / CSP frame-ancestors, which browsers enforce — no page can
   embed them in a frame, and no frame can borrow your real browser session.
   Reader mode sidesteps framing: the page HTML is fetched through a proxy,
   sanitised, and rendered with its real structure (headings, lists, tables,
   images, links) so you can keep reading and clicking without leaving the tab. */

const PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

function absolutise(doc: Document, baseUrl: string) {
  const resolve = (value: string | null) => {
    if (!value) return null;
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return null;
    }
  };
  doc.querySelectorAll("[href]").forEach((el) => {
    const abs = resolve(el.getAttribute("href"));
    if (abs) el.setAttribute("href", abs);
  });
  doc.querySelectorAll("[src]").forEach((el) => {
    const abs = resolve(el.getAttribute("src"));
    if (abs) el.setAttribute("src", abs);
  });
  doc.querySelectorAll("img[srcset]").forEach((el) => el.removeAttribute("srcset"));
}

function sanitize(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,noscript,style,link,meta,iframe,object,embed,svg,form,input,button,nav,footer,header,aside,[role=navigation],[role=banner]")
    .forEach((el) => el.remove());

  // Strip every event handler and inline style so nothing executes or hides content.
  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (attr.name.startsWith("on") || attr.name === "style" || attr.name === "class" || attr.name === "id") {
        el.removeAttribute(attr.name);
      }
    });
  });

  absolutise(doc, baseUrl);
  const main = doc.querySelector("article, main, [role=main]") ?? doc.body;
  return main?.innerHTML ?? "";
}

export default function WebReader({
  url,
  nonce,
  onNavigate,
}: {
  url: string;
  nonce: number;
  onNavigate: (next: string) => void;
}) {
  const [html, setHtml] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setHtml("");

    (async () => {
      let lastError = "";
      for (const build of PROXIES) {
        try {
          const response = await fetch(build(url));
          if (!response.ok) {
            lastError = `Upstream returned ${response.status}.`;
            continue;
          }
          const raw = await response.text();
          if (cancelled) return;
          const clean = sanitize(raw, url);
          if (clean.replace(/<[^>]+>/g, "").trim().length < 40) {
            lastError = "That page needs a login or runs entirely in JavaScript, so there's nothing to read.";
            continue;
          }
          setHtml(clean);
          setStatus("ready");
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : "Network error.";
        }
      }
      if (cancelled) return;
      setMessage(lastError || "Could not load that page.");
      setStatus("error");
    })();

    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  // Intercept in-content link clicks so navigation stays inside the panel.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const href = anchor?.getAttribute("href");
      if (href && /^https?:\/\//i.test(href)) {
        event.preventDefault();
        onNavigate(href);
      }
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [html, onNavigate]);

  return (
    <div className="reader">
      {status === "loading" && <div className="reader-status">Loading {hostname(url)}…</div>}
      {status === "error" && (
        <div className="reader-status error">
          <p>{message}</p>
          <a className="util-go" href={url} target="_blank" rel="noreferrer">Open in a real tab</a>
        </div>
      )}
      {status === "ready" && <div className="reader-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
