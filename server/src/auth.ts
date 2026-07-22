/**
 * Bearer auth + per-user metering helpers.
 *
 * Three paths, tried in order:
 *   1. Bearer token is a Supabase JWT → validate via JWKS, auto-create user.
 *   2. Bearer token starts with `tok_` → look up in DB, enforce cap.
 *   3. Bearer token equals EVA_INSIGHT_SHARED_SECRET → unlimited dev fallback.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context } from "hono";
import {
  findOrCreateUserBySupabaseId,
  findUserByToken,
  overCap,
  rolloverIfNeeded,
  type User,
} from "./db.js";
import { loadEnv } from "./env.js";

export interface AuthResult {
  user: User | null;
  devUnlimited: boolean;
  /**
   * Innanhúss-aðgangur (EVA_INTERNAL_EMAILS): skips every credit/cap check
   * and is never charged — usage bills straight to the Anthropic console.
   */
  internal?: boolean;
}

/** Is this email on the innanhúss list (EVA_INTERNAL_EMAILS, case-insensitive)? */
export function isInternalEmail(email: string | null | undefined): boolean {
  const raw = loadEnv().EVA_INTERNAL_EMAILS;
  if (!raw || !email) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

/**
 * User matches the innanhúss list via the stored name (legacy admin-created
 * rows use a display name, so JWT-auth also checks the token's email claim).
 */
export function isInternalUser(user: User): boolean {
  return isInternalEmail(user.name);
}

type AuthError = { error: { type: string; message: string; status: 401 | 402 | 429 } };

// Cache the JWKS fetcher per Supabase URL (module-level singleton).
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string) {
  if (!jwksSets.has(supabaseUrl)) {
    const jwksUri = new URL("/auth/v1/.well-known/jwks.json", supabaseUrl);
    jwksSets.set(supabaseUrl, createRemoteJWKSet(jwksUri));
  }
  return jwksSets.get(supabaseUrl)!;
}

/**
 * Tries to verify a Supabase JWT. Returns the user's Supabase ID + email on
 * success, or null when the token is clearly not a Supabase JWT or is invalid.
 */
async function verifySupabaseJwt(
  token: string,
  supabaseUrl: string,
): Promise<{ sub: string; email: string } | null> {
  try {
    const jwks = getJwks(supabaseUrl);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: supabaseUrl + "/auth/v1",
    });
    const sub = payload.sub;
    const email = (payload as { email?: string }).email ?? sub ?? "unknown";
    if (!sub) return null;
    return { sub, email };
  } catch {
    return null;
  }
}

export async function authenticate(
  authHeader: string | undefined,
  sharedSecret: string,
  supabaseUrl?: string,
  opts?: {
    /**
     * Skip the credit/cap block — for informational routes (/v1/me) that must
     * keep answering when the balance is 0 so dashboards can say "engin
     * inneign" instead of erroring. Spending routes never set this.
     */
    allowDepleted?: boolean;
  },
): Promise<AuthResult | AuthError> {
  const allowDepleted = opts?.allowDepleted === true;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      error: {
        type: "authentication_error",
        message: "missing or malformed Authorization header",
        status: 401,
      },
    };
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // Path 1: Supabase JWT (identified by being a JWT — three dot-separated parts).
  if (supabaseUrl && token.split(".").length === 3 && !token.startsWith("tok_")) {
    const claims = await verifySupabaseJwt(token, supabaseUrl);
    if (claims) {
      const user = findOrCreateUserBySupabaseId(claims.sub, claims.email);
      if (user.revoked_at) {
        return {
          error: {
            type: "authentication_error",
            message: "your Eva account access has been revoked",
            status: 401,
          },
        };
      }
      const current = rolloverIfNeeded(user);
      // The JWT's email claim is authoritative — the stored name may be a
      // legacy display name ("Vigdís") rather than the email.
      if (isInternalUser(current) || isInternalEmail(claims.email)) {
        return { user: current, devUnlimited: false, internal: true };
      }
      if (current.credit_balance_isk !== null) {
        if (current.credit_balance_isk <= 0 && !allowDepleted) {
          const neverBought = (current.credit_granted_isk ?? 0) <= 0;
          return {
            error: {
              type: "credit_depleted",
              message: neverBought
                ? "engin inneign — kauptu inneign á app.evai.is til að byrja að nota Evu"
                : "inneignin þín er uppurin — bættu við inneign á app.evai.is til að halda áfram",
              status: 402,
            },
          };
        }
      } else if (overCap(current) && !allowDepleted) {
        return {
          error: {
            type: "monthly_cap_reached",
            message: "monthly token cap reached — upgrade your Eva plan to continue",
            status: 429,
          },
        };
      }
      return { user: current, devUnlimited: false };
    }
    // JWT parse failed — fall through to other auth methods.
  }

  // Path 2: Legacy tok_ pairing token (admin-issued).
  if (token.startsWith("tok_")) {
    const user = findUserByToken(token);
    if (!user) {
      return {
        error: {
          type: "authentication_error",
          message: "unknown token — sign in with your Eva account",
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
    if (isInternalUser(current)) {
      return { user: current, devUnlimited: false, internal: true };
    }
    if (current.credit_balance_isk !== null) {
      if (current.credit_balance_isk <= 0 && !allowDepleted) {
        const neverBought = (current.credit_granted_isk ?? 0) <= 0;
        return {
          error: {
            type: "credit_depleted",
            message: neverBought
              ? "engin inneign — kauptu inneign á app.evai.is til að byrja að nota Evu"
              : "inneignin þín er uppurin — bættu við inneign á app.evai.is til að halda áfram",
            status: 402,
          },
        };
      }
    } else if (overCap(current) && !allowDepleted) {
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

  // Path 3: Dev shared secret fallback.
  if (sharedSecret && token === sharedSecret) {
    return { user: null, devUnlimited: true };
  }

  return {
    error: {
      type: "authentication_error",
      message: "invalid bearer token — sign in with your Eva account",
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
