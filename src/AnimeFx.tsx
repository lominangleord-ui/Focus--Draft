/* Motion layer for the "Anime" theme — powered by Anime.js v4.
   Manga speed lines behind the timer, drifting petals and an impact ring that
   fires whenever a session starts. Everything is decorative: the layer is
   aria-hidden, pointer-events are off, and it only mounts for this one theme.
   Motion is skipped entirely when the OS asks for reduced motion. */

import { useEffect, useRef, useState } from "react";
import { animate, createScope, stagger, utils } from "animejs";

const RAY_COUNT = 44;
const PETAL_COUNT = 9;

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

export default function AnimeFx({ running }: { running: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /* Entrance + ambient loops: the burst inks itself in from the centre, the
     whole ray fan turns slowly, and petals drift down for as long as the theme
     is on screen. */
  useEffect(() => {
    if (reduced || !root.current) return;
    const scope = createScope({ root: root.current });

    scope.add(() => {
      animate(".anime-ray-bar", {
        scaleX: [0.05, 1],
        opacity: [0, 1],
        duration: 620,
        delay: stagger(11, { from: "center" }),
        ease: "outExpo",
      });

      animate(".anime-rays", {
        rotate: 360,
        duration: 120000,
        loop: true,
        ease: "linear",
      });

      animate(".anime-petal", {
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
    });

    return () => scope.revert();
  }, [reduced]);

  /* One burst per start: an impact ring plus a flash of the speed lines. */
  useEffect(() => {
    if (reduced || !running || !root.current) return;
    const scope = createScope({ root: root.current });
    const bars = root.current.querySelectorAll(".anime-ray-bar");

    scope.add(() => {
      animate(".anime-impact", {
        scale: [0.55, 1.9],
        opacity: [0.9, 0],
        duration: 1000,
        ease: "outQuad",
      });

      animate(bars, {
        opacity: [1, 0.45, 1],
        duration: 1500,
        delay: stagger(5),
        loop: true,
        ease: "inOutSine",
      });
    });

    return () => {
      scope.revert();
      // Hand the lines back to their resting state instead of the paused frame.
      utils.set(bars, { opacity: 1 });
    };
  }, [running, reduced]);

  return (
    <div className="anime-fx" aria-hidden="true" ref={root} data-reduced={reduced ? "true" : "false"}>
      <div className="anime-halftone" />
      <div className="anime-rays">
        {rays.map((ray, i) => (
          <div
            className="anime-ray"
            key={i}
            style={{ transform: `rotate(${ray.angle}deg)`, ["--ray-len" as string]: `${ray.length}` }}
          >
            <span className="anime-ray-bar" style={{ height: `${ray.weight}px` }} />
          </div>
        ))}
      </div>
      <div className="anime-impact" />
      <div className="anime-petals">
        {petals.map((petal, i) => (
          <span
            className="anime-petal"
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
    </div>
  );
}
