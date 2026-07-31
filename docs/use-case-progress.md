# HostEye Use Case Progress

This tracker records implementation-level verification. Report 5 is reserved for system and end-to-end flow testing.

| Use case | Status | Verification | Branch / commit |
|---|---|---|---|
| UC-01 - Dashboard overview | Implemented | 6 integration tests passed | `uc/UC-01-dashboard-overview` / `fa95e70` |
| UC-02 - Monitor log collection status | Implemented | 6 UC-02 integration tests passed; full dashboard API suite 12/12 passed | `uc/UC-02-collection-status` |
| UC-03 - Search and filter logs | Implemented | 6 automated tests passed; 1 real ClickHouse Docker integration test passed; full default suite 18 passed / 1 integration skip; desktop/mobile browser QA passed | `uc/UC-03-log-search` |

## UC-02 verified behavior

- Combines enrollment, latest Windows log activity, and HostEyeShipper runtime metrics per endpoint.
- Shows activity levels and collection health, including upload failure, spool backlog, stale, disabled, and no-data states.
- Keeps registered endpoints visible before their first log arrives.
- Exposes Host Inventory, registered agent, jitter, and chunk-monitor API routes used by the dashboard.
- Returns explicit validation, ClickHouse query failure, and ClickHouse outage responses without demo data.

## UC-03 verified behavior

- Searches log content across message, command line, process, raw log, user, DNS, file, registry object, and network-address fields.
- Combines keyword, host, channel, Event ID, and time-range filters; keyword is optional.
- Supports bounded pagination with total count and explicit applied-filter metadata.
- Provides a dedicated Dashboard search page with filter, reset, previous, and next controls.
- Rejects malformed filters and reports ClickHouse query failures or outages without fallback data.
- Passed a real Docker integration flow that inserted temporary ClickHouse rows, queried them through the Dashboard API, and removed the test rows.
- Passed desktop/mobile browser QA; stale search responses cannot overwrite newer filtered results.
