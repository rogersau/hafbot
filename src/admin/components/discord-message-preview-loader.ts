import type { ComponentType } from "react";
import type { DiscordMessagePreviewProps } from "./discord-message-preview";

let implementationPromise: Promise<ComponentType<DiscordMessagePreviewProps>> | null = null;

export function loadDiscordMessagePreviewImplementation() {
  implementationPromise ??= import("./discord-message-preview-implementation")
    .then((module) => module.DiscordMessagePreviewImplementation)
    .catch((error) => {
      implementationPromise = null;
      throw error;
    });
  return implementationPromise;
}

export function preloadDiscordMessagePreviewImplementation() {
  return loadDiscordMessagePreviewImplementation();
}

export function resetDiscordMessagePreviewImplementation() {
  implementationPromise = null;
}
