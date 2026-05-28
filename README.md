# monzo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Monzo API](https://docs.monzo.com/).

Exposes Monzo's API to MCP clients (Claude Desktop, etc.) over stdio. Authenticates via OAuth 2.0 (authorization code flow) and persists refresh tokens locally so the server can renew access tokens automatically.

> **Personal use only.** Monzo state in their docs: _"The Monzo Developer API is not suitable for building public applications."_ Use this for your own account, or with users who have explicitly approved your client.

## Features

- OAuth 2.0 authorization-code flow with local callback server and CSRF `state` check
- Token persistence at `~/.monzo-mcp/tokens.json` (mode `0600`) with automatic refresh
- Read-only by default; writes gated behind `MONZO_MODE=write`
- Full API coverage: accounts, balance, pots (deposit/withdraw), transactions (list/get/annotate), feed items, attachments, receipts, webhooks

## What can it do?

**Reading / viewing (the bulk of it)**

- Check the balance of any of your accounts
- List your accounts (you've got 5 — 3 open: personal, joint, Infinity Design Wave business; 2 closed)
- List transactions for an account, including merchant detail and pagination through history
- Look up a single transaction by ID
- List pots on an account
  List webhooks registered on an account
- Retrieve receipts and attachments tied to transactions

**Writing (limited)**

- Move money into or out of a pot (deposit / withdraw) — but only between an account and its own pots, and only if the pot already exists. You currently have no active pots.
- Annotate transactions (add notes/metadata) and create/manage receipts and attachments
- Create a basic feed item in your Monzo app feed
- Register or delete webhooks

**What I can't do** — and these keep coming up, so worth stating plainly:

- Send money to another account (no transfers/payments — that's why the joint-account and business-account moves weren't possible)
- Create or delete pots
- Anything Monzo's API doesn't expose, which is most account-management actions

## Install

### Via Claude Desktop Extension (.dxt) — recommended

Download the latest `monzo-mcp-vX.Y.Z.dxt` from the [releases page](https://github.com/allistera/monzo-mcp/releases) and double-click to install into Claude Desktop. You'll still need to run the OAuth flow once — see step 3 below.

### From source

```sh
git clone https://github.com/allistera/monzo-mcp.git && cd monzo-mcp
npm install
npm run build
```

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

| Tool                | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `whoami`            | Verify token, return authenticated user                            |
| `list_accounts`     | List accounts (filter by `account_type`)                           |
| `get_balance`       | Balance for an account                                             |
| `list_pots`         | List pots for a current account                                    |
| `list_transactions` | List transactions, with pagination and optional merchant expansion |
| `get_transaction`   | Retrieve a single transaction                                      |
| `list_webhooks`     | List webhooks for an account                                       |
| `get_receipt`       | Retrieve a receipt by `external_id`                                |

### Write mode (`MONZO_MODE=write`, also enables all read tools)

| Tool                    | Description                               |
| ----------------------- | ----------------------------------------- |
| `annotate_transaction`  | Add/remove transaction metadata           |
| `pot_deposit`           | Move funds account → pot                  |
| `pot_withdraw`          | Move funds pot → account                  |
| `create_feed_item`      | Push a basic feed item to the user's feed |
| `attachment_upload`     | Get a temporary upload URL                |
| `attachment_register`   | Attach an uploaded file to a transaction  |
| `attachment_deregister` | Remove an attachment                      |
| `create_receipt`        | Create/update a structured receipt        |
| `delete_receipt`        | Delete a receipt                          |
| `register_webhook`      | Subscribe to `transaction.created` events |
| `delete_webhook`        | Unsubscribe                               |
| `logout`                | Invalidate the current access token       |

## Environment variables

| Var                   | Required   | Description                                  |
| --------------------- | ---------- | -------------------------------------------- |
| `MONZO_CLIENT_ID`     | for `auth` | OAuth client id                              |
| `MONZO_CLIENT_SECRET` | for `auth` | OAuth client secret                          |
| `MONZO_REDIRECT_URI`  | no         | Defaults to `http://localhost:8765/callback` |
| `MONZO_MODE`          | no         | `read` (default) or `write`                  |

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

## Repository policies

### CI

- `.github/workflows/ci.yml` — typecheck, ESLint, Prettier check, build, and `npm test` on Node 20 & 22. Runs on every PR and on push to `main`.

### Security scanning

- **CodeQL** (`.github/workflows/codeql.yml`) — JavaScript/TypeScript analysis with the `security-and-quality` query suite. Runs on every PR, on push to `main`, and weekly (Mondays 04:23 UTC). Required to merge.
- **Secret scanning + push protection** — enabled. Commits containing recognised secret patterns are blocked at `git push`.
- **Dependabot vulnerability alerts** — enabled.

### Dependency updates

- **Dependabot security updates** — auto-opens a PR the moment a vulnerability is published against a dependency, independent of the schedule below.
- **Dependabot version updates** (`.github/dependabot.yml`) — runs weekly, Mondays 08:00 London time:
  - **npm**: minor + patch updates grouped into one PR per group (`dev-dependencies`, `production-dependencies`); major bumps come as standalone PRs for manual review.
  - **github-actions**: weekly updates for any pinned actions in the workflows.

### Releases

Versioning is automated. We use **[release-please](https://github.com/googleapis/release-please)** with [Conventional Commits](https://www.conventionalcommits.org/):

- `fix: …` → patch bump
- `feat: …` → minor bump
- `feat!: …` or a `BREAKING CHANGE:` footer → major bump (while pre-1.0, breaking changes bump the minor)
- `docs:`, `chore:`, `ci:`, `refactor:`, `test:`, `build:` → no version bump

A PR-title check (`.github/workflows/pr-title.yml`) enforces the format. Since `main` uses squash-merge, the PR title becomes the commit message.

**The release cycle:**

1. Merge Conventional-Commit PRs into `main`.
2. The `release-please` workflow keeps an open "Release PR" up to date — it bumps the version in `package.json`, `manifest.json`, and `.release-please-manifest.json`, and writes a `CHANGELOG.md`.
3. Merging the Release PR creates a Git tag and a GitHub release.
4. The `publish` workflow triggers on `release.published` and builds the Claude Desktop Extension bundle (`.dxt`), attaching it to the GitHub release.

Distribution is GitHub-only — no npm registry. Users install via the `.dxt` artifact or by cloning the repo.

### Branch protection

`main` is protected by a repository ruleset. The author of a change cannot bypass it.

- Pull request required to merge (0 reviewer approvals — solo-friendly; bump if you add collaborators).
- Required status checks (strict — branch must be up to date with `main`):
  - `typecheck / lint / build (20)`
  - `typecheck / lint / build (22)`
  - `Analyze javascript-typescript`
- Linear history required (no merge commits — use rebase or squash).
- Force pushes blocked, branch deletion blocked.
- Open conversation threads must be resolved before merge.

## License

MIT — see [LICENSE](./LICENSE).
