import {
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const SUPPORTED_PROTOCOL_VERSION = "2026-07-28";

function claimedProtocolVersion(
  message: JSONRPCMessage,
): { present: false } | { present: true; version: string | undefined } {
  if (!isJSONRPCRequest(message) && !isJSONRPCNotification(message)) {
    return { present: false };
  }

  const params = message.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { present: false };
  }

  const metadata = params._meta;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !(PROTOCOL_VERSION_META_KEY in metadata)
  ) {
    return { present: false };
  }

  const version = metadata[PROTOCOL_VERSION_META_KEY];
  return {
    present: true,
    version: typeof version === "string" ? version : undefined,
  };
}

/**
 * Rejects unsupported per-message MCP protocol claims before serveStdio's
 * pinned server instance can consume them. Claim-less messages are forwarded
 * unchanged so the SDK can retain its legacy 2025-era fallback.
 */
export class ProtocolVersionTransport implements Transport {
  private readonly transport: Transport;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;

  constructor(transport: Transport = new StdioServerTransport()) {
    this.transport = transport;
    transport.onclose = () => this.onclose?.();
    transport.onerror = (error) => this.onerror?.(error);
    transport.onmessage = (message, extra) => {
      this.handleMessage(message, extra);
    };
    this.setProtocolVersion = (version) => {
      transport.setProtocolVersion?.(version);
    };
    this.setSupportedProtocolVersions = (versions) => {
      transport.setSupportedProtocolVersions?.(versions);
    };
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.transport.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  set sessionId(value: string | undefined) {
    this.transport.sessionId = value;
  }

  private handleMessage(
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ): void {
    const claim = claimedProtocolVersion(message);
    if (
      !claim.present ||
      claim.version === undefined ||
      claim.version === SUPPORTED_PROTOCOL_VERSION
    ) {
      this.onmessage?.(message, extra);
      return;
    }

    const requested = claim.version ?? "unknown";
    const error = new UnsupportedProtocolVersionError({
      supported: [SUPPORTED_PROTOCOL_VERSION],
      requested,
    });

    if (isJSONRPCRequest(message)) {
      void this.transport
        .send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: error.code,
            message: error.message,
            data: error.data,
          },
        })
        .catch((sendError: unknown) => {
          this.onerror?.(
            sendError instanceof Error
              ? sendError
              : new Error(String(sendError)),
          );
        });
      return;
    }

    this.onerror?.(
      new Error(
        `Dropped notification claiming unsupported protocol version: ${requested}`,
      ),
    );
  }
}
