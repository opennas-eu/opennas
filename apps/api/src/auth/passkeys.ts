import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../config.js";
import {
  getCredentialById,
  getCredentialsByUser,
  saveCredential,
  updateCredentialCounter,
  type CredentialRecord,
} from "../db/credentials.js";

const rp = config.webauthn;

/** Build registration options for an existing user adding a passkey. */
export async function buildRegistrationOptions(user: {
  id: string;
  username: string;
  displayName: string;
}) {
  const existing = getCredentialsByUser(user.id);
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.displayName,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports as AuthenticatorTransportLike[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistration | null> {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) return null;
  const info = verification.registrationInfo;
  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (response.response.transports as string[] | undefined) ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

/**
 * Build authentication options. With resident keys we can offer a
 * "usernameless" login, so allowCredentials is left empty by default.
 */
export async function buildAuthenticationOptions(userId?: string) {
  const allow = userId
    ? getCredentialsByUser(userId).map((c) => ({
        id: c.id,
        transports: c.transports as AuthenticatorTransportLike[],
      }))
    : undefined;
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "preferred",
    allowCredentials: allow,
  });
}

export interface VerifiedAuthentication {
  credential: CredentialRecord;
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedAuthentication | null> {
  const credential = getCredentialById(response.id);
  if (!credential) return null;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
    credential: {
      id: credential.id,
      // DB returns a generic Uint8Array; the lib wants Uint8Array<ArrayBuffer>.
      publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
      counter: credential.counter,
      transports: credential.transports as AuthenticatorTransportLike[],
    },
  });
  if (!verification.verified) return null;
  updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter);
  return { credential };
}

export { saveCredential };

/** Loose alias to avoid importing the lib's transport union everywhere. */
type AuthenticatorTransportLike =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";
