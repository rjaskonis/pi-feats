const extensionId = "heidjicdbehhgidkhaofophkickmhijo";

type Status = { available?: boolean; pairingPending?: boolean; browsers: { connected: boolean }[] };

// Machine-readable setup hints prevent a saved credential from being mistaken for a live connection.
export function browserStatusGuidance(status: Status, mode: "local" | "console", relayRunning = true) {
  const connected = status.browsers.some(browser => browser.connected);
  const state = connected ? "connected" : !relayRunning ? "relay_not_running" : status.browsers.length ? "paired_disconnected" : "not_paired";
  const nextStep = connected ? "ready" : mode === "local" ? (state === "paired_disconnected" ? "check_chrome_connection" : "generate_local_pairing_code") : status.available === false ? "administrator_setup_required" : "open_console_pairing";
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
          ? state === "paired_disconnected"
            ? "Chrome is already paired but offline. Ask the user to open Chrome and check the connection status in extension settings. Generate another code only if the extension actually needs pairing."
            : "Pair Chrome once with the shared relay using pi browser pair from the default local terminal. All local Pi Profiles can use it once connected."
          : status.available === false
            ? "Remote pairing is unavailable. Explain that the server administrator must configure HTTPS/WSS; do not generate a local code in an API worker."
            : "Guide the user to Console > Administrative Settings > Pi Agent Browse > Connect Chrome > Pi on another server. Generate a code and paste it into the extension's Remote server form. The pairing makes Chrome available to all profiles on that server. Do not generate a loopback pairing code in an API worker.",
    },
  };
}
