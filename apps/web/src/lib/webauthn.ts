import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import type { MeResponse, SessionInfo } from "@opennas/shared";
import { api } from "./api.ts";

export const passkeysSupported = browserSupportsWebAuthn();

/** Register a new passkey for the currently logged-in user. */
export async function registerPasskey(label?: string): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: unknown }>(
    "/auth/passkeys/register/options",
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attResp = await startRegistration({ optionsJSON: options as any });
  await api.post("/auth/passkeys/register/verify", { challengeId, response: attResp, label });
}

/** Authenticate with a passkey. Pass a username to scope it, or omit for usernameless. */
export async function loginWithPasskey(username?: string): Promise<SessionInfo> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: unknown }>(
    "/auth/passkeys/login/options",
    username ? { username } : {},
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authResp = await startAuthentication({ optionsJSON: options as any });
  const res = await api.post<MeResponse>("/auth/passkeys/login/verify", {
    challengeId,
    response: authResp,
  });
  if (!res.session) throw new Error("Login failed.");
  return res.session;
}
