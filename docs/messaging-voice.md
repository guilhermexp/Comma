# Messaging and voice

[IM rules](tools-integrations.md#im-providers).

## Comma iMessage

Comma uses one shared iMessage account through the Willow Mac relay and official BlueBubbles. Comma owns the Workspace binding. Salix owns the provider connection and Router delivery.
It takes private text and images, not groups, SMS, typing or other destinations. The Settings entry stays hidden, and starts no polling, until shared-account readiness is resolved.
The retained API creates a ten-minute claim command that binds its sender and chat to the user's default Workspace. Authenticated operations cancel attempts and disconnect bindings.

Server configuration: `COMMA_IMESSAGE_ENABLED`, `COMMA_IMESSAGE_RELAY_ID`, `COMMA_IMESSAGE_RELAY_BASE_URL`, `COMMA_IMESSAGE_RELAY_BEARER_TOKEN`, `COMMA_IMESSAGE_SHARED_HANDLE`, and `COMMA_IMESSAGE_SHARED_IDENTITY` (display name).
Only the configured origin gets the bearer, without redirects. Sends require the binding's exact sender and chat.

One PostgreSQL advisory lock serializes receiver passes, every five seconds. A new relay ID starts at the tail. Admission or explicit rejection precedes cursor advancement. Replay after a lost checkpoint uses the Session input identity and deduplication.
Malformed values and group messages get no private-chat authority.
Limits: 1 MiB per event, ten images of 20 MiB per message, 1,000 expired claims pruned per pass, a 120-second database checkout per pass and bounded HTTP waits.
A process pauses after three failed owning passes without a successful one. Waiting for another owner does not reset the count. Restore the dependency and restart the receiver to resume from the saved cursor. Lock contention prevents a fixed total elapsed-time bound.

A text or image send makes one HTTP attempt. A timeout, error or missing acknowledgement returns `imessage_delivery_unknown`, `retryable=false`: the Agent stops the turn and asks for verification in Messages. A relay message ID is acknowledgement, not Apple delivery. There is no cross-call deduplication.

Before real acceptance, confirm the shared Apple identity, stop any previous relay consumer, and test locally with a separate relay origin and database. Preserve the previous configuration and data.
Verify binding, inbound chat, text and image replies, disconnect and rebind with the test contact. Fixtures do not prove real delivery. A rollback disables the receiver and keeps binding tables.

## Comma WeChat ClawBot

Owners create five-minute QR attempts with new IDs and optional pairing codes. Channels polls sequentially every 3s, with 15s timeouts.
Refresh retries activation; cancel/reconnect invalidate attempts. Retirement preserves previously active records only.
Comma owns references; Salix owns credentials/peers/cursors/lifecycle. Setup locks the Workspace; HTTP holds no DB checkout.
Activation rechecks authorization/references. Enablement requires persisted references and bot reservation. Disconnect retires current/pending connections.
CAS fences stale releases. Non-atomic S3 deletion requires reusable identity tombstones. Workspace migration preserves data.

Tencent's SDK needs OpenClaw's Node runtime; Elixir uses Req/OTP AES. QR URLs require approved WeChat HTTPS origins, without redirects.
Browser responses omit tokens and forbid caching. Only the scanned account's private messages enter its Workspace, never groups.

Before staging, IM Connect stores one batch, limited to 100 messages/1 MiB. Oversized batches cannot advance the cursor.
Polling drains pending heads before fetching. Revision CAS advances after Router admission or a product-command reply; the final head commits the cursor.
Completed receipts skip downloads; legacy receipts replay through Router source-ID deduplication. Exit cannot complete unfinished receipts.
A 30s lease reduces concurrency, not delivery authority. Stale workers may replay, but cannot advance newer state/context.
After exit, polling resumes after lease expiry. Passes repeat 5s after completion; outages delay recovery.
Pending inputs survive restart/deployment. Older binaries cannot drain them; use forward repair.

Current text/transcripts supply authority, never quotes. Text/image/file/voice/video quotes parse once, without recursion.
ID-only quotes resolve observed inputs/replies within one connect/peer: 10 direct items, 4 exact reads, no scans.
Quotes have a 64 KiB limit and seven-day logical expiry, not physical deletion. Missing originals stay explicit, without summary substitution.
Quotes grant no Message/delivery authority or unobserved-history access.

Direct/quoted media share staging/Blob/VFS: four attachments, 10 MiB plaintext each. Unsupported items/failures stay explicit.
Downloads share a 15s soft budget, checked before requests/at chunks. Receive waits use remaining time; Blob/VFS time is excluded.
CDN connections time out after 5s, without credentials/redirects. One transient HTTP/transport retry shares the budget; total wall time is unbounded.
CDN URLs/keys stay private; path hashes confer no authority.
Peer authorization precedes staging and Session admission. Raw voice/video need tools; receipts prove neither transcription nor understanding. Outbound quote bubbles remain unverified.

Inline image syntax is removed. Native media uses `reply_image`/`reply_file`/`reply_video`.
Video uses VFS/AES/CDN with mp4/mov/webm/mkv/avi paths, without transcoding or playback guarantees.
Captions are separate; media failure can follow a successful caption.

No drafts or status text leave.
Each peer actor keeps tickets/32 source IDs, refreshes at most every 4s, and stops after 30min or 60s idle.
Ticks check connection/Router ownership without cancelling started HTTP. Connect/response timeouts are 2s, without retries. Presentation failure cannot reject input.
Fixtures/deployment prove neither live delivery nor model understanding.

## Telegram OIDC transport

OIDCC owns the OIDC flow. Discovery and JWKS reads retry once on a transport failure. Token exchanges never retry: codes are single-use.
Exhausted requests emit `telegram_oidc_transport_failed` without URLs, credentials, bodies or raw exception messages. Events prove neither alert coverage nor recovery.

## Telegram questions and replies

`question.request` sends a native question in the current authorized Telegram chat: inline buttons for choices, else a text reply.
Delivery ends the activation. The answer becomes a new input without polling. A chosen card shows the answer without buttons. Repeated callbacks enqueue nothing.

Untargeted replies and questions quote the source message. Explicit targets stay unchanged. Answers quote the card or typed answer.
References use Telegram IDs, never Salix or guessed IDs. Automatic references allow delivery without the original in the same request. Comma never retries ambiguous sends without their reference.

## Telegram location requests

Comma Telegram neither discloses nor executes `location.request`: it returns `location_request_unavailable` before database lookup or button dispatch, also for old disclosures. Ask for a city in text instead.
User-sent locations, answers to earlier requests and internal host location are unchanged. The native button has not passed client acceptance.

## Voice calls

`salix_voice`: Twilio/WebSocket/Electron. GPT Live speaks; Router acts.
`CallActor` owns profile/model/transport/transcript/delegations/deadline/metering in memory.
Manual calls greet; PTT skips profile/greeting. Both emit `voice.call_started/ended` (reason, open delegations).

Delegations send caller text/last agent sentence after 300 ms via `ConversationServer -> ConversationActor`.
Codex requests; API uses transcript offsets. Metadata `provider=voice`, `chat_id=call`, `message_id=delegation`; source `im_provider:voice:<connect>:<call>:<delegation>`.
Router: `im_api.voice.say` speaks; `voice.note` quiet context; `voice.hang_up` ≤10 s, optional farewell.
Text ≤16,000 bytes; API chunks ≤1,800 chars. IDs default to source; Group/connect must match.
Ended PTT `voice.say`: Router text in the original chat; no Agent/provider wakeup/redial. Canonical input binds caller/connect/call/delegation; metadata carries lineage. Other ended operations: terminal `voice_call_ended`, no retry.
Pending: quiet progress at 20 s, spoken apology at 90 s; no Lean reply obligations.
Caller: phone identity, WebSocket key creator, authenticated Electron user.

### Electron subscription calls

Mac Home: Call/mute/captions/hang up/transcript; no Web call UI.
WebRTC: main/`push-to-talk-voice` audio only, with macOS permission; deny other windows, frames and camera.
Full sessions use `/v1/comma/workspaces/:workspace_id/voice/calls`:
`POST {sdp, mode?}` → `{sdp, call_id}`; `GET /:call_id/events?after=N` → events/cursor; `DELETE /:call_id` ends.
`POST /:call_id/context {text, attachments?}` → `session.context.append`; uploaded `{path, name, mime}` images reach Router VFS and next delegation only. Require Workspace/original user; `no-store`.
`mode: "push_to_talk"`: hidden mic. Press unmutes; release mutes before print upload; service ends turns. Warm 90 s after speech; pending delegations retain; 10 min cap. Late reply → `ready`, click opens chat. One chat lease/account, no delegation polling.

Admission: enabled voice + tenant Codex AccountPool, no API key.
Salix signals ChatGPT `codex/realtime/calls?intent=quicksilver&architecture=avas`, model `gpt-live-1-codex`, then controls `wss://api.openai.com/v1/live/<rtc_id>`.
Approved Codex Desktop headers; `:codex` `version` default `0.161.0`. On one 401, AccountPool renews/retries once. Plan limits refuse. Never read native Codex logins or expose credentials.
Context ≤500 UTF-8 bytes/chunk. Final replies omit `channel`; other context: commentary. Silent notes; captions merge per turn, no final repeats.
Poll serially/500 ms/caller: ≤200 events, 512 KiB queue, explicit gaps. No reads/60 s ends calls. Ended events expire/60 s, reads or not.
Manual view: ≤200 turns after hangup; leaving closes media/call. No durable transcript.

### Limits, drain and billing

API audio passes unchanged: mu-law 8 kHz, or WebSocket PCM16 24 kHz. Keep newest 2 s before model startup. Barge-in clears playback.
One call per Group; races keep earlier `{started_at_ms, call_id}`, else `busy`. `max_calls_per_node` bounds each node. `max_call_seconds` ends with notice.
Attach: 20 s Twilio, 5 s WebSocket/Electron. Model startup after profile: 15 s API, 60 s subscription.
Pre-stop withdraws readiness, rejects admission, notifies callers, ends in 5 s and forces the rest at 8 s.

`VoiceMetering` authorizes API calls at admission/model start. Group ownership and `voice:<carrier>:<carrier call ID>` key the charge, without key IDs. Model/carrier seconds apply; lost model transport bills at least elapsed time. Missing prices stay pending; no billing owner means no charge.
Subscription seconds use charge reporting source `billing_core.voice_subscription`, status `tenant_funded`, zero credits, no ledger debit or pending charge. No Comma credit admission applies. Reporting is best effort: buffer loss, missing owner or sink failure can leave no row.
Metrics labels: finite `transport`, `reason`, `outcome`.

## Twilio admission

Public Twilio paths allow 600 requests a minute per peer address, 6,000 in total. Then:

1. `POST /v1/voice/twilio/{incoming,pin,status}` check `X-Twilio-Signature` over the public URL and exact POST parameters: 403 and no TwiML on failure, 413 over 16 KB.
2. `To` must be a platform line, and `From` a number bound on that line.
3. Full STIR/SHAKEN attestation (`TN-Validation-Passed-A`) passes. Other callers enter the number's PIN at `POST /v1/voice/twilio/pin`. Salix refuses a number without a PIN.
4. `SalixVoice.admit/1` checks drain, enablement, the OpenAI key, capacity and the Group's call.
5. Salix answers `<Connect><Stream>` to `/v1/voice/twilio/stream/<token>`.

After the signature check, Salix speaks each refusal and hangs up.
A PIN has 4 to 8 digits, stored as a salted PBKDF2-SHA256 hash. `pin_max_failures` failures lock the number for `pin_lockout_seconds`. Success, or a new PIN, clears the count.

The stream token is an HMAC-SHA256 over call, connect, Group, `CallSid` and a 60 s expiry, keyed from the deployment credential root. An invalid token gets 404 before the upgrade.
At Twilio's `start` frame, the actor refuses a wrong or missing `callSid` and a second socket. At the end, Salix sends a best-effort Calls API hangup.

No Elixir SDK covers these calls; carrier/model modules isolate protocols.

## Caller numbers

Each voice Group has one `voice` IM Connect, elected by the `ProviderIdentity` reservation `voice:group:<group_id>`. It lists at most 20 verified numbers and delivers every call, WebSocket calls included.

A number is bound only after Twilio Verify approves an SMS code (10 codes per Group and 5 per number each hour).
Each binding reserves `voice:<carrier>:<line>:<e164>`, so a number on a line routes to one connect. A number held by another Group gets 409 `voice_number_in_use`.
Writers reserve before listing and release after removal. Removal ends the number's live call (`revoked`). Routing rereads the connect. A holder that no longer lists the number routes nothing, and another Group may take it after 60 s.

Salix routes: `/v1/runtime/agent-groups/:group_id/im-connects/voice` (`GET`, `POST numbers/verify-start` and `verify-check`, `DELETE numbers/:e164`, `PUT pin`).
Comma mirrors them at `/v1/comma/workspaces/:workspace_id/integrations/voice` for the default Group, without the connect or PIN hash.

## WebSocket voice API

`GET /v1/agent-groups/{group_id}/voice` returns readiness, `busy`, formats, limits and `sessions_url`. `GET .../voice/sessions` upgrades to one session with subprotocol `comma.voice.v1`.
Both need `Authorization: Bearer salix_vk_...` of the path Group, never a URL key. Before the upgrade: 401 for a bad key, 400 without the subprotocol, 503 while draining.
Text frames are JSON objects, at most 16 KB, named by `type`. Both sides ignore unknown fields and types. Breaking changes ship as `comma.voice.v2`.

The first client frame is `session.start {audio_format, client, display_name?}`, within 10 s.
Formats are `pcmu_8k` or `pcm16_24k` (little-endian mono); `client` is `name/version`.
Salix answers `session.started {call_id, audio_format, max_duration_s}`. Both send binary audio, at most 16 KB.
Salix sends `output.clear` to drop playback and `output.mark {name}`; the client answers `output.played {name}` after playback.
`transcript {role, text, final}` uses `caller` or `agent`. The client hangs up with `session.end`.
Salix ends with `session.ended {reason, duration_s}` or `error {code, message}`, then closes with integer `code`.

| Close | Cause |
| --- | --- |
| 1000 | Normal end, deadline, or another reason named in `session.ended` |
| 4400 | Bad frame or order, or caller audio over 1.25x real time for 5 s |
| 4401 | Key disabled, deleted or expired, or its Group deleted |
| 4408 | No `session.start` in 10 s, no audio for 60 s, or no pong for 45 s |
| 4409 | The Group has an active call |
| 4410 | Client playback more than 2 s behind |
| 4503 | Draining, disabled, not configured, node full, or GPT-Live unavailable |

Salix writes agent audio at most 500 ms ahead of playback. Clients send paced silence while muted. v1 excludes browsers: they cannot set the header.
[`comma-voice`](../systems/voice/comma-voice/README.md) is the reference client and E2E driver.

## Voice agent API keys

A voice agent key is the `voice` kind of the Agent Group API Key record (`Salix.Control.GroupApiKeys`). It keeps hash-only storage, one-time plaintext, status, expiry, creator and principal rules.

Inbound `salix_gk_` keys open Router post-message/Loop events; voice `salix_vk_` keys open readiness/sessions only.
Comma, Salix dashboard and tenant APIs mint both kinds. Each kind allows 20 keys per Group.

The prefix selects the kind before hash lookup; stored kind must match. Router tools mint only inbound keys, preventing prompt-injected billable credentials.
Rows default to `inbound`. Routes: Salix `/v1/runtime/agent-groups/:group_id/voice/api-keys`, Comma `/v1/comma/workspaces/:workspace_id/voice-api-keys`.
Disable, delete and Group deletion reach live calls via `:pg`: a spoken notice, then close 4401. A timer (reset on change) ends calls at key expiry. Sessions recheck it at start; no polling. Session start updates `last_used_at`.

## Voice settings

Platform settings are one JSON object at `ctl/system/voice.json`, managed at `/dash/voice` or admin `GET`/`PUT /v1/admin/voice/settings`, not env vars or `config.json`.
Writes use compare-and-swap. `openai_api_key` and `twilio_auth_token` are write-only: reads show `<field>_configured`, blank keeps, `clear_secrets` removes.
Defaults: `enabled` false, `gpt_live_model` `gpt-live-1`, `max_call_seconds` 1800, `max_calls_per_node` 50, `pin_max_failures` 5, `pin_lockout_seconds` 900. Other fields: GPT-Live URL (`wss`, or `ws` for loopback only) and voice, Twilio SIDs, `twilio_numbers` (platform lines), `public_base_url` (signed and published URLs).

## Voice profile

Before GPT-Live starts, `SalixVoice.Profile` asks Jev (`decide`) one `choice` question per template field: `language`, `reply_length`, `formality`, `small_talk`, `expertise`, `units` and `clock`. Each has `unknown`.
An answer counts at its field threshold, a 70% to 80% winning probability, not calibrated. Fixed sentences for counted answers extend the instructions and set the greeting language. No user or Jev text reaches GPT-Live. Nothing is stored.

`SalixAgent.RouterDecision` sends the newest 12 user and assistant texts of the Router session, 1,500 bytes each, within 12 KiB. `decide` is public egress. By owner decision, message IFC labels and the Group IFC policy do not filter this text. Without text, it sends nothing.
The profile runs when `decide` is configured and meters as `voice_profile`. After 2.5 s or a failure, the model starts with the base instructions.

## Voice verification

Local model/carrier fakes cover admission, delegation, chunks, captions, timers, revocation, drain and media. Client fixtures cover call states and microphone authority, not provider delivery.
Earlier live API runs proved PCM16, mu-law, delegation, seconds and barge-in. Subscription, read-aloud, Twilio, multi-node behavior and pricing need runtime evidence. Capacity, one-call, drain and Twilio rate limits need independent availability-gate review. Calls have no TLA+ model.

## Signal

Register at `/dash/signal/register`. Keys persist before startup. Failures stay `registering`. A verified session resumes `registering` accounts for that number and service. Active numbers are refused.
Shared tenant number: `/dash/signal`, `PUT /v1/admin/signal/settings`. A tenant's active account overrides it for new claims.
A `signal` IM Connect binds up to 50 ACI or `group:<id>` peers. `signal:peer:<account>:<peer>` routes each peer to one Group.
Bind with `comma connect XXXX-XXXX`. Codes appear once, expire in 10 minutes, and work once. Store only SHA-256 digests (`signal:claim:<account>:<digest>`). Only a code holder binds. Unbound senders get no reply.
Bound messages, files, voice notes, reactions, edits and deletes enter the Router at least once as `im_provider:signal:<connect>:<sender>:<timestamp>`. Permanent refusals drop just that one.
Accounts accept ACI/PNI invitations. Joining initializes missing profiles and preserves named profiles. Membership does not bind chats.
`signal.*` tools reach only bound chats; replies and failure notices use `signal.send_message`. Bound peers' calls are Voice Calls. Unbinding ends them.
Routes: `/v1/runtime/agent-groups/:group_id/im-connects/signal`, `/v1/runtime/signal/number`, Comma `/v1/comma/workspaces/:workspace_id/integrations/signal`.

Calls require one TURN-over-TLS relay, no UDP or direct ICE paths. TLS failure stops startup.
