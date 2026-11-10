import type { TicketQuestion } from "../../types";
import {
  DISCORD_MODAL_LABEL_MAX_LENGTH,
  DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH,
} from "../../discord/constants";
import { FormField } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function createEmptyTicketQuestion(index: number): TicketQuestion {
  return {
    id: `question-${index + 1}`,
    label: "",
    style: "short",
    placeholder: null,
    required: true,
    validation: "none",
  };
}

export function TicketQuestionList(props: {
  ticketTypeIndex: number;
  questions: TicketQuestion[];
  questionKeys: string[];
  openQuestions: Set<string>;
  onAdd(): void;
  onOpenChange(key: string, open: boolean): void;
  onMove(questionIndex: number, direction: -1 | 1): void;
  onRemove(questionIndex: number, key: string): void;
  onUpdate(questionIndex: number, updater: (question: TicketQuestion) => TicketQuestion): void;
}) {
  const { ticketTypeIndex, questions } = props;
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Modal questions</p>
          <p className="text-xs text-muted-foreground">
            Up to five questions appear before the ticket opens.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={props.onAdd}>
          Add question
        </Button>
      </div>
      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No questions configured yet. Add a question to collect ticket details from members.
        </p>
      ) : (
        <div className="space-y-2">
          {questions.map((question, questionIndex) => {
            const questionKey =
              props.questionKeys[questionIndex] ??
              `ticket-question-fallback-${ticketTypeIndex}-${questionIndex}`;
            return (
              <details
                key={questionKey}
                className="group rounded-md border bg-muted/20"
                open={props.openQuestions.has(questionKey)}
                onToggle={(event) => props.onOpenChange(questionKey, event.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:hidden">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {question.label || `Question ${questionIndex + 1}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {question.style === "paragraph" ? "Paragraph" : "Short"} ·{" "}
                      {question.required ? "Required" : "Optional"}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-muted-foreground group-open:hidden">
                    Open
                  </span>
                  <span className="hidden shrink-0 text-xs font-medium text-muted-foreground group-open:inline">
                    Close
                  </span>
                </summary>
                <div className="space-y-3 border-t p-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Move ${question.label || `Question ${questionIndex + 1}`} up`}
                      disabled={questionIndex === 0}
                      onClick={() => props.onMove(questionIndex, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Move ${question.label || `Question ${questionIndex + 1}`} down`}
                      disabled={questionIndex === questions.length - 1}
                      onClick={() => props.onMove(questionIndex, 1)}
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => props.onRemove(questionIndex, questionKey)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <FormField
                      label="Question label"
                      htmlFor={`tp-question-label-${ticketTypeIndex}-${questionIndex}`}
                      error={
                        question.label.length > DISCORD_MODAL_LABEL_MAX_LENGTH
                          ? `Question label must be ${DISCORD_MODAL_LABEL_MAX_LENGTH} characters or fewer.`
                          : undefined
                      }
                    >
                      <div className="space-y-1">
                        <Input
                          id={`tp-question-label-${ticketTypeIndex}-${questionIndex}`}
                          className="h-9"
                          value={question.label}
                          maxLength={DISCORD_MODAL_LABEL_MAX_LENGTH}
                          onChange={(event) =>
                            props.onUpdate(questionIndex, (current) => ({
                              ...current,
                              label: event.target.value,
                            }))
                          }
                          placeholder="Why are you opening this ticket?"
                        />
                        <p className="text-right text-xs text-muted-foreground">
                          {question.label.length} / {DISCORD_MODAL_LABEL_MAX_LENGTH} characters
                        </p>
                      </div>
                    </FormField>
                    <FormField
                      label="Question ID"
                      htmlFor={`tp-question-id-${ticketTypeIndex}-${questionIndex}`}
                      error={
                        question.id.length > DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH
                          ? `Question ID must be ${DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH} characters or fewer.`
                          : undefined
                      }
                    >
                      <div className="space-y-1">
                        <Input
                          id={`tp-question-id-${ticketTypeIndex}-${questionIndex}`}
                          className="h-9"
                          value={question.id}
                          maxLength={DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH}
                          onChange={(event) =>
                            props.onUpdate(questionIndex, (current) => ({
                              ...current,
                              id: event.target.value,
                            }))
                          }
                          placeholder="reason"
                        />
                        <p className="text-right text-xs text-muted-foreground">
                          {question.id.length} / {DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH}{" "}
                          characters
                        </p>
                      </div>
                    </FormField>
                    <FormField
                      label="Question style"
                      htmlFor={`tp-question-style-${ticketTypeIndex}-${questionIndex}`}
                    >
                      <Select
                        value={question.style}
                        onValueChange={(value) =>
                          props.onUpdate(questionIndex, (current) => ({
                            ...current,
                            style: value as TicketQuestion["style"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id={`tp-question-style-${ticketTypeIndex}-${questionIndex}`}
                          size="sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="short">Short</SelectItem>
                          <SelectItem value="paragraph">Paragraph</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField
                      label="Question validation"
                      htmlFor={`tp-question-validation-${ticketTypeIndex}-${questionIndex}`}
                    >
                      <Select
                        value={question.validation ?? "none"}
                        onValueChange={(value) =>
                          props.onUpdate(questionIndex, (current) => ({
                            ...current,
                            validation: value as TicketQuestion["validation"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id={`tp-question-validation-${ticketTypeIndex}-${questionIndex}`}
                          size="sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="steamId">Steam ID</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField
                      label="Placeholder"
                      htmlFor={`tp-question-placeholder-${ticketTypeIndex}-${questionIndex}`}
                      error={
                        (question.placeholder?.length ?? 0) >
                        DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH
                          ? `Placeholder must be ${DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH} characters or fewer.`
                          : undefined
                      }
                    >
                      <div className="space-y-1">
                        <Input
                          id={`tp-question-placeholder-${ticketTypeIndex}-${questionIndex}`}
                          className="h-9"
                          value={question.placeholder ?? ""}
                          maxLength={DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH}
                          onChange={(event) =>
                            props.onUpdate(questionIndex, (current) => ({
                              ...current,
                              placeholder: event.target.value || null,
                            }))
                          }
                          placeholder="Explain the situation"
                        />
                        <p className="text-right text-xs text-muted-foreground">
                          {question.placeholder?.length ?? 0} /{" "}
                          {DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH} characters
                        </p>
                      </div>
                    </FormField>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={question.required}
                      onCheckedChange={(checked) =>
                        props.onUpdate(questionIndex, (current) => ({
                          ...current,
                          required: checked === true,
                        }))
                      }
                    />
                    Required
                  </label>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
