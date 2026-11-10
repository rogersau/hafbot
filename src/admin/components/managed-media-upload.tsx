import { MAX_MANAGED_MEDIA_BYTES, isManagedMediaContentType } from "../../managed-media";
import { useAdminApi } from "../hooks/use-admin-api";
import { managedMessagesClient } from "../generated/admin-client/managed-messages";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ManagedMediaUpload({
  id,
  guildId,
  workspaceId,
  value,
  onChange,
  label,
  disabled = false,
}: {
  id: string;
  guildId: string;
  workspaceId?: string;
  value: string;
  onChange: (url: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const { run, loading: uploading, error, setError } = useAdminApi();

  async function upload(file: File) {
    setError(null);
    const contentType = file.type;
    if (!isManagedMediaContentType(contentType)) {
      setError("Use a PNG, JPEG, GIF, or WebP image.");
      return;
    }
    if (file.size === 0) {
      setError("The selected image is empty.");
      return;
    }
    if (file.size > MAX_MANAGED_MEDIA_BYTES) {
      setError("Images must be 8 MB or smaller.");
      return;
    }

    await run(
      async () => {
        return managedMessagesClient.uploadMedia({
          guildId,
          workspaceId,
          filename: file.name,
          contentType,
          dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
        });
      },
      (result) => onChange(result.media.url),
    );
  }

  return (
    <div className="space-y-2">
      <Input
        id={id}
        type="url"
        value={value}
        disabled={disabled || uploading}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Upload {label}</span>
          <Input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="min-w-0"
            disabled={disabled || uploading}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {value ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || uploading}
            onClick={() => onChange("")}
          >
            Clear
          </Button>
        ) : null}
        {uploading ? <span className="text-xs text-muted-foreground">Uploading…</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Upload an image to this Guild&apos;s storage or paste an external URL. Maximum 8 MB.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
