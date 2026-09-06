import { buildServer } from "./server.js";
import { config } from "./config.js";
import { getServicesConfig } from "./services/services.js";
import { applyServiceStates } from "./system/integration.js";

async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`OpenNAS API listening on http://${config.host}:${config.port}`);
    if (config.oidc.enabled) app.log.info(`OIDC SSO enabled (issuer: ${config.oidc.issuer})`);
    // Enforce the configured file-service states at boot: a service marked
    // disabled in the UI is stopped (and removed from the runlevel), so it never
    // "runs by default". Best-effort, non-blocking; no-op in demo mode.
    const svc = getServicesConfig();
    void applyServiceStates(app.log, { smb: svc.smb.enabled, nfs: svc.nfs.enabled, afp: svc.afp.enabled });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
