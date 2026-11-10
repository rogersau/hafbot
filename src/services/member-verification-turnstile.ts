export interface TurnstileSiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

export async function verifyTurnstileToken(token: string, secretKey: string): Promise<boolean> {
  if (!token.trim() || !secretKey.trim()) {
    return false;
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ secret: secretKey, response: token }),
  });

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as TurnstileSiteverifyResponse;
  return data.success === true;
}
