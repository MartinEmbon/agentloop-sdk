/**
 * HMAC-SHA256 helper using the Web Crypto API.
 *
 * Why Web Crypto (not `node:crypto`): Cloudflare Workers and Vercel Edge
 * don't expose `node:crypto` by default. Web Crypto is universal — Node
 * 18+, every browser, every Edge runtime.
 *
 * Cost: these functions are async. Python's `hmac.new(...).hexdigest()` is
 * sync; that's one small divergence from the reference implementation.
 * Good tradeoff — we keep the SDK dependency-free and universal.
 */

/**
 * Compute HMAC-SHA256 and return the hex digest.
 * Lowercase hex, 64 chars.
 */
export async function hmacSha256Hex(
  secret: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, msgData);
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}
