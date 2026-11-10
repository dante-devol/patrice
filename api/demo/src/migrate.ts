import type { PGlite } from '@electric-sql/pglite';

/** Apply the real migrations, given as [name, sql] in order. */
export async function migrate(db: PGlite, migrations: [string, string][]): Promise<void> {
  for (const [name, sql] of migrations) {
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
  }
}
