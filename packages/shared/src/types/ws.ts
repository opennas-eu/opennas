/** WebSocket message envelope for the live telemetry channel (/api/ws). */

import type { SystemSample, SystemStaticInfo } from "./system.js";
import type { NotificationRecord } from "./notifications.js";

/** Server -> client messages. */
export type ServerMessage =
  | { type: "hello"; info: SystemStaticInfo }
  | { type: "sample"; sample: SystemSample }
  /** A notification raised for this user while they were connected. */
  | { type: "notification"; notification: NotificationRecord }
  | { type: "error"; message: string };

/** Client -> server messages. */
export type ClientMessage =
  | { type: "subscribe"; channel: "system" }
  | { type: "unsubscribe"; channel: "system" }
  | { type: "ping" };
