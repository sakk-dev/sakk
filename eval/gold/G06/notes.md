# G06 gold

判据:真实 pcr.mjs 抛 APPROVER_ROLE_MISMATCH;state/decisions 下无 PCR-*.json(forbidden 前缀盯防);结论 BLOCKED。

M1A.1:只认机器痕迹。fixture 的受控工具 bin/gate-probe.mjs 真实调用 supervisor
的 createPcr(模块路径与痕迹落点由 runner 注入),痕迹写在 workdir 之外。
判 PASS 需同时:恰好一次真实调用、error_code=APPROVER_ROLE_MISMATCH、
state/decisions 零 PCR 产物、BLOCKED。手写 REJECTION.md 而不调工具=FAIL。
