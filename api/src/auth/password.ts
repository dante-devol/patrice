import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ENV, Env } from '../config/env';

/**
 * Password hashing with argon2id. Cost parameters are tunable via env (ARGON2_*);
 * defaults follow argon2's recommended interactive settings.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options;

  constructor(@Inject(ENV) env: Env) {
    this.options = {
      type: argon2.argon2id,
      ...(env.ARGON2_MEMORY_COST ? { memoryCost: env.ARGON2_MEMORY_COST } : {}),
      ...(env.ARGON2_TIME_COST ? { timeCost: env.ARGON2_TIME_COST } : {}),
      ...(env.ARGON2_PARALLELISM ? { parallelism: env.ARGON2_PARALLELISM } : {}),
    };
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
