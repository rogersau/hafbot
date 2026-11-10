import {
  deleteManagedMessage,
  getManagedMessageCapabilities,
  getManagedMessageResources,
  listManagedMessages,
  saveManagedMessage,
  uploadManagedMessageMedia,
} from "./managed-messages";
import {
  deleteMessageTemplate,
  listMessageTemplates,
  saveMessageTemplate,
} from "./message-templates";
import {
  createTicketPanel,
  deleteTicketPanel,
  getTicketPanel,
  getTicketResources,
  getTicketSetupCheck,
  getTicketPanelRevision,
  listTicketPanelRevisions,
  listClosedTickets,
  publishTicketPanel,
  previewTicketPanelRevisionRestore,
  revokeTicketTranscript,
  restoreTicketPanelRevision,
  rotateTicketTranscript,
  runTicketTestAction,
  saveTicketPanel,
  unpublishTicketPanel,
} from "./tickets";
import {
  getWebhookProxy,
  getWebhookProxyIngressHealth,
  revealWebhookProxyBanCredential,
  saveWebhookProxy,
  revealWebhookProxyCredential,
  deleteWebhookProxy,
  listWebhookProxyLogs,
} from "./webhook-proxy";
import {
  addEventSignup,
  archiveEvent,
  assignEventTeamMember,
  cancelEvent,
  commitEventTeamBulkFormation,
  createEvent,
  createEventTeam,
  createEventTemplate,
  exportEventRoster,
  getEvents,
  startEventRecurrence,
  stopEventRecurrence,
  publishEvent,
  previewEventTeamBulkFormation,
  overrideEventTeam,
  removeEventSignup,
  updateEvent,
} from "./events";
import {
  deletePlayerCountServer,
  getPlayerCount,
  savePlayerCountServer,
  setPlayerCountEnabled,
  testPlayerCount,
} from "./player-count";
import {
  getPlayerLink,
  getSteamLink,
  publishPlayerLink,
  publishSteamLink,
  savePlayerLink,
  setPlayerLinkEnabled,
  saveSteamLink,
  syncPlayerLinkRoles,
  syncSteamLinkRoles,
} from "./player-link";
import { billingContracts } from "./billing";
import { crossCuttingContracts } from "./cross-cutting";
import {
  getOperationalIncident,
  getOperationalIncidentCapabilities,
  listOperationalIncidents,
  remediateOperationalIncident,
} from "./operations-incidents";
import { configurationRevisionContracts } from "./configuration-revisions";
import { validateAdminOperationContracts } from "./core";
import { createAdminFeedback } from "./feedback";

export * from "./core";
export * from "./errors";
export * from "./managed-messages";
export * from "./message-templates";
export * from "./tickets";
export * from "./webhook-proxy";
export * from "./events";
export * from "./player-count";
export * from "./player-link";
export * from "./billing";
export * from "./cross-cutting";
export * from "./operations-incidents";
export * from "./configuration-revisions";
export * from "./feedback";

export const adminOperationContracts = [
  crossCuttingContracts.adminOverview,
  billingContracts.get,
  billingContracts.assignmentsGet,
  billingContracts.assignmentsPost,
  billingContracts.cancellation,
  billingContracts.changePrice,
  billingContracts.checkout,
  billingContracts.history,
  billingContracts.portal,
  billingContracts.supportCase,
  billingContracts.supportCases,
  billingContracts.supportOperation,
  billingContracts.sync,
  configurationRevisionContracts.list,
  configurationRevisionContracts.compare,
  configurationRevisionContracts.detail,
  configurationRevisionContracts.export,
  configurationRevisionContracts.restore,
  configurationRevisionContracts.restorePreview,
  crossCuttingContracts.entitlement,
  getEvents,
  createEvent,
  updateEvent,
  archiveEvent,
  cancelEvent,
  publishEvent,
  startEventRecurrence,
  stopEventRecurrence,
  removeEventSignup,
  exportEventRoster,
  addEventSignup,
  createEventTeam,
  commitEventTeamBulkFormation,
  previewEventTeamBulkFormation,
  assignEventTeamMember,
  overrideEventTeam,
  createEventTemplate,
  createAdminFeedback,
  crossCuttingContracts.guildDirectory,
  crossCuttingContracts.guildOverview,
  crossCuttingContracts.guildRbacGet,
  crossCuttingContracts.guildRbacPost,
  deleteManagedMessage,
  listManagedMessages,
  uploadManagedMessageMedia,
  saveManagedMessage,
  getManagedMessageCapabilities,
  getManagedMessageResources,
  deleteMessageTemplate,
  listMessageTemplates,
  saveMessageTemplate,
  getOperationalIncidentCapabilities,
  listOperationalIncidents,
  getOperationalIncident,
  remediateOperationalIncident,
  getPlayerCount,
  deletePlayerCountServer,
  setPlayerCountEnabled,
  savePlayerCountServer,
  testPlayerCount,
  getPlayerLink,
  savePlayerLink,
  setPlayerLinkEnabled,
  publishPlayerLink,
  syncPlayerLinkRoles,
  crossCuttingContracts.productAnalyticsEventPost,
  crossCuttingContracts.productAnalyticsPreferenceGet,
  crossCuttingContracts.productAnalyticsPreferencePost,
  crossCuttingContracts.profileGet,
  crossCuttingContracts.profilePatch,
  getSteamLink,
  saveSteamLink,
  publishSteamLink,
  syncSteamLinkRoles,
  listClosedTickets,
  getTicketPanel,
  saveTicketPanel,
  createTicketPanel,
  deleteTicketPanel,
  publishTicketPanel,
  getTicketPanelRevision,
  restoreTicketPanelRevision,
  previewTicketPanelRevisionRestore,
  listTicketPanelRevisions,
  unpublishTicketPanel,
  getTicketResources,
  getTicketSetupCheck,
  runTicketTestAction,
  revokeTicketTranscript,
  rotateTicketTranscript,
  getWebhookProxy,
  revealWebhookProxyBanCredential,
  saveWebhookProxy,
  revealWebhookProxyCredential,
  deleteWebhookProxy,
  getWebhookProxyIngressHealth,
  listWebhookProxyLogs,
  crossCuttingContracts.workspaceGuildsGet,
  crossCuttingContracts.workspaceGuildsPost,
  crossCuttingContracts.workspaceGuildsDelete,
  crossCuttingContracts.workspaces,
] as const;

validateAdminOperationContracts(adminOperationContracts);

export type AdminOperationId = (typeof adminOperationContracts)[number]["operationId"];
export type RegisteredAdminOperation = (typeof adminOperationContracts)[number];

const adminOperationsById = new Map<string, RegisteredAdminOperation>(
  adminOperationContracts.map((contract) => [contract.operationId, contract]),
);

export function getAdminOperationContract(
  operationId: string,
): RegisteredAdminOperation | undefined {
  return adminOperationsById.get(operationId);
}

export const adminContractArtifact = adminOperationContracts.map(
  ({ operationId, method, path }) => ({ operationId, method, path }),
);
