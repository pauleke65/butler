/** Shared, framework-free types for the MCP layer (used by API routes, the CLI runner and tests). */

export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  /** OAuth2 client credentials (e.g. a Cognito app client): the token is fetched and refreshed automatically. */
  | { type: "client_credentials"; tokenUrl: string; clientId: string; clientSecret: string; scope?: string };

export interface ServerConfig {
  /** Stable id used in tool routing and the UI. */
  id: string;
  name: string;
  url: string;
  auth: AuthConfig;
  /** Spoken name of the add-on ("Butler"). Utterances like "ask Butler ..." bias routing to this server. */
  invocationName?: string;
  enabled?: boolean;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  items?: JsonSchema;
  default?: unknown;
  [k: string]: unknown;
}

export interface ToolInfo {
  server: string;
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  /** Raw `_meta` from the tool definition. */
  meta?: Record<string, unknown>;
  /** `ui://` resource declared on the tool definition (if any). */
  uiResourceUri?: string;
  /** `_meta.ui.visibility`; undefined means the default ["model","app"]. */
  visibility?: Array<"model" | "app">;
  annotations?: Record<string, unknown>;
}

export interface ResourceInfo {
  server: string;
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnectionInfo {
  id: string;
  name: string;
  url: string;
  status: ConnectionStatus;
  error?: string;
  /** What the server answered to `initialize`. */
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  serverCapabilities?: Record<string, unknown>;
  /** Capabilities this simulator declared. */
  clientCapabilities?: Record<string, unknown>;
  instructions?: string;
  tools: ToolInfo[];
  resources: ResourceInfo[];
  connectedAt?: string;
  connectMs?: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** Result of a tool call, exactly what the server sent plus our timing record. */
export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface CallTimings {
  startedAt: string;
  /** ms from request to first response byte (headers) - null if not observable. */
  ttfbMs: number | null;
  totalMs: number;
}

export interface CallRecord {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  error?: string;
  timings: CallTimings;
  /** `ui://` resource that should render this result (result `_meta.ui` wins over the tool definition). */
  uiResourceUri?: string;
  /** Who triggered it: the brain (voice turn), a view (app), or a script runner. */
  origin: "brain" | "view" | "script" | "panel";
}

export interface UiResourcePayload {
  uri: string;
  html: string;
  csp?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  mimeType?: string;
  /** True when served from cache. */
  cached?: boolean;
  fetchMs?: number;
}

export interface ElicitationRequestInfo {
  id: string;
  server: string;
  mode: "form" | "url";
  message: string;
  /** form mode */
  requestedSchema?: JsonSchema;
  /** url mode */
  url?: string;
  elicitationId?: string;
}

export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

export type ElicitationHandler = (req: ElicitationRequestInfo) => Promise<ElicitationResponse>;
