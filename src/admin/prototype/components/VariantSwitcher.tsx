/* PROTOTYPE — throwaway. Floating bottom bar that cycles variants via the
   ?variant= search param. Hidden in production builds. */

import { useEffect } from "react";

export interface VariantMeta {
  key: string;
  name: string;
  blurb: string;
}

export function VariantSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: VariantMeta[];
  current: string;
  onChange: (key: string) => void;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const meta = variants[index];

  const cycle = (delta: number) => {
    const next = (index + delta + variants.length) % variants.length;
    onChange(variants[next].key);
  };

  // eslint-disable-next-line custom/no-use-effect -- Global keyboard cycling for the prototype bar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="prototype-switcher" role="group" aria-label="Prototype variant switcher">
      <button
        type="button"
        className="prototype-switcher__arrow"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
      >
        ←
      </button>
      <div className="prototype-switcher__label">
        <strong>
          {meta.key} — {meta.name}
        </strong>
        <span>{meta.blurb}</span>
      </div>
      <span className="prototype-switcher__tag">Prototype</span>
      <button
        type="button"
        className="prototype-switcher__arrow"
        aria-label="Next variant"
        onClick={() => cycle(1)}
      >
        →
      </button>
    </div>
  );
}
