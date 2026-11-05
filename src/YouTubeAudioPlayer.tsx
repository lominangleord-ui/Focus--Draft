import { useEffect, useRef, useState } from "react";

/* Plays a YouTube video or playlist as audio only. The iframe itself always
   decodes video internally — no embed technique can avoid that, it's how
   YouTube's player works — but shrinking it to a single invisible pixel and
   never showing it keeps it out of the layout, off the screen, and out of
   the background entirely, which is the closest any in-page player can get
   to "audio only". Playback is controlled via the iframe's postMessage API
   (enablejsapi=1), so no extra script or API key is required. */

type Meta = { title: string; author: string; thumbnail: string } | null;
type Target = { playlistId: string; videoId: string };

function parseYouTubeTarget(raw: string): Target | null {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "").replace(/^music\./, "");
    if (!/(^|\.)youtube\.com$/.test(host) && host !== "youtu.be") return null;
    const listId = url.searchParams.get("list") ?? "";
    let videoId = url.searchParams.get("v") ?? "";
    if (!videoId && host === "youtu.be") videoId = url.pathname.slice(1);
    if (!videoId && url.pathname.startsWith("/embed/")) videoId = url.pathname.split("/")[2] ?? "";
    if (!videoId && !listId) return null;
    return { playlistId: listId, videoId };
  } catch {
    return null;
  }
}

function MiniIcon({ name }: { name: "prev" | "next" | "play" | "pause" | "note" }) {
  const paths: Record<string, React.ReactNode> = {
    prev: <><path d="M18 5l-9 7 9 7V5z" /><path d="M6 5v14" /></>,
    next: <><path d="M6 5l9 7-9 7V5z" /><path d="M18 5v14" /></>,
    play: <path d="M8 5.5l11 6.5-11 6.5v-13z" />,
    pause: <><rect x="7" y="5" width="4" height="14" rx="1" /><rect x="15" y="5" width="4" height="14" rx="1" /></>,
    note: <path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export default function YouTubeAudioPlayer({ url }: { url: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [meta, setMeta] = useState<Meta>(null);
  const [playing, setPlaying] = useState(true);
  const [volume, setVolume] = useState(70);
  const target = url ? parseYouTubeTarget(url) : null;

  useEffect(() => {
    setMeta(null);
    setPlaying(true);
    if (!url) return;
    let cancelled = false;
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMeta({ title: data.title ?? "YouTube audio", author: data.author_name ?? "", thumbnail: data.thumbnail_url ?? "" });
      })
      .catch(() => {
        /* No metadata — playback still works fine without it. */
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Sync volume/playing state into a fresh player once the iframe (re)loads.
  useEffect(() => {
    const post = (func: string, args: unknown[] = []) => {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
    };
    const id = window.setTimeout(() => post("setVolume", [volume]), 600);
    return () => window.clearTimeout(id);
  }, [url, volume]);

  // Listen for YouTube's own state broadcasts so the play/pause icon stays honest.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "infoDelivery" && typeof payload.info?.playerState === "number") {
          const state = payload.info.playerState;
          if (state === 1) setPlaying(true);
          else if (state === 2) setPlaying(false);
        }
      } catch {
        /* ignore non-JSON messages from other frames */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!target) return null;

  function post(func: string, args: unknown[] = []) {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  }

  const params = new URLSearchParams({
    enablejsapi: "1",
    autoplay: "1",
    playsinline: "1",
    controls: "0",
    modestbranding: "1",
    rel: "0",
  });
  if (target.playlistId) {
    params.set("listType", "playlist");
    params.set("list", target.playlistId);
  }
  const embedPath = target.videoId || "videoseries";
  const src = `https://www.youtube-nocookie.com/embed/${embedPath}?${params.toString()}`;

  return (
    <div className="yt-audio">
      {/* Deliberately shrunk to a single invisible pixel — present so audio
          keeps decoding, but never occupying layout or showing any video. */}
      <iframe
        key={src}
        ref={iframeRef}
        className="yt-audio-frame"
        src={src}
        title="YouTube audio"
        allow="autoplay; encrypted-media"
      />
      <div className="yt-audio-card">
        <div className="yt-audio-art" style={meta?.thumbnail ? { backgroundImage: `url(${meta.thumbnail})` } : undefined}>
          {!meta?.thumbnail && <MiniIcon name="note" />}
        </div>
        <div className="yt-audio-info">
          <strong title={meta?.title ?? "YouTube audio"}>{meta?.title ?? "YouTube audio"}</strong>
          <span>{meta?.author || (target.playlistId ? "Playlist" : "Video")}</span>
        </div>
      </div>
      <div className="yt-audio-controls">
        <button onClick={() => post("previousVideo")} disabled={!target.playlistId} aria-label="Previous track">
          <MiniIcon name="prev" />
        </button>
        <button
          className="yt-audio-play"
          onClick={() => {
            post(playing ? "pauseVideo" : "playVideo");
            setPlaying((value) => !value);
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          <MiniIcon name={playing ? "pause" : "play"} />
        </button>
        <button onClick={() => post("nextVideo")} disabled={!target.playlistId} aria-label="Next track">
          <MiniIcon name="next" />
        </button>
        <input
          className="range"
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
