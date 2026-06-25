/**
 * SecretCipherPort — the seam for custodying per-connection provider secrets.
 *
 * `credentials_ref` holds a cipher-tagged handle the port resolves:
 *   aead:<base64>   — inline AES-256-GCM (self-host default, INTEGRATION_TOKEN_KEY)
 *   vault:<path>    — HashiCorp Vault transit (Slice H)
 *   kms:<id>:<wrap> — KMS envelope (Slice H)
 *
 * Decryption happens only in the worker role; the api role holds neither
 * token nor key (ADR 0004).
 */
export interface SecretCipherPort {
  /** Encrypt plaintext and return a cipher-tagged handle. */
  encrypt(plaintext: string): Promise<string>;

  /** Resolve a cipher-tagged handle to plaintext. */
  decrypt(ref: string): Promise<string>;

  /** True when this adapter can service the given ref tag. */
  canHandle(ref: string): boolean;
}

export const SECRET_CIPHER_PORT = Symbol('SECRET_CIPHER_PORT');
