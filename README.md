# monzo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Monzo API](https://docs.monzo.com/).

Exposes Monzo's API to MCP clients (Claude Desktop, etc.) over stdio. Authenticates via OAuth 2.0 (authorization code flow) and persists refresh tokens locally so the server can renew access tokens automatically.

> **Personal use only.** Monzo state in their docs: _"The Monzo Developer API is not suitable for building public applications."_ Use this for your own account, or with users who have explicitly approved your client.

## Features

- OAuth 2.0 authorization-code flow with local callback server and CSRF `state` check
- Token persistence at `~/.monzo-mcp/tokens.json` (mode `0600`) with automatic refresh
- Read-only by default; writes gated behind `MONZO_MODE=write`
- Full API coverage: accounts, balance, pots (deposit/withdraw), transactions (list/get/annotate), feed items, attachments, receipts, webhooks

## Setup

### 1. Register an OAuth client

At <https://developers.monzo.com/> create a **confidential** OAuth client. Only confidential clients receive refresh tokens. Set the redirect URI to:

```
http://localhost:8765/callback
```

(You can override this with `MONZO_REDIRECT_URI` — but it must match exactly on both sides.)

### 2. Build

```sh
npm install
npm run build
```

### 3. Run the OAuth flow (once)

```sh
MONZO_CLIENT_ID=oauth2client_... \
MONZO_CLIENT_SECRET=mnzconf.... \
node dist/index.js auth
```

This opens your browser, listens on the redirect URI, exchanges the code, and writes tokens to `~/.monzo-mcp/tokens.json`. **Then approve the access request in your Monzo app** to complete Strong Customer Authentication.

### 4. Configure your MCP client

For Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "monzo": {
      "command": "node",
      "args": ["/absolute/path/to/monzo-mcp/dist/index.js"],
      "env": { "MONZO_MODE": "read" }
    }
  }
}
```

Set `MONZO_MODE=write` to expose mutating tools.

## Tools

### Read mode (`MONZO_MODE=read`, default)

| Tool | Description |
| --- | --- |
| `whoami` | Verify token, return authenticated user |
| `list_accounts` | List accounts (filter by `account_type`) |
| `get_balance` | Balance for an account |
| `list_pots` | List pots for a current account |
| `list_transactions` | List transactions, with pagination and optional merchant expansion |
| `get_transaction` | Retrieve a single transaction |
| `list_webhooks` | List webhooks for an account |
| `get_receipt` | Retrieve a receipt by `external_id` |

### Write mode (`MONZO_MODE=write`, also enables all read tools)

| Tool | Description |
| --- | --- |
| `annotate_transaction` | Add/remove transaction metadata |
| `pot_deposit` | Move funds account → pot |
| `pot_withdraw` | Move funds pot → account |
| `create_feed_item` | Push a basic feed item to the user's feed |
| `attachment_upload` | Get a temporary upload URL |
| `attachment_register` | Attach an uploaded file to a transaction |
| `attachment_deregister` | Remove an attachment |
| `create_receipt` | Create/update a structured receipt |
| `delete_receipt` | Delete a receipt |
| `register_webhook` | Subscribe to `transaction.created` events |
| `delete_webhook` | Unsubscribe |
| `logout` | Invalidate the current access token |

## Environment variables

| Var | Required | Description |
| --- | --- | --- |
| `MONZO_CLIENT_ID` | for `auth` | OAuth client id |
| `MONZO_CLIENT_SECRET` | for `auth` | OAuth client secret |
| `MONZO_REDIRECT_URI` | no | Defaults to `http://localhost:8765/callback` |
| `MONZO_MODE` | no | `read` (default) or `write` |

## Caveats from Monzo's API

- Refresh tokens are only issued to **confidential** clients. Non-confidential clients re-auth every 6 hours.
- 5 minutes after authentication, transaction history is capped to the last 90 days.
- Pots with "added security" enabled cannot be withdrawn via the API.
- Access tokens are valid for 6 hours; this server refreshes ~60 seconds before expiry and on any `401`.

## Development

```sh
npm run typecheck
npm run lint
npm run format
npm run build
```

CI runs typecheck, lint, format check, and build on Node 20 & 22.

## License

MIT — see [LICENSE](./LICENSE).
