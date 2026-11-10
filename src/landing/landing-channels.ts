export function enhanceLandingChannels(root: ParentNode = document) {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[role=tab][data-channel]"));
  const panels = Array.from(root.querySelectorAll<HTMLElement>("[role=tabpanel][data-panel]"));
  const activeChannel = root.querySelector<HTMLElement>("#active-channel");
  const mobileToggle = root.querySelector<HTMLButtonElement>(".mobile-channel-toggle");
  const mobileBackdrop = root.querySelector<HTMLButtonElement>(".mobile-channel-backdrop");
  const discordConsole = mobileToggle?.closest<HTMLElement>(".discord-console");

  const setMobileNavOpen = (open: boolean) => {
    discordConsole?.toggleAttribute("data-mobile-nav-open", open);
    mobileToggle?.setAttribute("aria-expanded", String(open));
    mobileToggle?.setAttribute("aria-label", open ? "Close channel list" : "Open channel list");
  };

  const messageContent = root.querySelector<HTMLElement>(".message-content");

  const activate = (tab: HTMLButtonElement, focus: boolean) => {
    const channel = tab.dataset.channel;
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== channel;
    if (activeChannel) activeChannel.textContent = tab.textContent?.trim() ?? "";
    if (messageContent) messageContent.scrollTop = 0;
    setMobileNavOpen(false);
    if (focus) tab.focus();
  };

  mobileToggle?.addEventListener("click", () => {
    setMobileNavOpen(!discordConsole?.hasAttribute("data-mobile-nav-open"));
  });
  mobileBackdrop?.addEventListener("click", () => setMobileNavOpen(false));
  mobileToggle?.ownerDocument.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMobileNavOpen(false);
  });

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab, false));
    tab.addEventListener("keydown", (event) => {
      const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowDown" || event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : (index - 1 + tabs.length) % tabs.length;
      activate(tabs[nextIndex]!, true);
    });
  });
}
