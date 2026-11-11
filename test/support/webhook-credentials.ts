import { createHash } from "node:crypto";
import type { PlaintextWebhookUrl } from "../../src/security/webhook-credentials";
import type { WebhookCredentialService } from "../../src/security/webhook-credentials/store";
import type { WebhookProxyDestination } from "../../src/types";

const urls = new Map<string, string>();
export function testWebhookCredential(url: string): string {
  const id = `fixture-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
  urls.set(id, url);
  return id;
}
export const testWebhookResolver: Pick<WebhookCredentialService, "resolve"> = {
  async resolve(id) {
    const url = urls.get(id);
    if (!url) throw new Error("Test credential was not registered.");
    return { url: url as PlaintextWebhookUrl, fingerprint: id };
  },
};
export function webhookTargets(destinations: readonly WebhookProxyDestination[]) {
  return destinations.map(({ id, credentialId }) => ({ destinationId: id, credentialId }));
}
