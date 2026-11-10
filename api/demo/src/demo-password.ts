import { Injectable } from '@nestjs/common';
import { argon2Verify, argon2id } from 'hash-wasm';

/**
 * Demo stand-in for PasswordService: argon2id in WebAssembly (hash-wasm) instead of
 * the native `argon2` addon. Same PHC string format, so hashes made by the real
 * service (e.g. in the pre-seeded snapshot) verify here and vice versa.
 */
@Injectable()
export class DemoPasswordService {
  async hash(plain: string): Promise<string> {
    const salt = new Uint8Array(16);
    globalThis.crypto.getRandomValues(salt);
    return argon2id({
      password: plain,
      salt,
      iterations: 3,
      memorySize: 19456,
      parallelism: 1,
      hashLength: 32,
      outputType: 'encoded',
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2Verify({ password: plain, hash });
    } catch {
      return false;
    }
  }
}
