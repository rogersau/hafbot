import type { ComponentType } from "react";
import type { EmojiPickerImplementationProps } from "./emoji-picker-implementation";

let implementationPromise: Promise<ComponentType<EmojiPickerImplementationProps>> | null = null;

export function loadEmojiPickerImplementation() {
  implementationPromise ??= import("./emoji-picker-implementation")
    .then((module) => module.EmojiPickerImplementation)
    .catch((error) => {
      implementationPromise = null;
      throw error;
    });
  return implementationPromise;
}

export function preloadEmojiPickerImplementation() {
  return loadEmojiPickerImplementation();
}

export function resetEmojiPickerImplementation() {
  implementationPromise = null;
}
