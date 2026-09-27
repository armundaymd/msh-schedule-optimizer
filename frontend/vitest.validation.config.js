// Validation suite (frontend/validation/): synthetic scenarios run through the
// schedule generator and the resource allocator (real OR-Tools solver via
// `python -m staffing`), plus the current-vs-generated comparison. Kept out
// of `npm test` because it launches Python. Reports: validation/reports/.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['validation/**/*.validation.js'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
