# Handoff: Roxy Auto Refresh

## Context

The recent implementation work is captured in local commit `0be5dc1 feat: optimize auto refresh`.
That commit adds `bun cli refresh --auto` and `bun cli refresh --auto --dryRun` for RoxyBrowser-assisted Codex token refresh.

The user asked for the handoff to be saved in this repository, then committed and pushed.

## Current State

- Working tree was clean before this handoff file was added.
- Branch: `main`
- Local branch was ahead of `origin/main` by one commit before this handoff file.
- Core implementation files are:
  - `src/refresh-auto.ts`
  - `src/commands.ts`
  - `src/codex.ts`
  - `src/main.ts`
  - `src/paths.ts`
  - `tests/commands.test.ts`
  - `README.md`
  - `AGENTS.md`

## Behavior Implemented

- `bun cli refresh` keeps the original manual flow.
- `bun cli refresh --auto` only targets accounts with invalid tokens.
- `bun cli refresh --auto --dryRun` skips invalid-token filtering and lets the user select any account for preflight validation.
- Dry run does not start the Codex login server, does not open OpenAI auth URLs, and does not replace tokens.
- Auto refresh preflight checks:
  - Roxy window exists, using exact `windowName`.
  - ClashVerge/Mihomo mode is `global`.
  - RoxyBrowser profile detail reports the expected proxy country via `proxyInfo.lastCountry`.
- Full auto refresh starts Codex login only after preflight passes.
- Browser automation uses CDP mouse events with movement/jitter instead of DOM `click()`.
- The Codex callback server remains alive briefly after `auth.json` appears so the success page can finish loading.

## Real Environment Findings

- Roxy API is available at `http://127.0.0.1:50000`.
- The Roxy token in the user's local config is sensitive and must not be copied into notes, issues, or commits.
- ClashVerge's visible system proxy port was `127.0.0.1:7897`; that is not the REST controller port.
- ClashVerge Rev's TCP external controller was disabled in the user's environment.
- The available controller is the Unix socket:
  - `/tmp/verge/verge-mihomo.sock`
- The code now tries that socket by default before common TCP controller ports.
- Roxy workspace display IDs like `OEB0107476` are not accepted directly by Roxy API endpoints. The code normalizes that display form to the numeric API workspace id.
- Roxy `list_v3` does not include proxy country. The code now calls `/browser/detail` after `list_v3` and reads `proxyInfo.lastCountry`.

## Verified

- `bun run typecheck` passes.
- `bun test tests/commands.test.ts` passes with 48 tests.
- Real dry run for the target account passed after fixes:
  - Clash mode detected as global.
  - Roxy proxy country detected as US.
  - Dry run completed without opening OpenAI auth.

## Local Config Shape

The expected config lives at:

`~/.codex-account/refresh-auto.json`

Do not commit this file. It contains a Roxy API token.

Example with sensitive values omitted:

```json
{
  "version": 1,
  "roxy": {
    "apiBaseUrl": "http://127.0.0.1:50000",
    "token": "REDACTED",
    "workspaceId": "OEB0107476"
  },
  "proxyCheck": {
    "global": {
      "country": "US"
    },
    "accounts": {
      "REDACTED_ACCOUNT": {
        "country": "US",
        "roxyWindowName": "REDACTED_ACCOUNT"
      }
    }
  }
}
```

## Remaining Work

- Run full `bun cli refresh --auto` once the user is ready and an invalid-token account is available.
- Watch for Google/OpenAI manual-intervention pages. The implementation should stop on password, 2FA, CAPTCHA, recovery prompts, or risk checks.
- If Roxy API changes field names, inspect `/browser/detail` and update the country extraction list in `src/refresh-auto.ts`.
- Consider adding narrower unit coverage for `refresh-auto.ts` once the local API contract stabilizes.

## Suggested Skills

- `code-review`: review the current branch before or after pushing.
- `tdd`: add focused tests around config parsing, workspace id normalization, and preflight decisions.
- `browser:control-in-app-browser`: only if local Web UI verification is needed.
- `handoff`: regenerate this file if another long debugging session changes the flow materially.
