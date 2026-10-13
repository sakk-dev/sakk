#!/bin/sh
# 统一测试入口(G08 fixture 自带,禁改):跑真实测试,并把退出码追加到
# runner 注入的机器日志(GOLD_TEST_LOG,workdir 之外)——评分器只认这份日志。
node --test test/*.test.mjs
rc=$?
if [ -n "$GOLD_TEST_LOG" ]; then
  printf '{"ts":"%s","exit":%d}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >> "$GOLD_TEST_LOG"
fi
exit $rc
