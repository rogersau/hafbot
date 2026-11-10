import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { useToast } from "./toast";
import { AdminErrorNotice } from "./admin-error-notice";
import { Button } from "./ui/button";

export function ProductAnalyticsPreferenceCard({
  selectedWorkspaceId,
  selectedGuildId,
  initialEnabled,
  loadError,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialEnabled?: boolean;
  loadError?: unknown;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [readError, setReadError] = useState<unknown>(loadError);
  const toast = useToast();

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      const preference = await crossCuttingClient.productAnalyticsPreference({
        workspaceId: selectedWorkspaceId.trim() || undefined,
        guildId: selectedGuildId,
      });
      setEnabled(preference.enabled);
      setReadError(null);
    } catch (error) {
      setReadError(error);
    } finally {
      setRetrying(false);
    }
  }

  async function save(nextEnabled: boolean) {
    if (saving || enabled === undefined) return;
    const previous = enabled;
    setEnabled(nextEnabled);
    setSaving(true);
    try {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      const saved = await crossCuttingClient.saveProductAnalyticsPreference({
        workspaceId: selectedWorkspaceId.trim() || undefined,
        guildId: selectedGuildId,
        enabled: nextEnabled,
      });
      setEnabled(saved.enabled);
      toast.success(
        saved.enabled ? "Anonymous product usage enabled." : "Product usage sharing disabled.",
      );
    } catch (error) {
      setEnabled(previous);
      toast.error(
        error instanceof Error ? error.message : "Could not update product usage sharing.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Privacy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {readError ? (
          <div className="space-y-2">
            <p className="text-sm">
              The privacy setting could not be loaded. Other Guild Settings are available.
            </p>
            <AdminErrorNotice error={readError} />
            <Button
              type="button"
              variant="outline"
              loading={retrying}
              disabled={retrying}
              onClick={() => void retry()}
            >
              Retry privacy setting
            </Button>
          </div>
        ) : null}
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <Label htmlFor="share-anonymous-product-usage">Share anonymous product usage</Label>
            <p className="text-sm text-muted-foreground">
              Share pseudonymous Guild-level setup and feature outcomes to help improve HAF. This
              never includes Discord content, member identities, configuration values, security
              records, billing records, or Guild Audit Log events.
            </p>
          </div>
          <Switch
            id="share-anonymous-product-usage"
            checked={enabled}
            disabled={enabled === undefined}
            loading={saving}
            onCheckedChange={(value) => void save(value)}
            aria-label="Share anonymous product usage"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Disabling this stops future product analytics for this Guild. Existing events expire after
          13 months and can be deleted earlier through HAF support.
        </p>
      </CardContent>
    </Card>
  );
}
