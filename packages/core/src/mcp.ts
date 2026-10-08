/**
 * An MCP server over a Filelayer instance, so that an agent can OPERATE the
 * file layer rather than only integrate it.
 *
 * =============================================================================
 * WHAT THIS IS, AND WHOSE SERVER IT IS
 * =============================================================================
 *
 * This is not a hosted service and there is nothing to sign up for. You build
 * it in your own process, against your own Filelayer instance, and you run it.
 * It is for the case where an agent should be able to answer "which contracts
 * can Alice see", "share this one with the external accountant for two weeks",
 * "take that back" -- using the same authorization code path as your HTTP
 * routes, with no second set of rules to keep in agreement.
 *
 * =============================================================================
 * THE ONE DECISION THAT MAKES THIS SAFE
 * =============================================================================
 *
 * **The subject is fixed when you construct the server. It is not a tool
 * parameter, and there is no tool that changes it.**
 *
 * The obvious design is a `user` argument on every tool, and it is a disaster:
 * the agent chooses who it is, so every permission check becomes advisory and
 * the product's single property is gone. An MCP server that can act as anyone
 * is an admin backdoor with a schema.
 *
 * So one server instance speaks for exactly one subject in exactly one
 * organisation. Serving several users means constructing several servers, which
 * is the cost of the property and is deliberately not hidden. If you are
 * tempted to add a `user` parameter, what you want is a different server.
 *
 * =============================================================================
 * THREE THINGS ARE OFF BY DEFAULT
 * =============================================================================
 *
 * `allowDestructive`, `exposeAuditTrail` and `returnFileBytes` all default to
 * false, and each one is off for its own reason rather than out of caution:
 *
 *   - **Deleting** is not recoverable and an agent that misreads a sentence
 *     deletes the wrong thing silently.
 *   - **The audit trail** is the one surface where reading is not itself
 *     recorded (LIMITATIONS.md entry 16), so an agent reading an entire
 *     organisation's history leaves nothing behind. Until that gap is closed,
 *     turning this on is a decision somebody should make on purpose.
 *   - **File bytes** returned by a tool go into a model's context, and from
 *     there into whatever that context reaches. `file_info` plus a share link
 *     gives an agent what it needs to be useful without copying the document
 *     into a transcript.
 *
 * =============================================================================
 * INSTALLING IT
 * =============================================================================
 *
 * This module needs two things the rest of the package does not, so both are
 * OPTIONAL peer dependencies and `@filelayer/core` still installs with zero
 * runtime dependencies:
 *
 *     npm install @modelcontextprotocol/sdk zod
 *
 * `zod` is not a choice. The SDK's `inputSchema` accepts Zod v3 or v4 schemas
 * and nothing else -- there is no plain-JSON-Schema or standard-schema path --
 * so a tool with arguments requires it. Anyone already writing an MCP server
 * has it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ERROR_CODES, FilelayerError, type ErrorCode } from './errors.ts';
import type { Filelayer } from './filelayer.ts';

export interface FilelayerMcpOptions {
  /**
   * The subject every tool call acts as, in YOUR id space -- the same string
   * you would pass as `{ as }`.
   *
   * A subject this instance has never seen denies every call and records the
   * denial, which is the existing facade behaviour and the right one: a typo in
   * a server's configuration must not silently become an anonymous session.
   */
  as: string;

  /** The organisation this server is scoped to, in your id space. */
  org: string;

  /**
   * How this agent identifies itself in the audit trail. Required, and there is
   * no default, because the whole point is that the chain can distinguish a
   * person from an agent acting for that person.
   *
   * Recorded verbatim as `user_agent` on every event these tools produce. It is
   * an assertion, not a measurement -- nothing verifies it and no authorization
   * decision reads it.
   */
  agentLabel: string;

  /** Register `delete_file`. Default false. */
  allowDestructive?: boolean;

  /** Register `file_audit`. Default false. See the note above. */
  exposeAuditTrail?: boolean;

  /** Register `read_file`, which returns file contents. Default false. */
  returnFileBytes?: boolean;

  /**
   * Refuse `read_file` above this many bytes. Default 1 MiB. Only consulted
   * when `returnFileBytes` is on. A large file in a context window is both
   * expensive and, usually, a mistake.
   */
  maxBytes?: number;

  /** Server name reported to the client. Default `filelayer`. */
  name?: string;
}

/**
 * Turn a thrown error into a tool result an agent can act on.
 *
 * Returns the stable `code`, plus the `meaning` and `fix` out of the generated
 * catalogue, so an agent that gets `no_membership` is told to establish
 * membership rather than left to guess from a status number. `reason` is NEVER
 * included: it carries the internal deny reason and in a response body it is an
 * enumeration oracle.
 */
function toToolError(e: unknown): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  if (e instanceof FilelayerError) {
    const entry = ERROR_CODES[e.code as ErrorCode];
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: e.code, status: e.status, meaning: entry?.meaning, fix: entry?.fix },
            null,
            2,
          ),
        },
      ],
    };
  }
  // Not ours. Do not describe it: an unexpected error's message can carry a
  // connection string or a file path.
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'internal' }) }],
  };
}

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/**
 * Load the two optional peers, or say which one is missing and how to get it.
 *
 * Dynamic, not static, and that is why this factory is async. A static import
 * of a missing optional peer fails with Node's own `ERR_MODULE_NOT_FOUND`,
 * which names one package and neither the second one nor the command. The
 * precedent in this package is `createTestDb()`, which names PGlite and the
 * exact install line; this does the same thing for the same reason.
 */
async function loadPeers() {
  const missing: string[] = [];
  let mcp: typeof import('@modelcontextprotocol/sdk/server/mcp.js') | undefined;
  let zod: typeof import('zod') | undefined;

  try {
    mcp = await import('@modelcontextprotocol/sdk/server/mcp.js');
  } catch {
    missing.push('@modelcontextprotocol/sdk');
  }
  try {
    zod = await import('zod');
  } catch {
    missing.push('zod');
  }

  if (missing.length > 0 || !mcp || !zod) {
    throw new TypeError(
      `@filelayer/core/mcp needs ${missing.join(' and ')}, which ` +
        `${
          missing.length === 1
            ? 'is an optional peer dependency and is not installed'
            : 'are optional peer dependencies and are not installed'
        }. The rest of this package has no runtime dependencies and this ` +
        'module is the only thing that needs these, which is why they are not ' +
        `pulled in for everyone.\n\n    npm install ${missing.join(' ')}\n\n` +
        'zod is not a preference: the MCP SDK accepts Zod schemas for a tool\'s ' +
        'inputs and nothing else.',
    );
  }
  return { McpServer: mcp.McpServer, z: zod.z };
}

export async function filelayerMcpServer(
  fl: Filelayer,
  opts: FilelayerMcpOptions,
): Promise<McpServer> {
  const { as, org, agentLabel } = opts;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;

  if (!agentLabel.trim()) {
    // A TypeError, deliberately, and not a FilelayerError. This is a call made
    // wrong at construction time, not an authorization outcome. The only code
    // in the catalogue that would fit is `internal`, and `internal` means "a
    // defect in this library, worth reporting" -- so using it here would send
    // an adopter to our issue tracker over their own missing argument.
    throw new TypeError(
      'filelayerMcpServer: agentLabel must be a non-empty string. The audit trail ' +
        'has to be able to record that an agent did this rather than a person, and ' +
        'there is no sensible default for who the agent is.',
    );
  }

  // Every call carries this. There is one `as` and it is not reachable from a
  // tool argument.
  const ctx = { as, userAgent: agentLabel } as const;

  const { McpServer, z } = await loadPeers();
  const server = new McpServer({ name: opts.name ?? 'filelayer', version: '1' });

  server.registerTool(
    'list_files',
    {
      title: 'List files this user can read',
      description:
        `Files in "${org}" that ${as} is authorized to read. Returns metadata only. ` +
        'Authorization is resolved per request, so a file that was shared and then ' +
        'revoked disappears from this list on the next call.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().nullish(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor }) => {
      try {
        const page = await fl.files.list({
          ...ctx,
          org,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return ok(page);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'file_info',
    {
      title: 'Describe one file',
      description:
        'Name, content type, size, owner and state for one file, without its contents. ' +
        'A file this user may not read answers not_found rather than forbidden, on ' +
        'purpose: a 403 would confirm the file exists.',
      inputSchema: { fileId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      try {
        return ok(await fl.files.stat(fileId, ctx));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'list_shares',
    {
      title: 'Who can reach this file',
      description:
        'Every live grant on a file: who it is for, what it allows, when it expires. ' +
        'Use this before sharing, because creating a share is not idempotent and a ' +
        'second call adds a second grant rather than updating the first.',
      inputSchema: { fileId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      try {
        return ok(await fl.shares.list(fileId, ctx));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'share_with_user',
    {
      title: 'Give one person access to one file',
      description:
        'Grant another user read access to a file. `expiresInSeconds` is REQUIRED: a ' +
        'grant with no expiry is a decision a person should make, not an agent. ' +
        'NOT IDEMPOTENT -- each call inserts a grant. To remove a person use ' +
        'unshare_user, which removes all of their grants on the file; revoke_share ' +
        'removes one grant and leaves any others they accumulated.',
      inputSchema: {
        fileId: z.string(),
        user: z.string(),
        expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 365),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ fileId, user, expiresInSeconds }) => {
      try {
        const grant = await fl.shares.create(fileId, {
          ...ctx,
          withUser: user,
          expiresIn: expiresInSeconds,
        });
        return ok({ grantId: grant.grantId, expiresAt: grant.expiresAt ?? null });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'create_share_link',
    {
      title: 'Create a link to one file',
      description:
        'A URL that carries its own authorization, for someone with no account. ' +
        '`expiresInSeconds` is REQUIRED. The secret is returned ONCE and is not ' +
        'recoverable afterwards. Do not set a download cap on media: a capped grant ' +
        'stops answering byte ranges, which breaks seeking in a video player. ' +
        'NOT IDEMPOTENT.',
      inputSchema: {
        fileId: z.string(),
        expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 365),
        maxDownloads: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ fileId, expiresInSeconds, maxDownloads }) => {
      try {
        const link = await fl.shares.create(fileId, {
          ...ctx,
          expiresIn: expiresInSeconds,
          ...(maxDownloads !== undefined ? { maxDownloads } : {}),
        });
        return ok({
          grantId: link.grantId,
          url: link.url ?? null,
          secret: link.secret ?? null,
          expiresAt: link.expiresAt ?? null,
        });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'revoke_share',
    {
      title: 'Revoke one grant',
      description:
        'Removes a single grant by id. The next request using it is refused; there is ' +
        'no window. If you meant "this person should no longer have access", use ' +
        'unshare_user instead, because one person may hold several grants.',
      inputSchema: { grantId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ grantId }) => {
      try {
        await fl.shares.revoke(grantId, ctx);
        return ok({ revoked: grantId });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'unshare_user',
    {
      title: 'Remove a person from a file entirely',
      description:
        "Revokes every live grant that person holds on that file. This is the tool " +
        'for "they should not have this any more". Answers revoked: 0 for a person ' +
        'with no grants and for a person this instance has never seen, identically, ' +
        'because distinguishing them would be an identity oracle.',
      inputSchema: { fileId: z.string(), user: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ fileId, user }) => {
      try {
        return ok(await fl.shares.unshare(fileId, { ...ctx, user }));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  if (opts.returnFileBytes) {
    server.registerTool(
      'read_file',
      {
        title: 'Read a file',
        description:
          `Returns the contents of a file ${as} may read. Text is returned as text; ` +
          `anything else is base64. Refuses above ${maxBytes} bytes.`,
        inputSchema: { fileId: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ fileId }) => {
        try {
          const meta = await fl.files.stat(fileId, ctx);
          // `sizeBytes`, not `size`, and it is nullable: a file whose upload was
          // authorized but never completed has no size yet. Treat unknown as too
          // large rather than as zero -- `files.get` refuses a pending file
          // anyway, and guessing would turn a missing number into a free pass.
          // (The `size` / `sizeBytes` split has now cost this project twice: once
          // in the Agent Skill's reference files, once here.)
          if (meta.sizeBytes === null || meta.sizeBytes > maxBytes) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'payload_too_large',
                    meaning:
                      meta.sizeBytes === null
                        ? 'The file has no recorded size, which means its upload was never completed.'
                        : `The file is ${meta.sizeBytes} bytes and this server returns at most ${maxBytes}.`,
                    fix: 'Use create_share_link and give the link to whoever needs the bytes.',
                  }),
                },
              ],
            };
          }
          const file = await fl.files.get(fileId, ctx);
          const isText = /^text\/|^application\/(json|xml|javascript)/.test(file.contentType);
          return ok({
            id: file.id,
            name: file.name,
            contentType: file.contentType,
            encoding: isText ? 'utf-8' : 'base64',
            content: isText
              ? new TextDecoder().decode(file.body)
              : Buffer.from(file.body).toString('base64'),
          });
        } catch (e) {
          return toToolError(e);
        }
      },
    );
  }

  if (opts.exposeAuditTrail) {
    server.registerTool(
      'file_audit',
      {
        title: 'Read the audit trail',
        description:
          `Authorization decisions recorded for "${org}", newest first, including ` +
          'denials and their reasons. Note that reading this trail is not itself ' +
          'recorded, so this call leaves no trace of having been made.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional(),
          decision: z.enum(['allow', 'deny']).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ limit, decision }) => {
        try {
          return ok(
            await fl.orgs.audit(org, {
              ...ctx,
              ...(limit !== undefined ? { limit } : {}),
              ...(decision !== undefined ? { decision } : {}),
            }),
          );
        } catch (e) {
          return toToolError(e);
        }
      },
    );
  }

  if (opts.allowDestructive) {
    server.registerTool(
      'delete_file',
      {
        title: 'Delete a file',
        description:
          'Marks the file deleted and schedules its bytes for collection. NOT ' +
          'RECOVERABLE. A file under a retention floor refuses with retention_hold, ' +
          'which is the floor doing its job and not an error to retry.',
        inputSchema: { fileId: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ fileId }) => {
        try {
          await fl.files.delete(fileId, ctx);
          return ok({ deleted: fileId });
        } catch (e) {
          return toToolError(e);
        }
      },
    );
  }

  return server;
}
