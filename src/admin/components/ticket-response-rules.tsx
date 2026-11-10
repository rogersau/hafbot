import type { TicketResponseCondition, TicketResponseRule, TicketTypeConfig } from "../../types";
import { FormField } from "./admin-form-layout";
import { MarkdownEditor } from "./markdown-editor";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export const MAX_RESPONSE_RULES_PER_TYPE = 10;
export const MAX_RESPONSE_CONDITIONS_PER_RULE = 5;

export function getTicketResponseRules(ticketType: TicketTypeConfig): TicketResponseRule[] {
  return ticketType.responseRules ?? [];
}

export function createEmptyResponseRule(): TicketResponseRule {
  return { id: createResponseRuleId(), conditions: [], message: "" };
}

export function createEmptyResponseCondition(): TicketResponseCondition {
  return { kind: "has-role", roleId: "" };
}

export function TicketResponseRuleEditor(props: {
  ticketTypeIndex: number;
  ticketType: TicketTypeConfig;
  roles: Array<{ id: string; name: string }>;
  configuredPlatforms: Array<"steam" | "xbox" | "playstation">;
  disabled: boolean;
  onChange(next: TicketTypeConfig): void;
}) {
  const rules = getTicketResponseRules(props.ticketType);
  const setRules = (responseRules: TicketResponseRule[]) =>
    props.onChange({ ...props.ticketType, responseRules });
  const updateRule = (
    ruleIndex: number,
    updater: (rule: TicketResponseRule) => TicketResponseRule,
  ) => setRules(rules.map((rule, index) => (index === ruleIndex ? updater(rule) : rule)));
  return (
    <fieldset disabled={props.disabled} className="space-y-2 md:col-span-3">
      <legend className="sr-only">Paid ticket response rules</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Response rules</p>
          <p className="text-xs text-muted-foreground">
            Matching rules post one bot message each, in order.
          </p>
        </div>
        {rules.length < MAX_RESPONSE_RULES_PER_TYPE ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRules([...rules, createEmptyResponseRule()])}
          >
            Add response rule
          </Button>
        ) : null}
      </div>
      {rules.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
          No response rules configured. Add a match-all rule with no conditions for a default ticket
          message.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, ruleIndex) => (
            <div
              key={rule.id || `rule-${props.ticketTypeIndex}-${ruleIndex}`}
              className="space-y-3 rounded-md border bg-muted/20 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Rule {ruleIndex + 1}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRules(rules.filter((_, index) => index !== ruleIndex))}
                >
                  Remove rule
                </Button>
              </div>
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    Conditions (all must match)
                  </p>
                  {rule.conditions.length < MAX_RESPONSE_CONDITIONS_PER_RULE ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateRule(ruleIndex, (current) => ({
                          ...current,
                          conditions: [...current.conditions, createEmptyResponseCondition()],
                        }))
                      }
                    >
                      Add condition
                    </Button>
                  ) : null}
                </div>
                {rule.conditions.length === 0 ? (
                  <p className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                    No conditions. This rule always matches.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {rule.conditions.map((condition, conditionIndex) => {
                      const roleId = "roleId" in condition ? condition.roleId : "";
                      const replaceCondition = (next: TicketResponseCondition) =>
                        updateRule(ruleIndex, (current) => ({
                          ...current,
                          conditions: current.conditions.map((value, index) =>
                            index === conditionIndex ? next : value,
                          ),
                        }));
                      return (
                        <div
                          key={`${rule.id}-condition-${conditionIndex}`}
                          className="grid gap-2 md:grid-cols-[170px_1fr_auto]"
                        >
                          <Select
                            value={condition.kind}
                            onValueChange={(kind) =>
                              replaceCondition(
                                kind === "lacks-platform-linked-role"
                                  ? {
                                      kind,
                                      platform:
                                        props.ticketType.defaultTicketLinkPlatform ?? undefined,
                                    }
                                  : { kind: kind as "has-role" | "lacks-role", roleId },
                              )
                            }
                          >
                            <SelectTrigger
                              id={`tp-response-rule-kind-${props.ticketTypeIndex}-${ruleIndex}-${conditionIndex}`}
                              size="sm"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="has-role">Has role</SelectItem>
                              <SelectItem value="lacks-role">Lacks role</SelectItem>
                              <SelectItem value="lacks-platform-linked-role">
                                Lacks platform linked role
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="space-y-1">
                            {condition.kind === "lacks-platform-linked-role" ? (
                              <Select
                                value={condition.platform ?? "default"}
                                onValueChange={(platform) =>
                                  replaceCondition({
                                    kind: "lacks-platform-linked-role",
                                    ...(platform === "default"
                                      ? {}
                                      : { platform: platform as "steam" | "xbox" | "playstation" }),
                                  })
                                }
                              >
                                <SelectTrigger
                                  id={`tp-response-rule-platform-${props.ticketTypeIndex}-${ruleIndex}-${conditionIndex}`}
                                  size="sm"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="default">Use ticket type default</SelectItem>
                                  {props.configuredPlatforms.map((platform) => (
                                    <SelectItem key={platform} value={platform}>
                                      {formatPlatform(platform)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Select
                                value={roleId}
                                onValueChange={(nextRoleId) =>
                                  replaceCondition({ ...condition, roleId: nextRoleId })
                                }
                              >
                                <SelectTrigger
                                  id={`tp-response-rule-role-${props.ticketTypeIndex}-${ruleIndex}-${conditionIndex}`}
                                  size="sm"
                                >
                                  <SelectValue placeholder="Select a role" />
                                </SelectTrigger>
                                <SelectContent>
                                  {roleId && !props.roles.some((role) => role.id === roleId) ? (
                                    <SelectItem value={roleId}>{roleId}</SelectItem>
                                  ) : null}
                                  {props.roles.map((role) => (
                                    <SelectItem key={role.id} value={role.id}>
                                      {role.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {roleId && !props.roles.some((role) => role.id === roleId) ? (
                              <p className="text-xs text-amber-700">
                                This role no longer exists in the guild.
                              </p>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              updateRule(ruleIndex, (current) => ({
                                ...current,
                                conditions: current.conditions.filter(
                                  (_, index) => index !== conditionIndex,
                                ),
                              }))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <FormField
                label="Response message"
                htmlFor={`tp-response-rule-message-${props.ticketTypeIndex}-${ruleIndex}`}
              >
                <MarkdownEditor
                  id={`tp-response-rule-message-${props.ticketTypeIndex}-${ruleIndex}`}
                  flavor="full"
                  rows={4}
                  value={rule.message}
                  onChange={(message) =>
                    updateRule(ruleIndex, (current) => ({ ...current, message }))
                  }
                  placeholder="Thanks {{answer.ign}}! Please run /steamlink before staff jump in."
                  helpText="Use {{answer.question_id}}, {{who}}, and {{when}} in response messages."
                />
              </FormField>
            </div>
          ))}
        </div>
      )}
      {props.ticketType.questions.length > 0 ? (
        <div className="rounded-md border bg-muted/40 px-3 py-2">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            Available answer placeholders:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {props.ticketType.questions.map((question) => (
              <code
                key={question.id}
                className="cursor-copy rounded bg-background px-1.5 py-0.5 text-[11px] font-mono text-foreground select-all"
              >
                {"{{answer." + question.id + "}}"}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

function createResponseRuleId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `response-rule-${Date.now()}`;
}

function formatPlatform(platform: "steam" | "xbox" | "playstation"): string {
  return platform === "steam" ? "Steam" : platform === "xbox" ? "Xbox" : "PlayStation";
}
