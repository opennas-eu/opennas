import nodemailer from "nodemailer";
import type { SmtpConfig } from "@opennas/shared";
import { getSetting, setSetting } from "../db/settings.js";

/** Stored shape includes the password (never returned to the client). */
interface StoredSmtp {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  to: string;
  alertDiskHealth: boolean;
}

const DEFAULT: StoredSmtp = {
  enabled: false,
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  from: "",
  to: "",
  alertDiskHealth: true,
};

function readStored(): StoredSmtp {
  const raw = getSetting("smtp");
  if (!raw) return { ...DEFAULT };
  try {
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<StoredSmtp>) };
  } catch {
    return { ...DEFAULT };
  }
}

/** Public config - the password is replaced by a `hasPassword` flag. */
export function getSmtpConfig(): SmtpConfig {
  const { password, ...rest } = readStored();
  return { ...rest, hasPassword: !!password };
}

export interface SmtpPatch extends Partial<Omit<StoredSmtp, "password">> {
  /** New password; empty/undefined keeps the existing one. */
  password?: string;
}

export function setSmtpConfig(patch: SmtpPatch): SmtpConfig {
  const cur = readStored();
  const next: StoredSmtp = { ...cur, ...patch, password: patch.password ? patch.password : cur.password };
  setSetting("smtp", JSON.stringify(next));
  return getSmtpConfig();
}

function transportFor(cfg: StoredSmtp) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  });
}

/** Send an alert email using the saved config. No-op (resolves) if disabled. */
export async function sendMail(subject: string, text: string, to?: string): Promise<void> {
  const cfg = readStored();
  if (!cfg.enabled || !cfg.host) return;
  await transportFor(cfg).sendMail({
    from: cfg.from || cfg.username,
    to: to || cfg.to,
    subject,
    text,
  });
}

/** Send a test email, applying an optional unsaved patch (e.g. a typed password). */
export async function sendTestMail(patch: SmtpPatch): Promise<void> {
  const cur = readStored();
  const cfg: StoredSmtp = { ...cur, ...patch, password: patch.password ? patch.password : cur.password };
  if (!cfg.host) throw new Error("Set an SMTP host first.");
  const to = cfg.to || cfg.from || cfg.username;
  if (!to) throw new Error("Set a recipient (To) address first.");
  await transportFor(cfg).sendMail({
    from: cfg.from || cfg.username,
    to,
    subject: "OpenNAS test email",
    text: "This is a test email from OpenNAS. Your email settings are working.",
  });
}
