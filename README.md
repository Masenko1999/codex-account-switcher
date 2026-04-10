# codex-account-switcher

CLI nho de quan ly nhieu tai khoan Codex local bang cach luu va chuyen doi `~/.codex/auth.json`.

## Cai dat

```bash
cd /Users/s2nhat51099/Documents/Projects/codex-account-switcher
npm link
```

Sau do dung lenh `ckr`.

## Ho tro he dieu hanh

- `macOS`: da verify va test truc tiep.
- `Linux`: du kien chay duoc vi day la Node.js CLI, nhung chua verify end-to-end.
- `Windows`: chua test, chua xem la ho tro chinh thuc.

## Lenh co san

```bash
ckr add work
ckr add personal
ckr add backup --from /path/to/auth.json
ckr add secondary --login
ckr add secondary --login --device-auth
ckr list
ckr status
ckr use personal
ckr next
ckr mark-exhausted work --reset-at 2026-04-10T00:00:00+07:00
ckr set personal --status ready --remaining 120000 --reset-at 2026-04-10T00:00:00+07:00
ckr exec "hello"
ckr run -- codex exec "hello"
```

## Cach hoat dong

- `ckr add <alias>`: luu snapshot account hien tai tu `~/.codex/auth.json`.
- `ckr add <alias> --from /path/to/auth.json`: import snapshot tu mot file auth khac.
- `ckr add <alias> --login`: logout account hien tai, mo flow `codex login`, sau do luu account moi vao keyring.
- `ckr add <alias> --login --device-auth`: tuong tu tren, nhung buoc login dung `codex login --device-auth`.
- `ckr use <alias>`: copy snapshot da luu ve lai `~/.codex/auth.json`.
- `ckr next`: chuyen sang account tiep theo khong bi danh dau `exhausted`.
- `ckr exec <args...>`: chay `codex exec <args...>` qua wrapper auto-failover.
- `ckr run -- <command...>`: chay command va neu gap loi giong quota/rate-limit thi danh dau account hien tai la `exhausted`, sau do switch sang account tiep theo va chay lai.

## Gioi han

- Tool nay khong dung API chinh thuc de doc so token con lai hoac thoi diem reset.
- `remainingTokens` va `resetAt` hien tai la metadata do ban tu cap nhat, hoac do tool danh dau best-effort khi gap loi quota.
- Auto-switch chi xay ra khi ban chay qua `ckr run -- ...` hoac `ckr exec ...`.
- Mot session Codex desktop/TUI da dang chay se khong tu doi account giua chung. Neu primary het quota trong session do, ban can mo lai session qua account moi.
- Tool luu snapshot auth dang plain JSON trong may local. Quyen file la `0600`, nhung khong ma hoa.

## Du lieu local

- Snapshots: `~/.codex-keyring/accounts/*.auth.json`
- State: `~/.codex-keyring/state.json`

Tat ca file duoc ghi voi quyen `0600`.

## Test an toan

Co the override duong dan mac dinh bang env:

```bash
CODEX_SWITCHER_AUTH_PATH=/tmp/auth.json \
CODEX_SWITCHER_CODEX_BIN=/path/to/mock-codex \
CODEX_SWITCHER_STORE_DIR=/tmp/codex-keyring \
ckr doctor
```
