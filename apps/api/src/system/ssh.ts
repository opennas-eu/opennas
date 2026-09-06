import { existsSync } from "node:fs";
import { nanoid } from "nanoid";
import type { SshConfig, SshKey } from "@opennas/shared";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/settings.js";

/** sshd is manageable when we're on the appliance and it's installed. */
function sshAvailable(): boolean {
  return config.systemMode === "linux" && (existsSync("/etc/init.d/sshd") || existsSync("/usr/sbin/sshd"));
}

/** Running iff OpenRC has it marked started. */
function sshRunning(): boolean {
  return existsSync("/run/openrc/started/sshd");
}

export function getSshKeys(): SshKey[] {
  const raw = getSetting("ssh_keys");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as SshKey[];
  } catch {
    return [];
  }
}

function saveKeys(keys: SshKey[]): void {
  setSetting("ssh_keys", JSON.stringify(keys));
}

export function getSshConfig(): SshConfig {
  return {
    available: sshAvailable(),
    enabled: sshRunning(),
    user: config.sshUser || null,
    keys: getSshKeys(),
  };
}

/** Parse + validate one authorized_keys line. Returns null if it isn't a key. */
export function parseSshKey(line: string): SshKey | null {
  const trimmed = line.trim();
  // type base64 [comment]
  const m = trimmed.match(/^(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+([A-Za-z0-9+/=]+)\s*(.*)$/);
  if (!m) return null;
  return { id: nanoid(8), value: `${m[1]} ${m[2]}${m[3] ? " " + m[3].trim() : ""}`, comment: m[3]?.trim() || "" };
}

export function addSshKey(line: string): SshKey {
  const key = parseSshKey(line);
  if (!key) throw new Error("That doesn't look like an SSH public key.");
  const keys = getSshKeys();
  if (keys.some((k) => k.value.split(" ").slice(0, 2).join(" ") === key.value.split(" ").slice(0, 2).join(" "))) {
    throw new Error("That key is already added.");
  }
  keys.push(key);
  saveKeys(keys);
  return key;
}

export function removeSshKey(id: string): SshKey[] {
  const keys = getSshKeys().filter((k) => k.id !== id);
  saveKeys(keys);
  return keys;
}

/** The authorized_keys file body to write for the SSH user. */
export function authorizedKeysBody(): string {
  return getSshKeys().map((k) => k.value).join("\n") + "\n";
}
