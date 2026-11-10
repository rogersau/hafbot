import type { TicketPanelConfig } from "../../types";
import type { TicketSetupCheckResponse } from "../../runtime/admin-types";
import type { ClosedTicketsPage, TicketsLoaderData } from "./admin-route-loaders";
import { wrapLoaded, type AdminLoaderContext } from "./admin-loader-client";

export async function loadTicketsRoute(ctx: AdminLoaderContext) {
  const { ticketsClient } = await import("../generated/admin-client/tickets");
  const workspaceId =
    new URLSearchParams(ctx.location?.searchStr ?? "").get("workspaceId")?.trim() ?? "";
  const guildId = (ctx.params?.guildId ?? "").trim();
  const selectedPanelId =
    new URLSearchParams(ctx.location?.searchStr ?? "").get("panelId")?.trim() ?? "";
  const query = { workspaceId: workspaceId || undefined, guildId };
  const signal = ctx.abortController?.signal;
  const [resources, panelResponse, closedTicketsPage, setupCheck] = await Promise.all([
    ticketsClient.resources(query, signal),
    ticketsClient.panel(query, signal).catch(() => ({ panel: null, panels: [] })),
    ticketsClient
      .closed(
        {
          ...query,
          limit: "20",
          ...(selectedPanelId ? { panelId: selectedPanelId } : {}),
        },
        signal,
      )
      .catch(emptyClosedTicketsPage),
    ticketsClient
      .setupCheck(
        {
          ...query,
          ...(selectedPanelId ? { panelId: selectedPanelId } : {}),
        },
        signal,
      )
      .catch(() => emptyTicketSetupCheck(guildId)),
  ]);
  const panels =
    panelResponse.panels && panelResponse.panels.length > 0 ? panelResponse.panels : [];
  const selectedPanel =
    panels.find((panel) => panel.panelId === selectedPanelId) ??
    panelResponse.panel ??
    emptyPanelConfig(guildId);

  return wrapLoaded<TicketsLoaderData>({
    resources,
    panel: selectedPanel,
    panels: panels.length > 0 ? panels : [selectedPanel],
    closedTicketsPage,
    setupCheck,
  });
}

function emptyPanelConfig(guildId: string): TicketPanelConfig {
  return {
    guildId,
    panelId: "main",
    panelName: "Main panel",
    panelChannelId: "",
    categoryChannelId: "",
    transcriptChannelId: "",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [],
  };
}

function emptyClosedTicketsPage(): ClosedTicketsPage {
  return { tickets: [], total: 0, nextCursor: null };
}

function emptyTicketSetupCheck(guildId: string): TicketSetupCheckResponse {
  return {
    guildId,
    panelId: null,
    overallStatus: "warning",
    checks: [
      {
        id: "setup-check",
        label: "Setup check",
        status: "warning",
        detail: "Ticket setup checks could not be loaded. Refresh this page and try again.",
      },
    ],
    testActions: [],
  };
}
