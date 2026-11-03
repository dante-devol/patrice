import { Division } from './division';

/** Persistence port for the Division aggregate. Adapters live in infrastructure/. */
export interface DivisionRepository {
  findById(id: string): Promise<Division | null>;
  insert(division: Division): Promise<void>;
  /** Version-guarded: throws `STALE_VERSION` if the row changed since it was loaded. */
  save(division: Division): Promise<void>;
}
