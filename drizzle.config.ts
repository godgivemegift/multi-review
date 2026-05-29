import type { Config } from 'drizzle-kit'

export default {
  schema: './core/db/schema.ts',
  out: './core/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_PATH || './data/cockpit.db',
  },
} satisfies Config
