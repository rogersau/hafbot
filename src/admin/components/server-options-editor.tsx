import { EmojiPicker, type GuildEmojiResource } from "./emoji-picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface ServerOptionEditorValue {
  id: string;
  label: string;
  emoji: string | null;
}

export function ServerOptionsEditor({
  options,
  emojis = [],
  onChange,
}: {
  options: ServerOptionEditorValue[];
  emojis?: GuildEmojiResource[];
  onChange: (options: ServerOptionEditorValue[]) => void;
}) {
  function updateServer(index: number, patch: Partial<ServerOptionEditorValue>) {
    onChange(
      options.map((server, currentIndex) =>
        currentIndex === index ? { ...server, ...patch } : server,
      ),
    );
  }

  function addServer() {
    onChange([...options, { id: "", label: "", emoji: null }]);
  }

  function removeServer(index: number) {
    onChange(options.filter((_, currentIndex) => currentIndex !== index));
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">Server choices</p>
      <p className="text-xs text-muted-foreground">
        Options members can choose from. The ID is stored internally; the label is shown to members.
      </p>
      {options.map((server, index) => (
        <div key={index} className="grid gap-3 md:grid-cols-[1fr_1.5fr_0.7fr_auto]">
          <Input
            aria-label="Server ID"
            value={server.id}
            onChange={(event) =>
              updateServer(index, { id: event.target.value.trim().toLowerCase() })
            }
            placeholder="server-id"
          />
          <Input
            aria-label="Server label"
            value={server.label}
            onChange={(event) => updateServer(index, { label: event.target.value })}
            placeholder="Server Name"
          />
          <EmojiPicker
            emojis={emojis}
            selectedValue={server.emoji}
            onSelect={(selection) => updateServer(index, { emoji: selection.value })}
          />
          <Button size="sm" variant="outline" onClick={() => removeServer(index)}>
            Remove
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={addServer}>
        Add server
      </Button>
    </div>
  );
}
