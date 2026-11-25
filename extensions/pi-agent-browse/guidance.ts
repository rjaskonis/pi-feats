const extensionId = "heidjicdbehhgidkhaofophkickmhijo";

type Status = { available?: boolean; pairingPending?: boolean; browsers: { connected: boolean }[] };

// Machine-readable setup hints prevent a saved credential from being mistaken for a live connection.
export function browserStatusGuidance(status: Status, mode: "local" | "console", relayRunning = true) {
  const connected = status.browsers.some(browser => browser.connected);
  const state = connected ? "connected" : !relayRunning ? "relay_not_running" : status.browsers.length ? "paired_disconnected" : "not_paired";
  const nextStep = connected ? "ready" : mode === "local" ? "generate_local_pairing_code" : status.available === false ? "administrator_setup_required" : "open_console_pairing";
  return {
    ...status,
    connectionState: state,
    setup: {
      mode, nextStep,
      extensionSettingsUrl: `chrome-extension://${extensionId}/settings.html`,
      extensionDetailsUrl: `chrome://extensions/?id=${extensionId}`,
      instruction: connected
        ? "The browser is connected. Continue the requested task without pairing again."
        : mode === "local"
          ? "If the user asked to connect, generate a code yourself with pi browser pair in the active profile context. Show the returned address and code, exact extension settings steps, and expiry. Do not ask the user to run a terminal command you can run. A stored browser is not a live connection."
          : status.available === false
            ? "Remote pairing is unavailable. Explain that the server administrator must configure HTTPS/WSS; do not generate a local code in an API worker."
            : "Guide the user to Console > Administrative Settings > Pi Agent Browse > Connect Chrome > Pi on another server. Select this session's profile, generate a code, and paste it into the extension's Remote server form. Do not generate a loopback pairing code in an API worker.",
    },
  };
}
