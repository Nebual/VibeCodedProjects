import { defineConfig } from 'drizzle-kit'

const dataDir = process.env.DATA_DIR || '.data'

export default defineConfig({
  schema: './server/database/schema.ts',
  out: './server/database/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: `${dataDir}/songtrack.db`,
  },
})
