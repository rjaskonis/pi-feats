import { createWebSocketTransport, type EndpointProvider } from "./websocket-transport";
export type { EndpointProvider } from "./websocket-transport";

/** Steel supplies the endpoint lazily through its session API. */
export const createSteelTransport = (endpoint: EndpointProvider) => createWebSocketTransport(endpoint);
