// PROTOTYPE — throwaway. Three radically different admin-UI variants on one
// standalone page, switchable via ?variant=A|B|C and the floating bottom bar.
// Run: pnpm prototype:admin  →  http://localhost:5199/?variant=A

import { useCallback, useState } from "react";
import { VariantSwitcher, type VariantMeta } from "./components/VariantSwitcher";
import { MissionControl } from "./variants/MissionControl";
import { Console } from "./variants/Console";
import { Workshop } from "./variants/Workshop";
import { MissionWorkshop } from "./variants/MissionWorkshop";

const VARIANTS: VariantMeta[] = [
  { key: "A", name: "Mission Control", blurb: "Dark telemetry deck · icon rail" },
  { key: "B", name: "Console", blurb: "Light top-nav · table-first" },
  { key: "C", name: "Workshop", blurb: "Tabbed workspace · status bar" },
  { key: "D", name: "Ops Workshop", blurb: "A's look · C's density" },
];

function readVariant(): string {
  const param = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((v) => v.key === param) ? (param as string) : "A";
}

export function App() {
  const [variant, setVariant] = useState(readVariant);

  const changeVariant = useCallback((key: string) => {
    setVariant(key);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return (
    <>
      {variant === "A" && <MissionControl />}
      {variant === "B" && <Console />}
      {variant === "C" && <Workshop />}
      {variant === "D" && <MissionWorkshop />}
      <VariantSwitcher variants={VARIANTS} current={variant} onChange={changeVariant} />
    </>
  );
}
