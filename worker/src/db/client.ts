/** Drizzle client bound to the request's D1 binding. */
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.ts';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof getDb>;

/** Builds a typed Drizzle client over the worker's D1 database. */
export function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}
