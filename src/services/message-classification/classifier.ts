import { createHash } from "node:crypto";
import type { createDecisionRequest } from "./provider.mjs";
import { parseMessageClassificationEnv, type MessageClassificationEnv } from "./env";

const MAX_CONTENT_LENGTH = 8_000;
const REQUEST_TIMEOUT_MS = 5_000;
const TIMEOUT_COOLDOWN_MS = 30_000;
const CACHE_MAX_ENTRIES = 256;
const CACHE_TTL_MS = 5 * 60_000;

export interface MessageClassificationDecision {
  /** Stable identifier that distinguishes this decision in the cache. */
  readonly id: string;
  readonly criteria: string;
}

export type MessageDecisionResult = { probability: number };

const SPAM_DECISION: MessageClassificationDecision = {
  id: "spam",
  criteria: `Mark a Discord message as spam only when it clearly contains unsolicited bulk-style promotion, a scam, phishing, or link bait. Judge the text itself since you have no information about the author, channel, or posting frequency.
Ordinary conversation, legitimate links or promotions, and ambiguous messages are not spam.`,
};

export function createMessageClassifier(environment: Record<string, string | undefined>) {
  const config = parseMessageClassificationEnv(environment);
  let classifier: ReturnType<typeof createClassifier> | undefined;

  /** Returns the probability that untrusted message text meets trusted, code-defined criteria. */
  async function classifyMessage(
    decision: MessageClassificationDecision,
    content: string,
  ): Promise<MessageDecisionResult | null> {
    if (!config || content.length > MAX_CONTENT_LENGTH || !content.trim()) return null;
    try {
      classifier ??= createClassifier(config);
      const probability = await classifier.classify(decision, content);
      return probability === null ? null : { probability };
    } catch {
      return null;
    }
  }

  return {
    classifyMessage,
    classifyMessageSpam: (content: string) => classifyMessage(SPAM_DECISION, content),
  };
}

function createClassifier(config: MessageClassificationEnv) {
  // Keep the provider SDK imports in ESM for the CommonJS test build.
  const requestDecision = import("./provider.mjs").then(({ createDecisionRequest }) =>
    createDecisionRequest(config),
  );
  const cache = new Map<string, { expiresAt: number; probability: Promise<number | null> }>();

  let retryAfter = 0;
  return {
    async classify({ id, criteria }: MessageClassificationDecision, content: string) {
      // Include the criteria so revisions to the same decision get their own cache entries.
      const key = createHash("sha256")
        .update(JSON.stringify([id, criteria, content]))
        .digest("hex");
      const now = Date.now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) return cached.probability;
      if (now < retryAfter) return null;
      cache.delete(key);
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      const entry = {
        expiresAt: now + CACHE_TTL_MS,
        probability: readDecision(requestDecision, criteria, content, () => {
          retryAfter = Date.now() + TIMEOUT_COOLDOWN_MS;
        }),
      };
      cache.set(key, entry);

      const probability = await entry.probability;
      if (probability === null && cache.get(key) === entry) cache.delete(key);
      return probability;
    },
  };
}

async function readDecision(
  requestDecision: Promise<ReturnType<typeof createDecisionRequest>>,
  criteria: string,
  content: string,
  onTimeout: () => void,
): Promise<number | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve(null);
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([
      requestDecision.then((classify) => {
        controller.signal.throwIfAborted();
        return classify(criteria, content, controller.signal);
      }),
      deadline,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
