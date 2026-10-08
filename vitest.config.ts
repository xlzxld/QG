import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: 'node',
    // 旧抢购平台（r8 全自动平台）的代码与测试已归档到「归档_旧抢购平台_2026-10-08/」。
    // 归档目录不参与测试扫描；现行系统只跑 tests/intercept（拦截改写规则）。
    // 需要跑归档测试时：先按归档说明把文件挪回原位，再执行 npm test。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/归档_*/**',
    ],
  },
});
