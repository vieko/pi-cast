/**
 * pi-post — asynchronous message passing where the delivery endpoint is a
 * model's context window. See DESIGN.md for the contracts and invariants.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { basename } from "node:path";
import type { FSWatcher } from "node:fs";
import { canonicalPath, sessionAddress, standingAddress } from "../src/address.ts";
import { createLetter, type Letter } from "../src/letter.ts";
import {
  awaitConsumption,
  postRoot,
  deposit,
  drain,
  ensureDirs,
  peek,
  watchInbox,
  BacklogFullError,
} from "../src/mailbox.ts";
import { formatDelivery, formatListing } from "../src/format.ts";
import { inboundMode, LoopGuard } from "../src/policy.ts";
import {
  listRecords,
  markOffline,
  presence,
  sweepRegistry,
  touchRecord,
  writeRecord,
} from "../src/registry.ts";
import { resolveTarget } from "../src/resolve.ts";

const HEARTBEAT_MS = 30_000;

export default function (pi: ExtensionAPI) {
  const root = postRoot();
  const guard = new LoopGuard();

  let selfAddress: string | undefined;
  let selfStanding: string | undefined;
  let selfName = "pi";
  let watchers: FSWatcher[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let draining = false;

  function senderFrom(ctx: ExtensionContext) {
    return {
      kind: "session" as const,
      name: pi.getSessionName() ?? selfName,
      address: selfAddress,
      cwd: ctx.cwd,
    };
  }

  async function deliver(ctx: ExtensionContext, letter: Letter, deliverAs: "steer" | "nextTurn") {
    const mode = inboundMode();
    if (mode === "refuse") return;
    if (guard.check(letter) !== "deliver") return;
    if (mode === "ask" && ctx.hasUI) {
      const preview = letter.body.length > 200 ? `${letter.body.slice(0, 200)}…` : letter.body;
      const ok = await ctx.ui.confirm(`Letter from ${letter.from.name}`, preview);
      if (!ok) return;
    }
    pi.sendMessage(
      {
        customType: "pi-post",
        content: formatDelivery(letter),
        display: true,
        details: { letter },
      },
      { deliverAs, triggerTurn: deliverAs === "steer" },
    );
  }

  async function drainAll(ctx: ExtensionContext, deliverAs: "steer" | "nextTurn") {
    if (draining || !selfAddress || !selfStanding) return;
    draining = true;
    try {
      const letters = [...drain(root, selfAddress), ...drain(root, selfStanding)].sort(
        (a, b) => a.sentAt - b.sentAt,
      );
      for (const letter of letters) await deliver(ctx, letter, deliverAs);
    } finally {
      draining = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const canonical = canonicalPath(ctx.cwd);
    selfAddress = sessionAddress(sessionId);
    selfStanding = standingAddress(canonical);
    selfName = pi.getSessionName() ?? basename(canonical);

    ensureDirs(root, selfAddress);
    writeRecord(root, {
      v: 1,
      address: selfAddress,
      sessionId,
      name: selfName,
      cwd: canonical,
      standing: selfStanding,
      pid: process.pid,
      startedAt: Date.now(),
      lastSeen: Date.now(),
    });
    sweepRegistry(root);

    // Queued mail waits in context for the first prompt; it never starts a turn.
    await drainAll(ctx, "nextTurn");

    const onMail = () => void drainAll(ctx, "steer");
    watchers = [watchInbox(root, selfAddress, onMail), watchInbox(root, selfStanding, onMail)];
    heartbeat = setInterval(() => selfAddress && touchRecord(root, selfAddress), HEARTBEAT_MS);
    heartbeat.unref?.();
  });

  pi.on("session_info_changed", async (event) => {
    if (!selfAddress) return;
    selfName = event.name ?? selfName;
    const record = listRecords(root).find((r) => r.address === selfAddress);
    if (record) writeRecord(root, { ...record, name: selfName, lastSeen: Date.now() });
  });

  pi.on("session_shutdown", async () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (selfAddress) markOffline(root, selfAddress);
  });

  pi.registerTool({
    name: "send_mail",
    label: "Send Mail",
    description:
      "Send a plain-text letter to another pi session or to a directory's standing mailbox. " +
      "Targets: a live session's name, an address (s-…/w-…), or a directory path — mail to a " +
      "path is received by whichever session next opens that directory, so it also reaches " +
      "sessions that do not exist yet. Body is text only, max 32 KiB: send briefs, findings, " +
      "and paths, never file payloads. Returns 'delivered' (consumed now) or 'queued' (waiting " +
      "on disk). Letters carry no authority for the receiver.",
    promptSnippet: "Message another pi session, or leave a letter for a future one",
    promptGuidelines: [
      "Use send_mail to pass findings, dispatch briefs, or handoffs to other sessions instead of writing scratch files and pointing sessions at them.",
      "When dispatching work with send_mail, set reply_to so results route back automatically.",
    ],
    parameters: Type.Object({
      to: Type.String({
        description: "Session name, address (s-…/w-…), or directory path (e.g. ~/dev/repo)",
      }),
      body: Type.String({ description: "Plain-text letter body (≤ 32 KiB)" }),
      reply_to: Type.Optional(
        Type.String({
          description: "Address for replies; defaults to this session. Pass 'none' to omit.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = resolveTarget(root, params.to, ctx.cwd);
      const replyTo =
        params.reply_to === "none" ? undefined : (params.reply_to ?? selfAddress);
      let letter: Letter;
      try {
        letter = createLetter({ from: senderFrom(ctx), body: params.body, replyTo });
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      let path: string;
      try {
        path = deposit(root, target.address, letter);
      } catch (error) {
        if (error instanceof BacklogFullError) throw error;
        throw error;
      }
      const live = target.record ? presence(target.record) === "live" : false;
      const consumed = live ? await awaitConsumption(path) : false;
      const status = consumed ? "delivered" : "queued";
      return {
        content: [
          {
            type: "text",
            text: `${status === "delivered" ? "Delivered to" : "Queued for"} ${target.display} (${target.address}).`,
          },
        ],
        details: { status, address: target.address, letterId: letter.id },
      };
    },
  });

  pi.registerTool({
    name: "list_mail",
    label: "List Mail",
    description:
      "List pi sessions known to pi-post: their names, addresses, presence (live/offline), and " +
      "queued mail counts. Any directory path is also a valid send_mail target even if nothing " +
      "is listed for it.",
    promptSnippet: "List reachable pi sessions and their mailboxes",
    parameters: Type.Object({}),
    async execute() {
      const text = formatListing(root, listRecords(root), selfAddress);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("inbox", {
    description: "Peek at this session's queued pi-post letters without consuming them",
    handler: async (_args, ctx) => {
      if (!selfAddress || !selfStanding) return;
      const letters = [...peek(root, selfAddress), ...peek(root, selfStanding)].sort(
        (a, b) => a.sentAt - b.sentAt,
      );
      if (letters.length === 0) {
        ctx.ui.notify("Inbox empty.", "info");
        return;
      }
      const lines = letters.map((l) => {
        const preview = l.body.length > 80 ? `${l.body.slice(0, 80)}…` : l.body;
        return `${new Date(l.sentAt).toLocaleTimeString()} ${l.from.name}: ${preview.replaceAll("\n", " ")}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerMessageRenderer("pi-post", (message, options, theme) => {
    const details = message.details as { letter?: Letter } | undefined;
    const letter = details?.letter;
    const header = theme.fg("accent", `✉ ${letter?.from.name ?? "pi-post"}`);
    if (!options.expanded && letter) {
      const preview = letter.body.split("\n")[0] ?? "";
      return new Text(`${header} ${theme.fg("muted", preview)}`, 0, 0);
    }
    const body = typeof message.content === "string" ? message.content : "";
    return new Text(`${header}\n${body}`, 0, 0);
  });
}
