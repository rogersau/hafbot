import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface CommerceBrandingDraft {
  accentColor: number;
  tagline: string;
}

export default function AdminCommerceBrandingSettings({
  sellerConnected,
  branding,
  onChange,
  busyAction,
  onValidationError,
  onReset,
  onSave,
}: {
  sellerConnected: boolean;
  branding: CommerceBrandingDraft;
  onChange: (draft: CommerceBrandingDraft) => void;
  busyAction: string | null;
  onValidationError: (message: string) => void;
  onReset: () => Promise<boolean>;
  onSave: (accentColor: number, tagline: string) => Promise<boolean>;
}) {
  async function save() {
    await onSave(branding.accentColor, branding.tagline.trim());
  }

  async function reset() {
    if (await onReset()) onChange({ accentColor: 0x5865f2, tagline: "" });
  }

  return (
    <SettingsBlock>
      <SectionHeader title="Branding" />
      {sellerConnected ? (
        <>
          <p className="text-sm text-muted-foreground">
            Your server name and icon come from Discord. Choose an accent colour and a short welcome
            message for the HAF storefront.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Accent colour" htmlFor="commerce-branding-accent">
              <input
                id="commerce-branding-accent"
                type="color"
                value={formatAccent(branding.accentColor)}
                onChange={(event) => {
                  const accentColor = parseAccent(event.target.value);
                  if (accentColor === null) {
                    onValidationError("Choose a valid six-digit accent colour.");
                    return;
                  }
                  onChange({ ...branding, accentColor });
                }}
                className="h-9 w-16 rounded-[3px] border border-input bg-background p-1"
              />
            </FormField>
            <FormField label="Short welcome message" htmlFor="commerce-branding-tagline">
              <Input
                id="commerce-branding-tagline"
                value={branding.tagline}
                maxLength={160}
                onChange={(event) => onChange({ ...branding, tagline: event.target.value })}
              />
            </FormField>
          </div>
          <div
            className="border border-border"
            style={{
              background: `linear-gradient(135deg, ${formatAccent(branding.accentColor)} 0%, #171b24 72%)`,
            }}
          >
            <div className="p-5 text-white">
              <p className="text-xl font-semibold">Discord community</p>
              <p className="text-sm text-white/80">
                {branding.tagline.trim() || "No welcome message."}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void reset()}
              disabled={Boolean(busyAction)}
            >
              Reset
            </Button>
            <Button type="button" onClick={() => void save()} disabled={Boolean(busyAction)}>
              {busyAction === "branding" ? "Saving…" : "Save branding"}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect a seller account before configuring the public storefront.
        </p>
      )}
    </SettingsBlock>
  );
}

function parseAccent(value: string): number | null {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return Number.parseInt(normalized, 16);
}

function formatAccent(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(value)))
    .toString(16)
    .padStart(6, "0")}`;
}
