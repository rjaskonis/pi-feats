const extensionId = "heidjicdbehhgidkhaofophkickmhijo";

type Status = { available?: boolean; pairingPending?: boolean; browsers: { connected: boolean }[] };

// Machine-readable setup hints prevent a saved credential from being mistaken for a live connection.
export function browserStatusGuidance(status: Status, mode: "local" | "console", relayRunning = true) {
  const connected = status.browsers.some(browser => browser.connected);
  const serverUnavailable = mode === "console" && !relayRunning;
  const state = serverUnavailable ? "server_unavailable" : connected ? "connected" : !relayRunning ? "relay_not_running" : status.browsers.length ? "paired_disconnected" : "not_paired";
  const nextStep = serverUnavailable ? "check_server_browser_service" : connected ? "ready" : state === "paired_disconnected" ? "check_chrome_connection" : mode === "local" ? "generate_local_pairing_code" : status.available === false ? "administrator_setup_required" : "open_console_pairing";
  return {
    ...status,
    connectionState: state,
    setup: {
      mode, nextStep,
      extensionSettingsUrl: `chrome-extension://${extensionId}/settings.html`,
      extensionDetailsUrl: `chrome://extensions/?id=${extensionId}`,
      instruction: serverUnavailable
        ? "The server browser service is unavailable. Check the Pi API and open a new Pi session after it returns. Do not start a local relay or generate another code."
        : connected
        ? "The browser is connected. Continue the requested task without pairing again."
        : state === "paired_disconnected"
          ? "Chrome is already paired but offline. Ask the user to open Chrome and check the connection status in extension settings. Do not pair again unless the extension actually needs pairing."
          : mode === "local"
            ? "Pair Chrome once with the shared relay using pi browser pair from the default local terminal. All local Pi Profiles can use it once connected."
          : status.available === false
            ? "Remote pairing is unavailable. Explain that the server administrator must configure HTTPS/WSS; do not generate a local code in an API worker."
            : "Guide the user to Console > Administrative Settings > Pi Agent Browse > Connect Chrome > Pi on another server. Generate a code and paste it into the extension's Remote server form. The pairing makes Chrome available to all profiles on that server. Do not generate a loopback pairing code in an API worker.",
    },
  };
}
