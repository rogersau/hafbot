import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode } from "react";
import { changeValue } from "./support/admin-dom-events";
import { withAdminDom } from "./support/admin-dom";
import type { TicketPanelConfig } from "../src/types";

const resources = {
  guildId: "guild-1",
  roles: [],
  categories: [],
  textChannels: [],
  voiceChannels: [],
  forumChannels: [],
};
const scope = { selectedGuildId: "guild-1", selectedWorkspaceId: "workspace-1" };
const panel: TicketPanelConfig = {
  guildId: "guild-1",
  panelId: "main",
  panelChannelId: "channel-1",
  categoryChannelId: "category-1",
  transcriptChannelId: "transcript-1",
  panelEmoji: null,
  panelTitle: "Support",
  panelDescription: null,
  panelFooter: null,
  panelMessageId: null,
  ticketCreationLimit: null,
  ticketLimitRejectionMessage: null,
  enableTicketClaiming: false,
  aiTranscriptSummariesEnabled: false,
  ticketTypes: [],
};

for (const feature of ["Steam", "Evidence Vault", "Image Rules", "Tickets"] as const) {
  test(`${feature} auto-saves a clean switch but keeps unrelated edits in the draft`, async () => {
    await withAdminDom(async (ui) => {
      const { ToastProvider } = await import("../src/admin/components/toast");
      const { resetGuildResourcesCache } = await import("../src/admin/lib/guild-resources-cache");
      resetGuildResourcesCache();
      const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = async (input, init) => {
        const path = String(input).split("?")[0]!;
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push({ path, body });
          return Response.json({ ok: true, panel: { ...panel, ...body }, config: body });
        }
        return Response.json(resources);
      };
      let page: ReactNode;
      let field: string;
      let toggle: string;
      let key: string;
      const value = "Changed draft";
      let expectedPath: string;
      if (feature === "Steam") {
        const { AdminSteamLinkPage } =
          await import("../src/admin/components/admin-steam-link-page");
        page = (
          <AdminSteamLinkPage
            {...scope}
            activePlatform="steam"
            initialData={{
              guildId: "guild-1",
              platform: "steam",
              links: [],
              config: {
                guildId: "guild-1",
                platform: "steam",
                linkedRoleId: null,
                logChannelId: null,
                gameAppIds: [],
                whoisFields: [],
                customLinks: [],
                panelTitle: "",
                panelDescription: "",
                panelButtonLabel: "",
                panelButtonStyle: "Primary",
                panelChannelId: null,
                panelMessageId: null,
                allowRelink: true,
                allowMultipleLinks: false,
                requireRelinkOnRejoin: false,
                updatedAtMs: 1,
              },
            }}
          />
        );
        field = "#steam-panel-title";
        toggle = '[aria-label="Allow relink"]';
        key = "allowRelink";
        expectedPath = "/admin/api/player-link/config";
      } else if (feature === "Evidence Vault") {
        const { AdminEvidenceVaultPage } =
          await import("../src/admin/components/admin-evidence-vault-page");
        page = (
          <AdminEvidenceVaultPage
            {...scope}
            entitlement={null}
            initialData={{
              guildId: "guild-1",
              entitlement: null,
              enumValueUsage: {},
              recordUsage: { used: 0, max: null },
              config: {
                guildId: "guild-1",
                auditChannelId: "audit-1",
                accessRoleIds: [],
                subjectsEnabled: false,
                updatedAtMs: 1,
                evidenceFields: [{ key: "reason", label: "Reason", type: "text" }],
              },
            }}
          />
        );
        field = "#ev-field-label-reason";
        toggle = '[aria-label="Enable Evidence Vault subjects"]';
        key = "subjectsEnabled";
        expectedPath = "/admin/api/evidence-vault/config";
      } else if (feature === "Image Rules") {
        const { AdminImageRulesPage } =
          await import("../src/admin/components/admin-image-rules-page");
        page = (
          <AdminImageRulesPage
            entitlement={null}
            {...scope}
            initialData={{ guildId: "guild-1", entitlement: null, config: null }}
          />
        );
        field = "#ir-topic-description";
        toggle = '[aria-label="Ping mod roles on queue post"]';
        key = "pingOnQueuePost";
        expectedPath = "/admin/api/image-rules/config";
      } else {
        const { AdminTicketsPage } = await import("../src/admin/components/admin-tickets-page");
        const { AdminRouteContextProvider } = await import("../src/admin/routes/page-context");
        const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
          await import("@tanstack/react-router");
        const { DEFAULT_USER_PREFERENCES } = await import("../src/runtime/admin-types");
        const editor = (
          <AdminTicketsPage
            {...scope}
            initialData={{
              resources,
              panel,
              panels: [panel],
              closedTicketsPage: { tickets: [], total: 0, nextCursor: null },
              setupCheck: {
                guildId: "guild-1",
                panelId: "main",
                overallStatus: "ok",
                checks: [],
                testActions: [],
              },
            }}
          />
        );
        const rootRoute = createRootRoute();
        const route = createRoute({
          getParentRoute: () => rootRoute,
          path: "/admin/$guildId/tickets",
          component: () => (
            <AdminRouteContextProvider
              value={{
                currentPath: "/admin/guild-1/tickets",
                currentSearch: "?tab=rules",
                ...scope,
                pathGuildId: "guild-1",
                reactionRulesTab: "blocklist",
                playerLinkPlatform: "steam",
                ticketsTab: "rules",
                commerceTab: "offerings",
                defaultRedirectTarget: null,
                guildDirectory: [],
                guildLookupError: null,
                workspaces: [],
                workspacesLoading: false,
                workspaceLookupError: null,
                guildResourcesRefreshVersion: 0,
                onSelectedGuildChange() {},
                onSelectedWorkspaceChange() {},
                refreshGuildDirectory: async () => {},
                onRefresh: async () => {},
                playstationLinkEnabled: true,
                entitlement: null,
                userProfile: { name: "Admin", email: "", image: "" },
                userPreferences: DEFAULT_USER_PREFERENCES,
                applyUserPreferencesPatch: async () => {},
                pageMetadata: null,
                setPageMetadata() {},
                isRoutePending: false,
              }}
            >
              {editor}
            </AdminRouteContextProvider>
          ),
        });
        const router = createRouter({
          routeTree: rootRoute.addChildren([route]),
          history: createMemoryHistory({ initialEntries: ["/admin/guild-1/tickets?tab=rules"] }),
        });
        await router.load();
        page = <RouterProvider router={router} />;
        field = "#tp-ticket-limit-message";
        toggle = '[role="switch"]';
        key = "enableTicketClaiming";
        expectedPath = "/admin/api/tickets/panel";
      }
      await ui.render(<ToastProvider>{page}</ToastProvider>);
      const control = ui.container.querySelector<HTMLButtonElement>(toggle);
      assert.ok(control, `${feature} switch`);
      const before = control.getAttribute("aria-checked") === "true";
      await act(async () => control.click());
      assert.equal(writes.length, 1, `${feature} clean toggle should save`);
      assert.equal(writes[0]!.path, expectedPath);
      assert.equal(writes[0]!.body[key], !before);
      if (feature === "Tickets") {
        // Enable a creation limit so its rejection-message field is available.
        const limit = ui.container.querySelector<HTMLInputElement>("#tp-ticket-creation-limit");
        assert.ok(limit);
        await act(async () => {
          changeValue(limit, "5");
        });
      }
      const input = ui.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(field);
      assert.ok(input, `${feature} draft field ${field}`);
      await act(async () => {
        changeValue(input, value);
      });
      await act(async () => control.click());
      assert.equal(writes.length, 1, `${feature} dirty draft must not be auto-saved`);
      assert.equal(input.value, value);
      assert.equal(control.getAttribute("aria-checked"), String(before));
      assert.match(ui.container.textContent ?? "", /draft.*Save|Save.*draft/);
      resetGuildResourcesCache();
    });
  });
}
