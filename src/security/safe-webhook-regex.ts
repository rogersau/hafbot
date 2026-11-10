export function validateWebhookRegex(pattern: string): string | null {
  if (pattern.length > 256) return "Regex patterns cannot exceed 256 characters";
  if (/\\[1-9]/.test(pattern) || /\\k[<{]/.test(pattern))
    return "Regex backreferences are not supported";
  if (/\(\?<([=!])/.test(pattern)) return "Regex lookbehind is not supported";
  // Reject the common catastrophic forms: a quantified group containing a
  // quantifier, and overlapping alternation under a quantifier.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern))
    return "Potentially unsafe nested regex quantifier";
  if (/\(([^|()]+)\|\1[^)]*\)[+*{]/.test(pattern))
    return "Potentially unsafe overlapping regex alternation";
  try {
    new RegExp(pattern);
  } catch {
    return "Invalid regex";
  }
  return null;
}
