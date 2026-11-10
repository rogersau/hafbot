import type { ReactNode } from "react";
import { Checkbox } from "./ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

type ResourceOption = { id: string; name: string };

export default function ResourceSelectCommand({
  options,
  selected,
  onToggle,
  searchPlaceholder,
  emptyMessage,
  formatOptionLabel,
  children,
}: {
  options: ResourceOption[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  searchPlaceholder: string;
  emptyMessage: string;
  formatOptionLabel: (option: ResourceOption) => string;
  children: ReactNode;
}) {
  return (
    <Command shouldFilter={false} loop>
      <CommandInput placeholder={searchPlaceholder} />
      {children}
      <CommandList>
        <CommandEmpty>{emptyMessage}</CommandEmpty>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem
              key={option.id}
              value={`${option.name} ${option.id}`}
              onSelect={() => onToggle(option.id)}
            >
              <Checkbox
                checked={selected.has(option.id)}
                className="mr-2 border-input bg-background"
                tabIndex={-1}
                aria-hidden="true"
              />
              <span className="truncate">{formatOptionLabel(option)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
