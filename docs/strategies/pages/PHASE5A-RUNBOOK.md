# PHASE 5A RUNBOOK — fresh independent session

Status: **Phase 6 is BLOCKED.** No strategy logic may change. `change30` stays
research-only. This runbook collects independent evidence; it does not revise the
strategy.

**First fresh independent session: Monday 2026-10-05.**
(2026-10-03 is Saturday, 2026-10-04 is Sunday, **2026-10-05 is Monday**,
2026-10-06 is Tuesday.)

Every command below uses `--day=2026-10-05`.

## Frozen (do not touch)

- OF03-v1 — frozen, byte-identical copy in `strategies/frozen/orderFlow.of03v1.js`
- OF01 and OF02 — REMOVED 2026-10-15 (not merely disabled); the pre-prune engine is in `data/quarantine_2026-10-15/`
- `change30` — research candidate only
- planner, `follow()`, all thresholds — unchanged
- Frozen hashes: engine `90471e9ae616cd62` · planner/config `7a311fe0bc97b1d7` · follow `e4753e0fe896dd02`

## Before the open (Monday 2026-10-05)

Keep in `.env`:

```
GB_TICK_CAPTURE=1
GB_ORDERFLOW_DIR=data/orderflow
```

Start the **known-good** production method — repo-root `node server.js`:

```bash
node Server.js
```

> STALE — DO NOT USE as the production launch method: `ecosystem.config.js`,
> `start_service.bat`, `start_background.vbs` all point at `broker/`, which has no
> `Server.js`. They are marked stale and not corrected. Launch from the repo root.

## Confirm arming (within ~60s of start)

Expected log lines:

```
[orderflow/capture] armed on N tokens ... mode QUOTE · correlation gb_capture
[orderflow/journal] live detector armed on N symbols -> data\terminal\phase5-live-journal-2026-10-05.jsonl
```

- **Live tick capture running:** the `[orderflow/capture] armed` line appears.
- **Live detector processing the feed:** the `[orderflow/journal]` line appears.
- **Journal records LIVE events only:** every journal row's `decisionBarTime` must
  be `2026-10-05 ...`, never a September seed date. Warm-up seed events are
  suppressed by design; verify:

```bash
grep -c '"decisionBarTime":"2026-10-05' data/terminal/phase5-live-journal-2026-10-05.jsonl
grep -c '"decisionBarTime":"2026-09'      data/terminal/phase5-live-journal-2026-10-05.jsonl   # must be 0
```

## During the session

Watch the 5-minute health line:

```
[orderflow/journal] rows <n> · armed <n> · eligible <n> · flushes <n> · writeErrors <n>
```

`writeErrors` must stay 0 and `rows` must keep growing. Do not change thresholds
or strategy logic during the session.

## After the close

1. Fetch the 2026-10-05 1-minute OHLCV into the corpus:

```bash
node scripts/fetchSessionOhlcv.js --day=2026-10-05 --all
```

2. Run the Phase 5 session orchestrator for exactly 2026-10-05:

```bash
node backtest/phase5Session.js --day=2026-10-05 --all
```

3. **Require the full preflight, in this exact order:**

   **A PASS → G PASS → B PASS → C PASS → D PASS → E PASS → F PASS**

   Gate **G is a separate required gate** and must remain **between A and B** — it
   is not shorthand for "A–F". On any failure, stop and report the exact primary
   reason; fix only the infrastructure and rerun. The session is NOT Phase 5A
   evidence until all seven gates pass.

4. Only after preflight PASS, run the accumulated independent validation:

```bash
node backtest/phase5aValidation.js --all
```

Discovery tapes (2026-09-28 … 2026-10-01) are **never** independent evidence.

## Numbers to report

- raw ticks
- captured symbols
- armed
- eligible
- usable tape
- in-window
- baseline fills
- change30 fills
- follow rejections
- missing micro windows — reported separately as `MICRO_NO_DATA`, `TRIGGER_NOT_MET`
  and `FOLLOW_REJECTED` (never silently discarded)
- baseline vs change30 population alignment
- net PF · net R · expectancy · max DD · win % · stop %
- cost sensitivity (framework default 0.05%)
- Phase 5A verdict

## Standing rule

Do not start Phase 6 after one interesting result. Keep collecting independent
sessions until the predefined Phase 5A evidence requirement is satisfied.

Objective: `independent evidence -> hypothesis -> one change -> unseen validation`,
never `one good day -> strategy modification`.
