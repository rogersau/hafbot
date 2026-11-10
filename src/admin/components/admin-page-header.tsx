import type { ReactNode } from "react";
import type { AdminPermissionFeature } from "../../runtime/admin-types";
import { copyTextToClipboard } from "../lib/clipboard";
import { FeatureReadiness } from "./feature-readiness";
import { useToast } from "./toast";
import { Button } from "./ui/button";

export interface AdminPageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  readinessFeature?: AdminPermissionFeature;
  selectedGuildId?: string;
  selectedWorkspaceId?: string;
}

export function AdminPageHeader({
  title,
  description,
  actions,
  readinessFeature,
  selectedGuildId = "",
  selectedWorkspaceId = "",
}: AdminPageHeaderProps) {
  const toast = useToast();

  async function copyPageLink() {
    try {
      await copyTextToClipboard(window.location.href);
      toast.success("Page link copied.");
    } catch {
      toast.error("Could not copy the page link.");
    }
  }

  return (
    <header className="admin-workspace-page-header">
      <div className="admin-workspace-page-copy">
        <span>Server administration</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="admin-page-header-actions flex flex-wrap items-center justify-end gap-3">
        {readinessFeature ? (
          <FeatureReadiness
            feature={readinessFeature}
            selectedGuildId={selectedGuildId}
            selectedWorkspaceId={selectedWorkspaceId}
          />
        ) : null}
        <Button type="button" variant="secondary" size="sm" onClick={() => void copyPageLink()}>
          Copy page link
        </Button>
        {actions}
      </div>
    </header>
  );
}
