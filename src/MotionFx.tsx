/* Illustration + motion layers for the "Illustrated & motion" presets.
   One component, five variants — Kaleido (colour burst), Manga (screentone and
   ink rake), Pop Art (Ben-Day dots and confetti), Bubblegum (rising bubbles) and
   Vaporwave (neon grid and chrome sun).

   Everything here is decorative: the layer is aria-hidden, pointer-events are
   off, and it only mounts for a preset that declares `motion` in src/designs.ts.
   Motion is skipped entirely when the OS asks for reduced motion. */

import { useEffect, useRef, useState } from "react";
import { animate, createScope, stagger, utils } from "animejs";
import type { MotionVariant } from "./designs";

const RAY_COUNT = 44;
const PETAL_COUNT = 9;
const RAKE_COUNT = 22;
const CONFETTI_COUNT = 26;
const BUBBLE_COUNT = 14;
const TWINKLE_COUNT = 10;

const rays = Array.from({ length: RAY_COUNT }, (_, i) => {
  const angle = (360 / RAY_COUNT) * i;
  // A little variety so the burst reads as hand-inked rather than a wheel.
  const length = 0.55 + ((i * 7) % 11) / 18;
  const weight = i % 5 === 0 ? 5 : i % 3 === 0 ? 2 : 3;
  return { angle, length, weight };
});

const petals = Array.from({ length: PETAL_COUNT }, (_, i) => ({
  left: 6 + ((i * 37) % 88),
  size: 13 + ((i * 7) % 12),
  delay: i * 620,
  tint: i % 3 === 0 ? "#ffd7de" : i % 3 === 1 ? "#ffb3c1" : "#fff1e6",
}));

const rakes = Array.from({ length: RAKE_COUNT }, (_, i) => ({
  left: (i / (RAKE_COUNT - 1)) * 100,
  weight: i % 4 === 0 ? 3 : i % 2 === 0 ? 2 : 1,
  delay: (i % 7) * 90,
}));

const confetti = Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
  angle: (360 / CONFETTI_COUNT) * i + (i % 3) * 7,
  distance: 26 + ((i * 13) % 26),
  size: 9 + (i % 4) * 4,
  tint: ["#ff2d55", "#ffd400", "#00b8ff", "#14121c", "#ff7ab8"][i % 5],
  round: i % 3 === 0,
}));

const bubbles = Array.from({ length: BUBBLE_COUNT }, (_, i) => ({
  left: 4 + ((i * 41) % 92),
  size: 26 + ((i * 19) % 74),
  delay: i * 700,
  drift: (i % 2 === 0 ? 1 : -1) * (16 + (i % 5) * 12),
}));

const twinkles = Array.from({ length: TWINKLE_COUNT }, (_, i) => ({
  left: 5 + ((i * 53) % 90),
  top: 6 + ((i * 29) % 82),
  size: 10 + (i % 4) * 6,
  delay: i * 520,
}));

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export default function MotionFx({ variant, running }: { variant: MotionVariant; running: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();

  /* Entrance + ambient loops, one small recipe per variant. */
  useEffect(() => {
    if (reduced || !root.current) return;
    const scope = createScope({ root: root.current });

    scope.add(() => {
      if (variant === "kaleido") {
        animate(".fx-ray-bar", {
          scaleX: [0.05, 1],
          opacity: [0, 1],
          duration: 620,
          delay: stagger(11, { from: "center" }),
          ease: "outExpo",
        });
        animate(".fx-rays", { rotate: 360, duration: 120000, loop: true, ease: "linear" });
        animate(".fx-petal", {
          translateY: [() => -60, () => window.innerHeight + 90],
          translateX: () => utils.random(-90, 90),
          rotate: [() => utils.random(0, 180), () => utils.random(320, 820)],
          opacity: [
            { to: 0.9, duration: 900 },
            { to: 0.85, duration: 2400 },
            { to: 0, duration: 900 },
          ],
          duration: () => utils.random(11000, 17000),
          delay: stagger(640),
          loop: true,
          ease: "linear",
        });
      }

      if (variant === "manga") {
        animate(".fx-rake-bar", {
          scaleY: [0.2, 1],
          opacity: [0, 1],
          duration: 900,
          delay: stagger(26),
          ease: "outQuart",
        });
        animate(".fx-tone", {
          backgroundPosition: ["0 0", "0 260px"],
          duration: 9000,
          loop: true,
          ease: "linear",
        });
        animate(".fx-rake-bar", {
          translateY: [0, () => utils.random(-40, 40)],
          duration: () => utils.random(2600, 5200),
          direction: "alternate",
          loop: true,
          delay: stagger(120),
          ease: "inOutSine",
        });
      }

      if (variant === "pop") {
        animate(".fx-benday", {
          scale: [1, 1.06],
          duration: 2200,
          direction: "alternate",
          loop: true,
          ease: "inOutQuad",
        });
        animate(".fx-starburst", { rotate: [0, 360], duration: 90000, loop: true, ease: "linear" });
        animate(".fx-star-bar", {
          scaleX: [0.4, 1],
          opacity: [0.35, 0.9],
          duration: 1400,
          delay: stagger(60, { from: "center" }),
          direction: "alternate",
          loop: true,
          ease: "inOutSine",
        });
      }

      if (variant === "bubblegum") {
        // Each bubble drifts its own way, so they are animated one by one.
        root.current?.querySelectorAll<HTMLElement>(".fx-bubble").forEach((bubble, i) => {
          animate(bubble, {
            translateY: [0, () => -window.innerHeight * 1.15],
            translateX: () => Number(bubble.dataset.drift ?? 0),
            scale: [0.7, 1.05, 0.85],
            opacity: [
              { to: 0.85, duration: 1200 },
              { to: 0.7, duration: 4200 },
              { to: 0, duration: 1200 },
            ],
            duration: () => utils.random(9000, 14000),
            delay: i * 240,
            loop: true,
            ease: "linear",
          });
        });
        animate(".fx-twinkle", {
          scale: [0.2, 1, 0.2],
          opacity: [0, 1, 0],
          duration: 2600,
          delay: stagger(420),
          loop: true,
          ease: "inOutQuad",
        });
      }

      if (variant === "vaporwave") {
        animate(".fx-grid", {
          backgroundPosition: ["0 0, 0 0", "0 240px, 0 0"],
          duration: 6000,
          loop: true,
          ease: "linear",
        });
        animate(".fx-sun", {
          scale: [1, 1.04],
          opacity: [0.9, 1],
          duration: 3600,
          direction: "alternate",
          loop: true,
          ease: "inOutSine",
        });
        animate(".fx-scan-band", {
          translateY: ["-30vh", "130vh"],
          duration: 7000,
          loop: true,
          ease: "linear",
        });
        animate(".fx-horizon", {
          opacity: [0.35, 0.85],
          duration: 2800,
          direction: "alternate",
          loop: true,
          ease: "inOutSine",
        });
      }
    });

    return () => scope.revert();
  }, [variant, reduced]);

  /* One burst per start: an impact ring plus a flash of whatever moves. */
  useEffect(() => {
    if (reduced || !running || !root.current) return;
    const scope = createScope({ root: root.current });
    const bars = root.current.querySelectorAll(".fx-ray-bar, .fx-rake-bar, .fx-star-bar");

    scope.add(() => {
      animate(".fx-impact", { scale: [0.55, 1.9], opacity: [0.9, 0], duration: 1000, ease: "outQuad" });

      if (variant === "pop") {
        root.current?.querySelectorAll<HTMLElement>(".fx-confetti-bit").forEach((bit, i) => {
          animate(bit, {
            translateX: Number(bit.dataset.x ?? 0),
            translateY: Number(bit.dataset.y ?? 0),
            rotate: () => utils.random(-260, 260),
            opacity: [1, 0],
            scale: [1, 0.6],
            duration: () => utils.random(900, 1500),
            delay: i * 8,
            ease: "outQuad",
          });
        });
      }

      if (bars.length) {
        animate(bars, {
          opacity: [1, 0.45, 1],
          duration: 1500,
          delay: stagger(5),
          loop: true,
          ease: "inOutSine",
        });
      }
    });

    return () => {
      scope.revert();
      // Hand the layers back to their resting state instead of the paused frame.
      utils.set(bars, { opacity: 1 });
    };
  }, [running, reduced, variant]);

  return (
    <div
      className={`motion-fx fx-${variant}`}
      aria-hidden="true"
      ref={root}
      data-reduced={reduced ? "true" : "false"}
    >
      {(variant === "kaleido" || variant === "pop") && <div className="fx-halftone" />}

      {variant === "kaleido" && (
        <>
          <div className="fx-rays">
            {rays.map((ray, i) => (
              <div
                className="fx-ray"
                key={i}
                style={{ transform: `rotate(${ray.angle}deg)`, ["--ray-len" as string]: `${ray.length}` }}
              >
                <span className="fx-ray-bar" style={{ height: `${ray.weight}px` }} />
              </div>
            ))}
          </div>
          <div className="fx-impact" />
          <div className="fx-petals">
            {petals.map((petal, i) => (
              <span
                className="fx-petal"
                key={i}
                style={{
                  left: `${petal.left}%`,
                  width: `${petal.size}px`,
                  height: `${Math.round(petal.size * 0.72)}px`,
                  background: petal.tint,
                }}
              />
            ))}
          </div>
        </>
      )}

      {variant === "manga" && (
        <>
          <div className="fx-tone" />
          <div className="fx-rake">
            {rakes.map((rake, i) => (
              <span
                className="fx-rake-bar"
                key={i}
                style={{ left: `${rake.left}%`, width: `${rake.weight}px`, animationDelay: `${rake.delay}ms` }}
              />
            ))}
          </div>
          <div className="fx-impact" />
        </>
      )}

      {variant === "pop" && (
        <>
          <div className="fx-benday" />
          <div className="fx-starburst">
            {Array.from({ length: 16 }, (_, i) => (
              <div className="fx-star-ray" key={i} style={{ transform: `rotate(${(360 / 16) * i}deg)` }}>
                <span className="fx-star-bar" />
              </div>
            ))}
          </div>
          <div className="fx-impact" />
          <div className="fx-confetti">
            {confetti.map((bit, i) => (
              <span
                className="fx-confetti-bit"
                key={i}
                data-x={Math.round(Math.cos((bit.angle * Math.PI) / 180) * bit.distance * 6)}
                data-y={Math.round(Math.sin((bit.angle * Math.PI) / 180) * bit.distance * 6)}
                style={{
                  width: `${bit.size}px`,
                  height: `${bit.round ? bit.size : bit.size * 0.5}px`,
                  background: bit.tint,
                  borderRadius: bit.round ? "50%" : "2px",
                }}
              />
            ))}
          </div>
        </>
      )}

      {variant === "bubblegum" && (
        <>
          <div className="fx-bubbles">
            {bubbles.map((bubble, i) => (
              <span
                className="fx-bubble"
                key={i}
                data-drift={bubble.drift}
                style={{
                  left: `${bubble.left}%`,
                  bottom: `${6 + ((i * 13) % 74)}%`,
                  width: `${bubble.size}px`,
                  height: `${bubble.size}px`,
                  animationDelay: `${bubble.delay}ms`,
                }}
              />
            ))}
          </div>
          <div className="fx-twinkles">
            {twinkles.map((spark, i) => (
              <span
                className="fx-twinkle"
                key={i}
                style={{
                  left: `${spark.left}%`,
                  top: `${spark.top}%`,
                  width: `${spark.size}px`,
                  height: `${spark.size}px`,
                  animationDelay: `${spark.delay}ms`,
                }}
              />
            ))}
          </div>
        </>
      )}

      {variant === "vaporwave" && (
        <>
          <div className="fx-sun" />
          <div className="fx-grid" />
          <div className="fx-horizon" />
          <div className="fx-scan-band" />
        </>
      )}
    </div>
  );
}
