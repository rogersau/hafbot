export interface OneTimeTokenStore {
  consume(input: { nonce: string; expiresAtMs: number; consumedAtMs: number }): Promise<boolean>;
}
