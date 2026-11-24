export const FIRST_WORKFLOW_IDS = {
  tickets: "tickets",
  verification: "member-verification",
  lfg: "lfg",
  mentions: "mention-protection",
  playerLink: "player-link",
  messages: "managed-messages",
} as const;

export type FirstWorkflowId = (typeof FIRST_WORKFLOW_IDS)[keyof typeof FIRST_WORKFLOW_IDS];

export function readFirstWorkflowId(search: string): FirstWorkflowId | undefined {
  const value = new URLSearchParams(search).get("workflow");
  return Object.values(FIRST_WORKFLOW_IDS).find((id) => id === value);
}

export function withFirstWorkflow(path: string, id: FirstWorkflowId | undefined): string {
  if (!id) return path;
  const [pathnameAndSearch, hash] = path.split("#", 2);
  const [pathname, search] = pathnameAndSearch.split("?", 2);
  const params = new URLSearchParams(search);
  params.set("workflow", id);
  return `${pathname}?${params}${hash ? `#${hash}` : ""}`;
}
