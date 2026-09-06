import { useEffect } from "react";
import { useAuth } from "./store/auth.ts";
import { Splash } from "./components/Splash.tsx";
import { SetupWizard } from "./components/auth/SetupWizard.tsx";
import { LoginScreen } from "./components/auth/LoginScreen.tsx";
import { AccountSetupGate } from "./components/auth/AccountSetupGate.tsx";
import { Desktop } from "./components/desktop/Desktop.tsx";
import { DialogHost } from "./components/ui/DialogHost.tsx";
import { AppPickerHost } from "./components/apps/AppPickerHost.tsx";

export function App() {
  const { status, session, bootstrap, init } = useAuth();

  useEffect(() => {
    void init();
  }, [init]);

  // After signing in, return to an OIDC consent flow that bounced us here. Only
  // same-origin /oidc/ paths are honoured (no open redirect).
  useEffect(() => {
    if (!session) return;
    const ret = new URLSearchParams(window.location.search).get("oidc_return");
    if (ret && ret.startsWith("/oidc/")) window.location.replace(ret);
  }, [session]);

  if (status === "loading" || !bootstrap) return <Splash />;

  // A signed-in account can still owe mandatory setup. The API refuses almost
  // everything until it's done, so the desktop doesn't get a chance to render.
  const gated = session !== null && session.pendingActions.length > 0;

  return (
    <>
      {gated ? (
        <AccountSetupGate />
      ) : session ? (
        <Desktop />
      ) : bootstrap.needsSetup ? (
        <SetupWizard />
      ) : (
        <LoginScreen />
      )}
      <DialogHost />
      <AppPickerHost />
    </>
  );
}
