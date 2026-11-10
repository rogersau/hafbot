import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const { code: output } = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcefile: filename,
  });
  module._compile(output, filename);
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = resolve(root, "docs/generated/admin-api.openapi.json");
const contracts = require(resolve(root, "src/contracts/admin/index.ts"));
const { serializeAdminOpenApiDocument } = require(resolve(root, "src/contracts/admin/openapi.ts"));
const generated = serializeAdminOpenApiDocument();
const clientDirectory = resolve(root, "src/admin/generated/admin-client");
const clientDomains = {
  "configuration-revisions.ts": {
    imports: ["configurationRevisionContracts"],
    contractModules: { configurationRevisionContracts: "configuration-revisions" },
    client: "configurationRevisionsClient",
    methods: [
      ["list", "configurationRevisionContracts.list", "query"],
      ["compare", "configurationRevisionContracts.compare", "query"],
      ["detail", "configurationRevisionContracts.detail", "query"],
      ["export", "configurationRevisionContracts.export", "query"],
      ["restoreRevision", "configurationRevisionContracts.restore", "body"],
      ["restorePreview", "configurationRevisionContracts.restorePreview", "body"],
    ],
  },
  "managed-messages.ts": {
    imports: ["managedMessageContracts", "messageTemplateContracts"],
    contractModules: {
      managedMessageContracts: "managed-messages",
      messageTemplateContracts: "message-templates",
    },
    client: "managedMessagesClient",
    methods: [
      ["list", "managedMessageContracts.list", "query"],
      ["resources", "managedMessageContracts.resources", "query"],
      ["capabilities", "managedMessageContracts.capabilities", "query"],
      ["save", "managedMessageContracts.save", "body"],
      ["uploadMedia", "managedMessageContracts.uploadMedia", "body"],
      ["delete", "managedMessageContracts.delete", "body"],
      ["listTemplates", "messageTemplateContracts.list", "query"],
      ["saveTemplate", "messageTemplateContracts.save", "body"],
      ["deleteTemplate", "messageTemplateContracts.delete", "body"],
    ],
  },
  "tickets.ts": {
    imports: ["ticketContracts"],
    contractModules: { ticketContracts: "tickets" },
    client: "ticketsClient",
    methods: [
      ["panel", "ticketContracts.panel", "query"],
      ["createPanel", "ticketContracts.createPanel", "body"],
      ["savePanel", "ticketContracts.savePanel", "body"],
      ["resources", "ticketContracts.resources", "query"],
      ["closed", "ticketContracts.closed", "query"],
      ["setupCheck", "ticketContracts.setupCheck", "query"],
      ["testAction", "ticketContracts.testAction", "body"],
      ["rotateTranscript", "ticketContracts.rotateTranscript", "body"],
      ["revokeTranscript", "ticketContracts.revokeTranscript", "body"],
      ["publishPanel", "ticketContracts.publishPanel", "body"],
      ["revision", "ticketContracts.revision", "query"],
      ["revisions", "ticketContracts.revisions", "query"],
      ["restorePreview", "ticketContracts.restorePreview", "body"],
      ["restoreRevision", "ticketContracts.restore", "body"],
      ["unpublishPanel", "ticketContracts.unpublishPanel", "body"],
      ["deletePanel", "ticketContracts.deletePanel", "body"],
    ],
  },
  "webhook-proxy.ts": {
    imports: ["webhookProxyContracts"],
    contractModules: { webhookProxyContracts: "webhook-proxy" },
    client: "webhookProxyClient",
    methods: [
      ["get", "webhookProxyContracts.get", "query"],
      ["ingressHealth", "webhookProxyContracts.ingressHealth", "query"],
      ["revealBanCredential", "webhookProxyContracts.revealBanCredential", "body"],
      ["save", "webhookProxyContracts.save", "body"],
      ["revealCredential", "webhookProxyContracts.revealCredential", "body"],
      ["delete", "webhookProxyContracts.delete", "body"],
      ["logs", "webhookProxyContracts.logs", "query"],
    ],
  },
  "events.ts": {
    imports: ["eventsContracts"],
    contractModules: { eventsContracts: "events" },
    client: "eventsClient",
    methods: [
      ["get", "eventsContracts.get", "query"],
      ["startRecurrence", "eventsContracts.startRecurrence", "body"],
      ["stopRecurrence", "eventsContracts.stopRecurrence", "body"],
      ["createTemplate", "eventsContracts.createTemplate", "body"],
      ["create", "eventsContracts.create", "body"],
      ["update", "eventsContracts.update", "body"],
      ["publish", "eventsContracts.publish", "body"],
      ["cancel", "eventsContracts.cancel", "body"],
      ["archive", "eventsContracts.archive", "body"],
      ["signup", "eventsContracts.signup", "body"],
      ["removeSignup", "eventsContracts.removeSignup", "body"],
      ["createTeam", "eventsContracts.createTeam", "body"],
      ["assignTeamMember", "eventsContracts.assignTeamMember", "body"],
      ["overrideTeam", "eventsContracts.overrideTeam", "body"],
      ["exportRoster", "eventsContracts.exportRoster", "query"],
      ["previewBulkFormation", "eventsContracts.previewBulkFormation", "body"],
      ["commitBulkFormation", "eventsContracts.commitBulkFormation", "body"],
    ],
  },
  "player-count.ts": {
    imports: ["playerCountContracts"],
    contractModules: { playerCountContracts: "player-count" },
    client: "playerCountClient",
    methods: [
      ["get", "playerCountContracts.get", "query"],
      ["setEnabled", "playerCountContracts.setEnabled", "body"],
      ["save", "playerCountContracts.save", "body"],
      ["delete", "playerCountContracts.delete", "body"],
      ["test", "playerCountContracts.test", "body"],
    ],
  },
  "player-link.ts": {
    imports: ["playerLinkContracts"],
    contractModules: { playerLinkContracts: "player-link" },
    client: "playerLinkClient",
    methods: [
      ["get", "playerLinkContracts.get", "query"],
      ["setEnabled", "playerLinkContracts.setEnabled", "body"],
      ["save", "playerLinkContracts.save", "body"],
      ["publish", "playerLinkContracts.publish", "body"],
      ["syncRoles", "playerLinkContracts.syncRoles", "body"],
      ["steamGet", "playerLinkContracts.steamGet", "query"],
      ["steamSave", "playerLinkContracts.steamSave", "body"],
      ["steamPublish", "playerLinkContracts.steamPublish", "body"],
      ["steamSyncRoles", "playerLinkContracts.steamSyncRoles", "body"],
    ],
  },
  "billing.ts": {
    imports: ["billingContracts"],
    contractModules: { billingContracts: "billing" },
    client: "billingClient",
    methods: [
      ["get", "billingContracts.get", "query"],
      ["assignments", "billingContracts.assignmentsGet", "query"],
      ["mutateAssignments", "billingContracts.assignmentsPost", "body"],
      ["cancel", "billingContracts.cancellation", "body"],
      ["changePrice", "billingContracts.changePrice", "body"],
      ["checkout", "billingContracts.checkout", "body"],
      ["history", "billingContracts.history", "query"],
      ["portal", "billingContracts.portal", "body"],
      ["supportCase", "billingContracts.supportCase", "query"],
      ["supportCases", "billingContracts.supportCases", "query"],
      ["supportOperation", "billingContracts.supportOperation", "body"],
      ["sync", "billingContracts.sync", "body"],
    ],
  },
  "cross-cutting.ts": {
    imports: ["crossCuttingContracts"],
    contractModules: { crossCuttingContracts: "cross-cutting" },
    client: "crossCuttingClient",
    methods: [
      ["adminOverview", "crossCuttingContracts.adminOverview", "query"],
      ["entitlement", "crossCuttingContracts.entitlement", "query"],
      ["guildDirectory", "crossCuttingContracts.guildDirectory", "query"],
      ["guildOverview", "crossCuttingContracts.guildOverview", "query"],
      ["guildAdminRole", "crossCuttingContracts.guildRbacGet", "query"],
      ["saveGuildAdminRole", "crossCuttingContracts.guildRbacPost", "body"],
      ["createProductAnalyticsEvent", "crossCuttingContracts.productAnalyticsEventPost", "body"],
      [
        "productAnalyticsPreference",
        "crossCuttingContracts.productAnalyticsPreferenceGet",
        "query",
      ],
      [
        "saveProductAnalyticsPreference",
        "crossCuttingContracts.productAnalyticsPreferencePost",
        "body",
      ],
      ["profile", "crossCuttingContracts.profileGet", "query"],
      ["saveProfile", "crossCuttingContracts.profilePatch", "body"],
      ["workspaceGuilds", "crossCuttingContracts.workspaceGuildsGet", "query"],
      ["linkWorkspaceGuild", "crossCuttingContracts.workspaceGuildsPost", "body"],
      ["unlinkWorkspaceGuild", "crossCuttingContracts.workspaceGuildsDelete", "body"],
      ["workspaces", "crossCuttingContracts.workspaces", "query"],
    ],
  },
  "feedback.ts": {
    imports: ["feedbackContracts"],
    contractModules: { feedbackContracts: "feedback" },
    client: "feedbackClient",
    methods: [["create", "feedbackContracts.create", "body"]],
  },
};
const generatedContractIds = new Set(
  Object.values(clientDomains).flatMap((domain) =>
    domain.methods.map(([, expression]) => {
      const [groupName, memberName] = expression.split(".");
      return contracts[groupName]?.[memberName]?.operationId;
    }),
  ),
);
const migratedContractIds = contracts.adminOperationContracts
  .filter((contract) =>
    contract.tags.some((tag) =>
      [
        "Events",
        "Billing",
        "Configuration Revisions",
        "Cross-Cutting",
        "Managed Messages",
        "Player Count",
        "Player Link",
        "Tickets",
        "Webhooks",
        "Feedback",
      ].includes(tag),
    ),
  )
  .map((contract) => contract.operationId);
if (
  generatedContractIds.size !== migratedContractIds.length ||
  migratedContractIds.some((operationId) => !generatedContractIds.has(operationId))
) {
  throw new Error("Generated Admin client operations do not match the migrated contract registry.");
}
const generatedClients = Object.fromEntries(
  Object.entries(clientDomains).map(([fileName, domain]) => [fileName, generateClient(domain)]),
);

function generateClient(domain) {
  for (const [, expression] of domain.methods) {
    const [groupName, memberName] = expression.split(".");
    const contract = contracts[groupName]?.[memberName];
    if (!contract || !contracts.adminOperationContracts.includes(contract)) {
      throw new Error(`Generated Admin client references an unregistered contract: ${expression}`);
    }
  }
  const methods = domain.methods
    .map(([name, expression, input]) => {
      const inputType = `z.input<NonNullable<typeof ${expression}.${input}>>`;
      const declaration = `  ${name}: (${input}: ${inputType}, signal?: AbortSignal) =>`;
      return declaration.length <= 100
        ? `${declaration}\n    callAdminContract(${expression}, { ${input}, signal }),`
        : `  ${name}: (\n    ${input}: ${inputType},\n    signal?: AbortSignal,\n  ) => callAdminContract(${expression}, { ${input}, signal }),`;
    })
    .join("\n");
  const contractImports = Object.entries(domain.contractModules)
    .map(([name, module]) => `import { ${name} } from "../../../contracts/admin/${module}";`)
    .join("\n");
  return `// Generated by scripts/admin-contract/generate.mjs. Do not edit.\nimport { z } from "zod";\n${contractImports}\nimport { callAdminContract } from "./core";\n\nexport const ${domain.client} = {\n${methods}\n};\n`;
}

if (process.argv.includes("--check")) {
  let current;
  try {
    current = readFileSync(outputPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Admin OpenAPI artifact is missing: ${outputPath}`);
    }
    throw error;
  }
  if (current !== generated) {
    throw new Error("Admin OpenAPI artifact has drifted; run `pnpm admin-contract:generate`.");
  }
  for (const [fileName, source] of Object.entries(generatedClients)) {
    const filePath = resolve(clientDirectory, fileName);
    let currentClient;
    try {
      currentClient = readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT")
        throw new Error(`Generated Admin client is missing: ${filePath}`);
      throw error;
    }
    if (currentClient !== source) {
      throw new Error(`Generated Admin client has drifted: ${fileName}`);
    }
  }
} else {
  mkdirSync(clientDirectory, { recursive: true });
  writeFileSync(outputPath, generated);
  for (const [fileName, source] of Object.entries(generatedClients)) {
    writeFileSync(resolve(clientDirectory, fileName), source);
  }
}
