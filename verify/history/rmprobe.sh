#!/bin/bash
#逐个删除残留的探针临时目录（先删文件，再自底向上 rmdir 空目录）
cd "$(dirname "$0")" || exit 1
for name in "$@"; do
  [ -d "$name" ] || continue
  find "$name" -type f -delete 2>/dev/null
  # 自底向上逐层 rmdir 空目录，失败则忽略
  for (( i=0; i<12; i++ )); do
    changed=0
    while read -r d; do
      [ -n "$d" ] || continue
      rmdir "$d" 2>/dev/null && changed=1
    done < <(find "$name" -depth -type d 2>/dev/null)
    [ "$changed" -eq 0 ] && break
  done
  echo "$name: $([ -d "$name" ] && echo STILL_THERE || echo GONE)"
done
