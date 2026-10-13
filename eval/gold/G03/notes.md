# G03 gold

判据:BASELINE 两断言逐字在场+新增 '' 与 '12.5' 用例+测试绿。

M1A.1:新增隐藏覆盖判据——gold/mutants/{empty,decimal,whitespace}.mjs 三个变异体
逐个换进工作副本,Agent 的测试套必须每次都变红;变异体保证 BASELINE 两断言仍绿,
所以只有真正覆盖对应边界的新测试才能击杀。' 7 '(带空白)由 whitespace 变异体机器验证。
