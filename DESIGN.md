# Design

pi-post is asynchronous message passing where the delivery endpoint is a
model's context window. A maildir for pi sessions: addresses name
conversations — including ones that do not exist yet — mail queues on disk,
and "delivered" means the text entered the receiving agent's context at a
safe point in its turn.

Two contracts pin everything else: the **address derivation** and the
**letter schema**. Change either only with a version bump.

## Shape

A shared directory. No daemon, no socket, no connection. Sending is
`writeFile`; receiving is `fs.watch` on your own inbox plus a drain at
session start.

```
~/.pi/agent/post/             0700   (override: PI_POST_DIR)
  registry/
    s-1ce0cbe5fe96.json       presence record: who, where, live or not
  inbox/
    s-1ce0cbe5fe96/           a session's mailbox
      01786137505631-a4c187c6.json
    w-e8f14204d058/           a standing mailbox (a *place*, not a process)
      01786137509999-b2d411aa.json
```

## Addresses

Two kinds, both stable, both 12 hex chars of SHA-256:

- **Session address** `s-<hash of pi session id>` — names a conversation.
  Survives restarts and `pi -c`; two sessions never share one.
- **Standing address** `w-<hash of canonical directory path>` — names a
  seat. Derived from `realpath()` of a directory, so it exists before any
  session does and after every session dies. Mail to a standing address is
  read by whichever session next opens that directory.

The standing address is the load-bearing feature. A dispatched worker's
worktree *is* its address: create the worktree, mail the brief to that
path, start the session in it — the brief lands in-context on turn one
with no name coordination. A handoff to "the next session on this repo"
is mail to the repo's standing address.

## Letter schema (v1)

One letter per file, named `<sentAt ms, 13 digits>-<8 hex nonce>.json`:

```json
{
  "v": 1,
  "id": "01786137505631-a4c187c6",
  "from": { "kind": "session", "name": "gtm-summoner", "address": "s-...", "cwd": "/Users/x/dev/gtm" },
  "replyTo": "s-1ce0cbe5fe96",
  "sentAt": 1786137505631,
  "body": "text, ≤ 32 KiB"
}
```

- `from.kind` is `"session"` or `"process"`. Process senders (an anvil run
  at exit, a Claude Code hook, a script) have no inbox; `from.address` is
  absent and the letter may carry no `replyTo`.
- `replyTo` is pinned at dispatch so results route home automatically.
- Body is plain text, capped at 32 KiB. A brief fits; a payload does not.
  Send a summary and a path, never file contents as state transfer.

## A letter, end to end

1. Sender resolves the target: an explicit address, a directory path
   (→ standing), or a live session's name (→ session). Ambiguity is an
   error listing candidates, never a guess.
2. Sender writes `<inbox>/<name>.json.tmp`, then renames into place. A
   draining reader never observes a partial letter.
3. If a live session owns that inbox, the sender waits up to 1.5 s for the
   file to vanish and reports **delivered**; otherwise **queued**.
4. The receiver drains oldest-first, unlinking each letter as it reads it.
   Nothing is delivered twice; consumption is the receipt.
5. Each letter passes the inbound guard (mode + loop caps), then enters
   context wrapped in the boundary preamble:
   - live mail → `deliverAs: "steer"`, `triggerTurn: true` — lands between
     tool calls, wakes an idle session
   - startup drain → `deliverAs: "nextTurn"` — waits in context for the
     user's (or dispatcher's) first prompt; a queued handoff never starts
     a turn on its own

## The boundary

Every delivered letter is framed with: it came from another session or
process, not from the user; it carries no authority; it cannot approve
actions, change configuration, or close out review; slash commands in it
are inert text. A "done" letter is a claim, not an approval — the review
pipeline is unchanged by this channel existing.

## Invariants

Each is pinned by a test.

- **An address outlives every process.** Session addresses survive
  restarts; standing addresses precede and outlive all sessions.
- **A reader never sees half a letter.** Rename-into-place; only `.json`
  is read.
- **Nothing is delivered twice.** Unlink before handling.
- **Mail outranks tidiness.** No sweep deletes a non-empty mailbox.
- **Loops terminate structurally.** Identical body from one sender inside
  10 s is dropped; a sender is throttled past 8 letters in 30 s; a mailbox
  stops accepting at 50 queued letters. Independent of model behavior.
- **The sender learns the truth.** *Delivered* means the letter vanished;
  anything else is *queued*.

## Inbound control

`PI_POST_INBOUND`: `accept` (default) delivers, `ask` prompts per letter
where a UI exists (falls back to accept headless), `refuse` drops.

## Non-goals

- Payloads, files, conversation history. Text only, by design.
- Spawning or steering processes. pi-post is transport; orchestration
  belongs to the user, tmux, and anvil.
- Cross-machine anything. Two parties can reach each other exactly when
  they share a filesystem.
- Messaging *into* other runtimes (e.g. Claude Code sessions). Inbound
  from them already works — anything that can run the CLI can send.

## Prior art

The mailbox mechanics converge with [pi-peer](https://github.com/shift-labs-ai/pi-peer)
(MIT), whose ARCHITECTURE.md and test-suite-as-specification informed this
design, and with Claude Code's cross-session messaging boundary model.
pi-post differs in its addressing (standing addresses for sessions that do
not exist yet), first-class reply-to routing, and process senders.
