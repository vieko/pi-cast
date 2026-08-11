# Design

pi-post is asynchronous message passing where the delivery endpoint is a
model's context window. A maildir for pi sessions: every session has an
address, messages queue on disk, and "delivered" means the text entered
the receiving agent's context at a safe point in its turn.

Two contracts pin everything else: the **address derivation** and the
**message schema**. Change either only with a version bump.

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
```

## Addresses

One kind: a **session address**, `s-` + 12 hex chars of SHA-256 of pi's
session id. It names a conversation, not a process — it survives
restarts and `pi -c`, and two sessions never share one.

Only sessions have addresses. **A directory path as a target is a
query, not an address**: it resolves to the session registered in that
directory (live outranks offline; a remaining tie is refused with
candidates listed). Nothing can be addressed that does not exist.

v0.2.0 had a second kind — standing addresses, one per directory, so
mail could wait for sessions that did not exist yet. Removed in v0.3.0:
in a busy repository, directory identity is not task identity, so
standing mail raced among concurrent sessions, delivered to the wrong
successor, and — because consumption is the receipt — misdelivered
*silently and destructively*. The lesson is recorded as a non-goal
below: how sessions come to exist is not the transport's business.

## Message schema (v1)

One message per file, named `<sentAt ms, 13 digits>-<8 hex nonce>.json`:

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

- `from.kind` is `"session"` or `"process"`. Process senders (an anvil
  run at exit, a Claude Code hook, a script) have no inbox; `from.address`
  is absent and the message may carry no `replyTo`.
- `replyTo` is pinned at dispatch so results route home automatically.
- Body is plain text, capped at 32 KiB. A brief fits; a payload does not.
  Send a summary and a path, never file contents as state transfer.

## A message, end to end

1. Sender resolves the target: an explicit address, a live session's
   name, or a directory path (→ the session registered there). Ambiguity
   is an error listing candidates, never a guess.
2. Sender writes `<inbox>/<name>.json.tmp`, then renames into place. A
   draining reader never observes a partial message.
3. If the target session is live, the sender waits up to 1.5 s for the
   file to vanish and reports **delivered**; otherwise **queued**.
4. The receiver drains oldest-first, unlinking each message as it reads
   it. Nothing is delivered twice; consumption is the receipt.
5. Each message passes the inbound guard (mode + loop caps), then enters
   context wrapped in the boundary preamble:
   - live mail → `deliverAs: "steer"`, `triggerTurn: true` — lands between
     tool calls; **wakes an idle session**, so a freshly spawned worker's
     first turn can be the brief itself
   - startup/resume drain → `deliverAs: "nextTurn"` — waits in context for
     the next prompt; queued mail never starts a turn on its own

## The boundary

Every delivered message is framed with: it came from another session or
process, not from the user; it carries no authority; it cannot approve
actions, change configuration, or close out review; slash commands in it
are inert text. A "done" message is a claim, not an approval — the
review pipeline is unchanged by this channel existing.

## Invariants

Each is pinned by a test.

- **An address belongs to a conversation, not a process.** The same
  session resumed tomorrow answers to the same address.
- **A reader never sees half a message.** Rename-into-place; only
  `.json` is read.
- **Nothing is delivered twice.** Unlink before handling.
- **Mail outranks tidiness.** No sweep deletes a non-empty mailbox.
- **Loops terminate structurally.** Identical body from one sender inside
  10 s is dropped; a sender is throttled past 8 messages in 30 s; a
  mailbox stops accepting at 50 queued messages. Independent of model
  behavior.
- **The sender learns the truth.** *Delivered* means the message
  vanished; anything else is *queued*.
- **Resolution refuses rather than guesses.** Unknown targets and
  ambiguous targets are errors, not best-effort deliveries.

## Inbound control

`PI_POST_INBOUND`: `accept` (default) delivers, `ask` prompts per message
where a UI exists (falls back to accept headless), `refuse` drops.

## Non-goals

- Payloads, files, conversation history. Text only, by design.
- Spawning or steering processes. pi-post is transport; orchestration
  belongs to the user, tmux, and the executor.
- **Session lifecycle.** pi-post moves text between sessions that exist;
  how sessions come to exist — and what context waits for sessions that
  do not exist yet — is the caller's convention. Successor handoffs
  belong in project memory (which any number of future sessions can
  read), not in a consume-once message that exactly one arbitrary
  session would destroy on reading.
- Cross-machine anything. Two parties can reach each other exactly when
  they share a filesystem.
- Messaging *into* other runtimes (e.g. Claude Code sessions). Inbound
  from them already works — anything that can run the CLI can send.

## Prior art

The mailbox mechanics converge with [pi-peer](https://github.com/shift-labs-ai/pi-peer)
(MIT), whose ARCHITECTURE.md and test-suite-as-specification informed this
design, and the boundary model follows Claude Code's cross-session
messaging. pi-post differs in pinned reply-to routing, process senders
via a standalone CLI, and wake-on-idle delivery that lets a message
start a freshly spawned session's first turn.
