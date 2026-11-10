import type { ManagedMessageLinkButton } from "../../types";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export default function ManagedMessageLinkButtonEditor({
  buttons,
  onChange,
}: {
  buttons: ManagedMessageLinkButton[];
  onChange: (buttons: ManagedMessageLinkButton[]) => void;
}) {
  const update = (index: number, patch: Partial<ManagedMessageLinkButton>) =>
    onChange(
      buttons.map((button, buttonIndex) =>
        buttonIndex === index ? { ...button, ...patch } : button,
      ),
    );

  function move(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    const next = [...buttons];
    const [button] = next.splice(index, 1);
    next.splice(nextIndex, 0, button!);
    onChange(next);
  }

  return (
    <SettingsBlock>
      <SectionHeader
        title="Link buttons"
        description="Add up to five buttons that open external HTTP or HTTPS links. Link buttons do not trigger bot actions."
      />
      <div className="space-y-4">
        {buttons.map((button, index) => (
          <div key={index} className="space-y-3 rounded-md border p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                label={`Button ${index + 1} label`}
                htmlFor={`managed-message-button-${index}-label`}
                required
              >
                <Input
                  id={`managed-message-button-${index}-label`}
                  maxLength={80}
                  value={button.label}
                  onChange={(event) => update(index, { label: event.currentTarget.value })}
                />
              </FormField>
              <FormField
                label={`Button ${index + 1} emoji`}
                htmlFor={`managed-message-button-${index}-emoji`}
                hint="Optional Unicode emoji, such as 🔗."
              >
                <Input
                  id={`managed-message-button-${index}-emoji`}
                  maxLength={100}
                  value={button.emoji ?? ""}
                  onChange={(event) => update(index, { emoji: event.currentTarget.value })}
                />
              </FormField>
            </div>
            <FormField
              label={`Button ${index + 1} URL`}
              htmlFor={`managed-message-button-${index}-url`}
              required
              hint="Must start with http:// or https://."
            >
              <Input
                id={`managed-message-button-${index}-url`}
                type="url"
                maxLength={512}
                placeholder="https://example.com"
                value={button.url}
                onChange={(event) => update(index, { url: event.currentTarget.value })}
              />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move up
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={index === buttons.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => onChange(buttons.filter((_, buttonIndex) => buttonIndex !== index))}
              >
                Remove button
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={buttons.length >= 5}
          onClick={() => onChange([...buttons, { label: "", url: "" }])}
        >
          Add link button
        </Button>
      </div>
    </SettingsBlock>
  );
}
