import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit generates SQL migrations from src/db/schema.ts into ./migrations.
 * `wrangler d1 migrations apply servercase` then applies those .sql files to
 * D1 (drizzle-kit generates; wrangler is the migration runner).
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
});
