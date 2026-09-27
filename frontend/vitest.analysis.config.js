// Analysis runs (frontend/analysis/): decision-support studies on the real
// data, e.g. the allocator sensitivity sweep. Kept out of `npm test` because
// they launch the Python solver many times. Reports: analysis/reports/.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['analysis/**/*.analysis.js'],
    testTimeout: 600_000,
    fileParallelism: false,
  },
})
