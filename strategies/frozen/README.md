# strategies/frozen/ — the frozen engines, byte-compared

## MAIN CODE

| file | what it is |
|---|---|
| `orderFlow.of03v1.js` | the frozen snapshot of ENGINE 3 (`strategies/orderFlow.js`), OF03 v1 only — OF01 and OF02 removed 2026-10-15 |

<!-- dir-doc dir=strategies/frozen files=2 strategies=0 frozen=1 -->

## How many strategies, and how much each gives

**In this directory: 0 strategies of its own — 1 frozen copy of one.** A frozen artifact cannot have its own performance: it is the same rules, hash-pinned, so that a test can prove the version under the name OF03 v1 has not quietly changed (OF01 and OF02 were removed on 2026-10-15).

| artifact | how much it gives | evidence |
|---|---|---|
| frozen ENGINE 3 snapshot | whatever `strategies/orderFlow.js` gives; the snapshot is compared byte-for-byte against it | `test/researchGuard.test.js` |

Renaming or moving a frozen artifact changes its recorded hash, which is the one thing Gate F exists to notice. That is why the pinned paths stay put when everything else is grouped.
