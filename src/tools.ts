import { z } from "zod";
import { monzoRequest } from "./monzo.js";

export interface ToolDef {
  name: string;
  description: string;
  /** "read" tools are always exposed; "write" tools only when MONZO_MODE=write. */
  mode: "read" | "write";
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<unknown>;
}

const empty = z.object({}).strict();

interface Account {
  id: string;
  closed?: boolean;
  type?: string;
}

let cachedDefaultAccountId: string | undefined;

async function resolveDefaultAccountId(): Promise<string> {
  if (cachedDefaultAccountId) return cachedDefaultAccountId;
  const res = await monzoRequest<{ accounts: Account[] }>({
    path: "/accounts",
    query: { account_type: "uk_retail" },
  });
  const open = (res.accounts ?? []).filter((a) => !a.closed);
  if (open.length === 0) {
    throw new Error(
      "No open uk_retail account found; pass account_id explicitly.",
    );
  }
  if (open.length > 1) {
    throw new Error(
      `Multiple open uk_retail accounts (${open.map((a) => a.id).join(", ")}); pass account_id explicitly.`,
    );
  }
  cachedDefaultAccountId = open[0].id;
  return cachedDefaultAccountId;
}

export const tools: ToolDef[] = [
  {
    name: "whoami",
    description:
      "Verify the current access token and return information about the authenticated user (GET /ping/whoami).",
    mode: "read",
    inputSchema: empty,
    handler: () => monzoRequest({ path: "/ping/whoami" }),
  },
  {
    name: "list_accounts",
    description:
      "List the authenticated user's accounts. Optionally filter by account_type (e.g. 'uk_retail', 'uk_retail_joint').",
    mode: "read",
    inputSchema: z.object({ account_type: z.string().optional() }).strict(),
    handler: (args) => {
      const { account_type } = args as { account_type?: string };
      return monzoRequest({ path: "/accounts", query: { account_type } });
    },
  },
  {
    name: "get_balance",
    description:
      "Read the balance for an account. If account_id is omitted, defaults to the user's single open uk_retail account.",
    mode: "read",
    inputSchema: z.object({ account_id: z.string().optional() }).strict(),
    handler: async (args) => {
      const { account_id } = args as { account_id?: string };
      const id = account_id ?? (await resolveDefaultAccountId());
      return monzoRequest({ path: "/balance", query: { account_id: id } });
    },
  },
  {
    name: "list_pots",
    description:
      "List pots for a current account. If current_account_id is omitted, defaults to the user's single open uk_retail account.",
    mode: "read",
    inputSchema: z
      .object({ current_account_id: z.string().optional() })
      .strict(),
    handler: async (args) => {
      const { current_account_id } = args as { current_account_id?: string };
      const id = current_account_id ?? (await resolveDefaultAccountId());
      return monzoRequest({
        path: "/pots",
        query: { current_account_id: id },
      });
    },
  },
  {
    name: "list_transactions",
    description:
      "List transactions for an account. Supports pagination (since/before/limit) and expanding the merchant. If account_id is omitted, defaults to the user's single open uk_retail account.",
    mode: "read",
    inputSchema: z
      .object({
        account_id: z.string().optional(),
        since: z
          .string()
          .optional()
          .describe("RFC3339 timestamp or transaction id"),
        before: z.string().optional().describe("RFC3339 timestamp"),
        limit: z.number().int().min(1).max(100).optional(),
        expand_merchant: z.boolean().optional(),
      })
      .strict(),
    handler: async (args) => {
      const a = args as {
        account_id?: string;
        since?: string;
        before?: string;
        limit?: number;
        expand_merchant?: boolean;
      };
      const account_id = a.account_id ?? (await resolveDefaultAccountId());
      return monzoRequest({
        path: "/transactions",
        query: {
          account_id,
          since: a.since,
          before: a.before,
          limit: a.limit,
          "expand[]": a.expand_merchant ? "merchant" : undefined,
        },
      });
    },
  },
  {
    name: "get_transaction",
    description: "Retrieve a single transaction by id.",
    mode: "read",
    inputSchema: z
      .object({
        transaction_id: z.string(),
        expand_merchant: z.boolean().optional(),
      })
      .strict(),
    handler: (args) => {
      const a = args as { transaction_id: string; expand_merchant?: boolean };
      return monzoRequest({
        path: `/transactions/${encodeURIComponent(a.transaction_id)}`,
        query: { "expand[]": a.expand_merchant ? "merchant" : undefined },
      });
    },
  },
  {
    name: "list_webhooks",
    description:
      "List webhooks registered for an account. If account_id is omitted, defaults to the user's single open uk_retail account.",
    mode: "read",
    inputSchema: z.object({ account_id: z.string().optional() }).strict(),
    handler: async (args) => {
      const { account_id } = args as { account_id?: string };
      const id = account_id ?? (await resolveDefaultAccountId());
      return monzoRequest({ path: "/webhooks", query: { account_id: id } });
    },
  },
  {
    name: "get_receipt",
    description: "Retrieve a receipt by its external_id.",
    mode: "read",
    inputSchema: z.object({ external_id: z.string() }).strict(),
    handler: (args) => {
      const { external_id } = args as { external_id: string };
      return monzoRequest({
        path: "/transaction-receipts",
        query: { external_id },
      });
    },
  },

  // --- write tools below ---

  {
    name: "annotate_transaction",
    description:
      "Add or update metadata key/value pairs on a transaction. Pass an empty string as the value to remove a key.",
    mode: "write",
    inputSchema: z
      .object({
        transaction_id: z.string(),
        metadata: z.record(z.string(), z.string()),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        transaction_id: string;
        metadata: Record<string, string>;
      };
      const form: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.metadata)) {
        form[`metadata[${k}]`] = v;
      }
      return monzoRequest({
        method: "PATCH",
        path: `/transactions/${encodeURIComponent(a.transaction_id)}`,
        form,
      });
    },
  },
  {
    name: "pot_deposit",
    description:
      "Deposit funds from a source account into a pot. Amount is in minor units (pennies for GBP). dedupe_id must be unique per logical transfer.",
    mode: "write",
    inputSchema: z
      .object({
        pot_id: z.string(),
        source_account_id: z.string(),
        amount: z.number().int().positive(),
        dedupe_id: z.string(),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        pot_id: string;
        source_account_id: string;
        amount: number;
        dedupe_id: string;
      };
      return monzoRequest({
        method: "PUT",
        path: `/pots/${encodeURIComponent(a.pot_id)}/deposit`,
        form: {
          source_account_id: a.source_account_id,
          amount: a.amount,
          dedupe_id: a.dedupe_id,
        },
      });
    },
  },
  {
    name: "pot_withdraw",
    description:
      "Withdraw funds from a pot to a destination account. Amount in minor units. Blocked if the pot has 'added security' enabled.",
    mode: "write",
    inputSchema: z
      .object({
        pot_id: z.string(),
        destination_account_id: z.string(),
        amount: z.number().int().positive(),
        dedupe_id: z.string(),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        pot_id: string;
        destination_account_id: string;
        amount: number;
        dedupe_id: string;
      };
      return monzoRequest({
        method: "PUT",
        path: `/pots/${encodeURIComponent(a.pot_id)}/withdraw`,
        form: {
          destination_account_id: a.destination_account_id,
          amount: a.amount,
          dedupe_id: a.dedupe_id,
        },
      });
    },
  },
  {
    name: "create_feed_item",
    description: "Create a basic feed item in the user's account feed.",
    mode: "write",
    inputSchema: z
      .object({
        account_id: z.string(),
        title: z.string(),
        image_url: z.string().url(),
        body: z.string().optional(),
        background_color: z.string().optional(),
        title_color: z.string().optional(),
        body_color: z.string().optional(),
        url: z
          .string()
          .url()
          .optional()
          .describe("URL opened when item is tapped"),
      })
      .strict(),
    handler: (args) => {
      const a = args as Record<string, string>;
      const form: Record<string, string> = {
        account_id: a.account_id,
        type: "basic",
        "params[title]": a.title,
        "params[image_url]": a.image_url,
      };
      if (a.body) form["params[body]"] = a.body;
      if (a.background_color)
        form["params[background_color]"] = a.background_color;
      if (a.title_color) form["params[title_color]"] = a.title_color;
      if (a.body_color) form["params[body_color]"] = a.body_color;
      if (a.url) form.url = a.url;
      return monzoRequest({ method: "POST", path: "/feed", form });
    },
  },
  {
    name: "attachment_upload",
    description:
      "Request a temporary upload URL for a file. Returns file_url and upload_url. PUT the file bytes to upload_url separately, then call attachment_register.",
    mode: "write",
    inputSchema: z
      .object({
        file_name: z.string(),
        file_type: z.string(),
        content_length: z.number().int().positive(),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        file_name: string;
        file_type: string;
        content_length: number;
      };
      return monzoRequest({
        method: "POST",
        path: "/attachment/upload",
        form: {
          file_name: a.file_name,
          file_type: a.file_type,
          content_length: a.content_length,
        },
      });
    },
  },
  {
    name: "attachment_register",
    description: "Register an uploaded file as an attachment on a transaction.",
    mode: "write",
    inputSchema: z
      .object({
        external_id: z.string().describe("transaction id"),
        file_url: z.string().url(),
        file_type: z.string(),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        external_id: string;
        file_url: string;
        file_type: string;
      };
      return monzoRequest({
        method: "POST",
        path: "/attachment/register",
        form: a,
      });
    },
  },
  {
    name: "attachment_deregister",
    description: "Remove an attachment by its id.",
    mode: "write",
    inputSchema: z.object({ id: z.string() }).strict(),
    handler: (args) => {
      const { id } = args as { id: string };
      return monzoRequest({
        method: "POST",
        path: "/attachment/deregister",
        form: { id },
      });
    },
  },
  {
    name: "create_receipt",
    description:
      "Create or update a receipt for a transaction. external_id acts as the idempotency key.",
    mode: "write",
    inputSchema: z
      .object({
        external_id: z.string(),
        transaction_id: z.string(),
        receipt: z
          .record(z.string(), z.any())
          .describe(
            "Receipt body as described in Monzo's docs: total, currency, items, taxes, payments, merchant, etc.",
          ),
      })
      .strict(),
    handler: (args) => {
      const a = args as {
        external_id: string;
        transaction_id: string;
        receipt: Record<string, unknown>;
      };
      return monzoRequest({
        method: "PUT",
        path: "/transaction-receipts",
        json: {
          external_id: a.external_id,
          transaction_id: a.transaction_id,
          ...a.receipt,
        },
      });
    },
  },
  {
    name: "delete_receipt",
    description: "Delete a receipt by external_id.",
    mode: "write",
    inputSchema: z.object({ external_id: z.string() }).strict(),
    handler: (args) => {
      const { external_id } = args as { external_id: string };
      return monzoRequest({
        method: "DELETE",
        path: "/transaction-receipts",
        query: { external_id },
      });
    },
  },
  {
    name: "register_webhook",
    description:
      "Register a webhook URL to receive transaction.created events for an account.",
    mode: "write",
    inputSchema: z
      .object({ account_id: z.string(), url: z.string().url() })
      .strict(),
    handler: (args) => {
      const a = args as { account_id: string; url: string };
      return monzoRequest({ method: "POST", path: "/webhooks", form: a });
    },
  },
  {
    name: "delete_webhook",
    description: "Delete a webhook by id.",
    mode: "write",
    inputSchema: z.object({ webhook_id: z.string() }).strict(),
    handler: (args) => {
      const { webhook_id } = args as { webhook_id: string };
      return monzoRequest({
        method: "DELETE",
        path: `/webhooks/${encodeURIComponent(webhook_id)}`,
      });
    },
  },
  {
    name: "logout",
    description:
      "Invalidate the current access token via /oauth2/logout. You will need to re-run `monzo-mcp auth` afterwards.",
    mode: "write",
    inputSchema: empty,
    handler: () => monzoRequest({ method: "POST", path: "/oauth2/logout" }),
  },
];
