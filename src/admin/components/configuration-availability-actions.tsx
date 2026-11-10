import { useState } from "react";
import { ConfigurationActions, type ConfigurationAction } from "./configuration-actions";
import { useConfirmDialog } from "./ui/confirm-dialog";

export function ConfigurationAvailabilityActions({
  label,
  enabled,
  disabled,
  description = "New activity will stop. Saved settings and existing records are kept.",
  onEnabledChange,
  additionalActions = [],
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  description?: string;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
  additionalActions?: ConfigurationAction[];
}) {
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  return (
    <>
      {dialog}
      <ConfigurationActions
        label={label}
        enabled={enabled}
        actions={[
          {
            label: `${enabled ? "Disable" : "Enable"} ${label}`,
            disabled: disabled || busy,
            onSelect: () => {
              void (async () => {
                if (
                  enabled &&
                  !(await confirm({
                    title: `Disable ${label}?`,
                    description,
                    confirmLabel: `Disable ${label}`,
                  }))
                )
                  return;
                setBusy(true);
                try {
                  await onEnabledChange(!enabled);
                } finally {
                  setBusy(false);
                }
              })();
            },
          },
          ...additionalActions,
        ]}
      />
    </>
  );
}
