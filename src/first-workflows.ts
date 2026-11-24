import { FIRST_WORKFLOW_IDS, readFirstWorkflowId } from "./first-workflow-intent";

export { withFirstWorkflow } from "./first-workflow-intent";

export const FIRST_WORKFLOWS = [
  {
    id: FIRST_WORKFLOW_IDS.tickets,
    label: "Handle support or reports",
    feature: "Tickets",
    outcome: "Give members one private way to contact your staff.",
    requirements: [
      "A panel channel, private Ticket category, transcript channel and support role.",
      "HAF needs Manage Channels and permission to view, send and read history in the relevant channels.",
    ],
    completion: "Save one Ticket type and publish its panel.",
    memberTest:
      "As a non-staff member, open and close a test Ticket. Check access is limited to the requester and staff, and staff receive the transcript.",
  },
  {
    id: FIRST_WORKFLOW_IDS.verification,
    label: "Verify new members",
    feature: "Member Verification",
    outcome:
      "Grant a Discord role when a member uses the Verify button. The button does not prove identity.",
    requirements: [
      "A welcome channel that new members can see and a role to grant after they use the button.",
      "HAF needs permission to post in that channel and Manage Roles, with its role above the role it grants.",
    ],
    completion:
      "Save channel delivery with the Discord button and check that the welcome panel appears.",
    memberTest:
      "From a non-admin account without the role, select Verify and confirm the role is granted.",
  },
  {
    id: FIRST_WORKFLOW_IDS.lfg,
    label: "Help members find groups",
    feature: "LFG",
    outcome: "Give players a shared noticeboard to find teammates.",
    requirements: [
      "A text channel members can view and a game or activity they can choose.",
      "HAF needs permission to view the channel and send and embed messages there.",
    ],
    completion: "Save one activity and publish the noticeboard.",
    memberTest:
      "As a non-admin member, use the noticeboard to create and close a harmless test post.",
  },
  {
    id: FIRST_WORKFLOW_IDS.mentions,
    label: "Reduce unwanted mentions",
    feature: "Mention Protection",
    outcome:
      "Start by warning on unwanted staff mentions. Broader mention-spam detection is a paid option.",
    requirements: [
      "A private test channel and a test role to protect.",
      "HAF needs permission to view the channel and send a warning reply there.",
    ],
    completion:
      "Scope Admin Mention Protection to the test channel, choose the protected role and save a warning-only response.",
    memberTest:
      "Use a non-admin account to mention a consenting test member with that role and confirm HAF replies.",
  },
  {
    id: FIRST_WORKFLOW_IDS.playerLink,
    label: "Connect game accounts",
    feature: "Player Link",
    outcome: "Let members connect their Steam account to Discord.",
    requirements: [
      "A panel channel and a role to grant after linking.",
      "HAF needs permission to post in that channel and Manage Roles, with its role above the role it grants.",
    ],
    completion: "Enable Steam, save its configuration and publish the link panel.",
    memberTest:
      "As a non-admin member, link a test Steam account and confirm the linked role is granted.",
  },
  {
    id: FIRST_WORKFLOW_IDS.messages,
    label: "Keep announcements current",
    feature: "Managed Messages",
    outcome: "Publish one Discord message staff can update in place.",
    requirements: [
      "A text channel members can view.",
      "HAF needs permission to view the channel and send and embed messages there.",
    ],
    completion: "Publish a short test message with mentions turned off.",
    memberTest:
      "From a non-admin account, check the message is visible. After a staff edit and publish, check the same message was updated.",
  },
] as const;

export type FirstWorkflow = (typeof FIRST_WORKFLOWS)[number];

export function findFirstWorkflow(id: string | null | undefined): FirstWorkflow | undefined {
  return FIRST_WORKFLOWS.find((workflow) => workflow.id === id);
}

export function readFirstWorkflow(search: string): FirstWorkflow | undefined {
  return findFirstWorkflow(readFirstWorkflowId(search));
}
