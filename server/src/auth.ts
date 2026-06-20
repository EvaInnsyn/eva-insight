/**
 * Bearer auth + per-user metering helpers.
 *
 * Two paths:
 *   1. Bearer token starts with `tok_` → look up in DB, enforce cap.
 *   2. Bearer token equals EVA_INSIGHT_SHARED_SECRET → unlimited dev
 *      fallback (so the founder doesn't lock themselves out while
 *      developing).
 */

import type { Context } from "hono";
import {
  findUserByToken,
  overCap,
  rolloverIfNeeded,
  type User,
} from "./db.js";

export interface AuthResult {
  /** User from DB if this was a per-user token. */
  user: User | null;
  /** True when authed via the dev fallback shared secret. */
  devUnlimited: boolean;
}

export function authenticate(
  authHeader: string | undefined,
  sharedSecret: string,
): AuthResult | { error: { type: string; message: string; status: 401 | 402 | 429 } } {
  const expected = "Bearer ";
  if (!authHeader || !authHeader.startsWith(expected)) {
    return {
      error: {
        type: "authentication_error",
        message: "missing or malformed Authorization header",
        status: 401,
      },
    };
  }
  const token = authHeader.slice(expected.length).trim();

  if (token.startsWith("tok_")) {
    const user = findUserByToken(token);
    if (!user) {
      return {
        error: {
          type: "authentication_error",
          message: "unknown token — ask the admin for a new pairing token",
          status: 401,
        },
      };
    }
    if (user.revoked_at) {
      return {
        error: {
          type: "authentication_error",
          message: "this pairing token has been revoked",
          status: 401,
        },
      };
    }
    const current = rolloverIfNeeded(user);
    if (overCap(current)) {
      return {
        error: {
          type: "monthly_cap_reached",
          message: `monthly token cap reached for ${current.name} — resets at the start of next UTC month`,
          status: 429,
        },
      };
    }
    return { user: current, devUnlimited: false };
  }

  // Dev fallback
  if (sharedSecret && token === sharedSecret) {
    return { user: null, devUnlimited: true };
  }

  return {
    error: {
      type: "authentication_error",
      message: "invalid bearer token",
      status: 401,
    },
  };
}

export function authErrorResponse(
  c: Context,
  err: { type: string; message: string; status: 401 | 402 | 429 },
) {
  return c.json(
    { error: { type: err.type, message: err.message } },
    err.status,
  );
}
