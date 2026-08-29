#!/bin/bash
# Loop 6 IM smoke launcher. Credentials are NEVER hardcoded here — put them
# in a local gitignored file `scripts/.im-env` (KEY=VALUE lines):
#   TELEGRAM_BOT_TOKEN=...
#   FEISHU_APP_ID=...
#   FEISHU_APP_SECRET=...
cd "$(dirname "$0")/.." || exit 1
if [ ! -f scripts/.im-env ]; then
  echo "missing scripts/.im-env — create it with your channel credentials (gitignored)"
  exit 1
fi
set -a
. scripts/.im-env
set +a
npx tsx scripts/smoke-loop6-im.mts
