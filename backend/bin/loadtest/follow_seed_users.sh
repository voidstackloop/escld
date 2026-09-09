#!/bin/bash
set -euo pipefail
TOKEN=$(cat /tmp/access_token.txt)
for u in seed_user_10 seed_user_102 seed_user_103 seed_user_104 seed_user_1000 \
         seed_user_20 seed_user_30 seed_user_40 seed_user_50 seed_user_60 \
         seed_user_70 seed_user_80 seed_user_90 seed_user_200 seed_user_300 \
         seed_user_400 seed_user_500 seed_user_600 seed_user_700 seed_user_800 \
         seed_user_900 seed_user_1500 seed_user_2000 seed_user_2500 seed_user_3000; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/users/${u}/follow")
  echo "$u -> $code"
done
