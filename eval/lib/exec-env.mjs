/**
 * 子进程环境清洗:外层 node --test 注入的 NODE_TEST_CONTEXT 会让子级
 * `node --test` 在测试失败时仍 exit 0(实测坐实)——对以退出码为唯一真相的
 * 评分器/runner 是一条假绿通道,所有 spawn 必须经这里统一剥离。
 * (独立成模块:runner 与 scorer 都要用,scorer 不能反向 import runner。)
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
