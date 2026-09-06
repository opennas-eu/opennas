/**
 * Minimal typings for @novnc/novnc (the package ships plain ESM, no .d.ts).
 * Covers just the RFB surface the VM console uses.
 */
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    /** Scale the remote framebuffer to fit the container. */
    scaleViewport: boolean;
    /** Ask the server to resize its session to match the container. */
    resizeSession: boolean;
    /** CSS background behind the framebuffer. */
    background: string;
    /** Read-only (no input forwarded) when true. */
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void;
    machineReboot(): void;
    machineShutdown(): void;
  }
}
