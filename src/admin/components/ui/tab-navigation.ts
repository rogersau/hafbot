import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

function enabledTabs(list: HTMLDivElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
    (tab) =>
      !tab.disabled &&
      tab.getAttribute("aria-disabled") !== "true" &&
      tab.closest('[role="tablist"]') === list,
  );
}

function setTabStop(list: HTMLDivElement, target?: HTMLButtonElement) {
  for (const tab of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    if (tab.closest('[role="tablist"]') === list) tab.tabIndex = tab === target ? 0 : -1;
  }
}

/** Keep focus usable even when a controlled tab change is delayed or cancelled. */
export function useTabNavigation() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const tabs = enabledTabs(list);
    const target =
      tabs.find((tab) => tab === list.ownerDocument.activeElement) ??
      tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ??
      tabs[0];
    setTabStop(list, target);
    const focused = list.ownerDocument.activeElement;
    if (
      focused?.getAttribute("role") === "tab" &&
      list.contains(focused) &&
      !tabs.includes(focused as HTMLButtonElement)
    )
      target?.focus();
  });

  function onFocusCapture(event: FocusEvent<HTMLDivElement>) {
    const tabs = enabledTabs(event.currentTarget);
    const focused = tabs.find((tab) => tab === event.currentTarget.ownerDocument.activeElement);
    if (focused) setTabStop(event.currentTarget, focused);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const tabs = enabledTabs(event.currentTarget);
    const index = tabs.findIndex((tab) => tab === event.target);
    if (index < 0) return;
    const vertical = event.currentTarget.getAttribute("aria-orientation") === "vertical";
    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === (vertical ? "ArrowDown" : "ArrowRight"))
      nextIndex = (index + 1) % tabs.length;
    else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft"))
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    const target = tabs[nextIndex];
    target.focus();
    if (target !== tabs[index]) target.click();
  }

  return { ref, onFocusCapture, onKeyDown };
}
