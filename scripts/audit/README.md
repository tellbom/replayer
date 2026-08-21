# Network audit scripts

These entry points use Node only. They do not require `jq`, `grep`, Bash, or PowerShell and run on Windows, macOS, and Linux.

## Commands

- `npm run audit:network` runs the T-85 recorder, analyzer, network outcome, fallback, direct-disconnect, channel-distribution, and cross-parameter gates. Its final table is ready to paste into an audit report.
- `npm run audit:channels` reads every `skills/*.yaml` file and prints the exact `network`, `ui`, `merged`, and `auto` step counts plus one JSON line.
- `npm run audit:dependency` records `workday`, analyzes that recording, replays the direct draft as `weekend`, and verifies the stored server value. A successful HTTP response without the `weekend` postcondition is a failure.

## Interpretation

- `network capture` must report `fallback=0`; JSON responses without a cached `content-type` still count as `structured`, while a truly empty body is `none`.
- `direct disconnect` must report `status=null`, `outcome_unknown`, and `delta=1`.
- `fallback policy` proves `not_sent` is the only automatic UI-fallback state and an uncertain write is not resubmitted.
- Any failed phase makes the command exit nonzero. The runner continues through the remaining phases so one invocation produces a complete audit table.
