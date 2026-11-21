import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'src/client/**/*.spec.ts', 'src/client/**/*.spec.tsx'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
