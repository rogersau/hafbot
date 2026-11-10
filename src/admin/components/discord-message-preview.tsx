import { createElement, useEffect, useState, type ComponentType } from "react";
import { Button } from "./ui/button";
import {
  loadDiscordMessagePreviewImplementation,
  preloadDiscordMessagePreviewImplementation,
  resetDiscordMessagePreviewImplementation,
} from "./discord-message-preview-loader";

export interface DiscordMessagePreviewProps {
  author?: string;
  authorAvatar?: string;
  content?: string;
  embedTitle?: string;
  embedDescription?: string;
  embedColor?: string;
  embedImage?: string;
  embedThumbnail?: string;
  embedFooter?: { text: string; iconUrl?: string };
  embedFields?: Array<{ name: string; value: string; inline?: boolean }>;
  buttons?: Array<{
    label: string;
    emoji?: string;
    variant?: ButtonVariant;
    disabled?: boolean;
  }>;
}

export type ButtonVariant = "primary" | "secondary" | "success" | "danger" | "destructive";

export function DiscordMessagePreview(props: DiscordMessagePreviewProps) {
  const [active, setActive] = useState(false);
  const [implementation, setImplementation] =
    useState<ComponentType<DiscordMessagePreviewProps> | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!active || implementation || loadError) return;
    let current = true;
    void loadDiscordMessagePreviewImplementation().then(
      (component) => current && setImplementation(() => component),
      () => current && setLoadError(true),
    );
    return () => {
      current = false;
    };
  }, [active, implementation, loadError]);

  function preloadPreview() {
    void preloadDiscordMessagePreviewImplementation().catch(() => undefined);
  }

  function retryPreview() {
    resetDiscordMessagePreviewImplementation();
    setLoadError(false);
  }

  if (implementation) return createElement(implementation, props);

  return (
    <div
      className="flex h-[18rem] items-center justify-center rounded-md border border-border bg-muted/20 px-6 text-center"
      onPointerEnter={preloadPreview}
      onFocus={preloadPreview}
      onTouchStart={preloadPreview}
    >
      {loadError ? (
        <div className="space-y-3" role="alert">
          <p className="text-sm text-muted-foreground">The Discord preview could not load.</p>
          <Button type="button" variant="outline" size="sm" onClick={retryPreview}>
            Retry
          </Button>
        </div>
      ) : active ? (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading Discord preview...
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Load the Discord-styled preview when you are ready to review this message.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setActive(true)}>
            Load message preview
          </Button>
        </div>
      )}
    </div>
  );
}
