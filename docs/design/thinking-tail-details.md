# Thinking tail preview with full scoped details

## Request and scope

User requested: 主卡只保留最近的 300 Token，旧内容刷掉、不再占卡片容量；提供与 edit 详情一样可打开、可关闭的完整思考。首卡延迟/性能排查明确延期；本改动不调整刷新节奏、模型、推理服务或 worker。

Isolated worktree: `/home/pan/work/tlive-card-thinking-tail`, branch `feat/thinking-tail-details`, base `70eaab9` (standalone 400ms trial documentation). Reused existing dependencies, no install, no main-branch merge or remote push.

## Display behavior

- Normal renderer turns have a fresh local turn UUID; thinking identity is `turnId:blockId`. Legacy turns without this identity keep full text instead of sharing a mutable cache entry across unrelated turns.
- Build full flow blocks and classify 50-Token continuity first. Previewing does not alter grouping, original timeline, tool inputs/results, answer content, or model context.
- Across all thinking blocks in a progress card, allocate one **300 estimated Token** text budget from newest to oldest. This is the existing display estimate (ASCII characters / 4; other Unicode code points / 1), not the model's tokenizer. Do not represent it as an exact model-token count.
- Cut the suffix on complete Unicode code points; preserve original retained whitespace. Redact the complete thinking text before cutting, so a cut cannot remove a key prefix and expose its suffix.
- Older thinking text is absent from serialized card JSON, not hidden behind folding. Small headers/preview notices and per-block `查看完整思考` buttons remain.
- Thinking is expanded while running and folded after completion as before. Answers and necessary tool outputs remain complete.
- If full detail registration is unavailable (capacity/identity/store failure), retain full source on the main card and label the fallback; never delete the only accessible copy merely to satisfy a cosmetic length limit.

## Full details

- Extend the existing detail store with trusted, internally generated thinking identities; a growing block updates only its latest complete redacted source under a stable opaque callback ID. It does not allocate a snapshot per model delta.
- `flow_detail:open:<opaqueId>` freezes the latest complete source at the time the open operation executes. Pagination is literal plain text, lossless, Unicode-safe, and constrained by the actual card/request budget.
- Growth of the live source does not shift the currently open pages. Closing releases the frozen browsing copy; reopening obtains the latest full source.
- Reuse chat/owner/source-message/explicit-thread/route authorization, callback serialization, bounded queues, stable UUID retries after an uncertain send response, and one physical detail message. Standard callbacks that omit `thread_id` remain supported.
- Close removes only the detail message. If deletion fails, replace that exact detail with a thinking-specific closed placeholder; if both fail, report failure and retain the browse state.
- Source registration is a trusted internal API; route binding rejects reassignment but is not a substitute for validating the caller of registration. The formatter requires the locally generated turn identity before invoking it.
- Existing expiry and memory bounds remain. Full thinking details are bridge-memory snapshots, not permanent chat/file storage; bridge restart loses them. Live growth does not extend the original TTL.

## Verification

`npm run check` (typecheck + lint), `npm run build`, `node --check dist/main.mjs`, `git diff --check`, and `npm run test:coverage` passed. Final coverage run: **85 test files / 847 tests**. Logs: `/tmp/tlive-thinking-tail-{check,build,coverage}.log`.

Coverage includes tail bounds, Unicode/whitespace, aggregate multi-block budget, unmodified full answers, old text absent from JSON, redaction-before-cut, safe legacy/capacity fallback, renderer → presenter → formatter → actual adapter budget/sender wiring, first-card immediacy, unchanged 400ms cadence, full multi-page reconstruction, opening while growing, frozen pages/reopening, authorization, pending callbacks, TTL/limits, close failures and unknown send retries. SDK/network behavior is exercised with mocks and is not a substitute for live phone acceptance.

## Rollout and rollback

Not deployed yet. Keep the running standalone 400ms bridge and original client unchanged until user confirms switching. Rollback worktree: `/home/pan/work/tlive-card-snapshot-400ms`; no default CLI or systemd unit modification.
