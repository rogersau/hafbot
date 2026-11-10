import { Badge } from "./ui/badge";

export interface ConfigurationAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** Infrequent lifecycle actions belong beside the configuration they affect. */
export function ConfigurationActions({
  label,
  enabled,
  actions,
}: {
  label: string;
  enabled?: boolean;
  actions: ConfigurationAction[];
}) {
  return (
    <div className="flex items-center gap-2">
      {enabled !== undefined ? <Badge>{enabled ? "Enabled" : "Disabled"}</Badge> : null}
      <details
        className="relative"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
      >
        <summary
          aria-label={`More actions for ${label}`}
          className="cursor-pointer list-none px-2 py-1 hover:bg-muted"
        >
          ⋯
        </summary>
        <div className="admin-popover-content admin-configuration-menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={(event) => {
                const details = event.currentTarget.closest("details");
                if (details) details.open = false;
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
