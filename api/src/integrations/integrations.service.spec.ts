import { toConnectionResponse } from './integrations.service';

describe('toConnectionResponse', () => {
  const base = {
    id: 'conn-1',
    organizationId: 'org-1',
    provider: 'discord' as const,
    externalWorkspaceId: '111',
    displayName: 'Test Guild',
    config: { botToken: 'super-secret' },
    credentialsRef: 'aead:ciphertext',
    status: 'active' as const,
    lifecycleState: 'active' as const,
    retiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('strips config', () => {
    const result = toConnectionResponse(base);
    expect('config' in result).toBe(false);
  });

  it('strips credentialsRef', () => {
    const result = toConnectionResponse(base);
    expect('credentialsRef' in result).toBe(false);
  });

  it('preserves all safe fields', () => {
    const result = toConnectionResponse(base);
    expect(result).toMatchObject({
      id: 'conn-1',
      organizationId: 'org-1',
      provider: 'discord',
      externalWorkspaceId: '111',
      displayName: 'Test Guild',
      status: 'active',
      lifecycleState: 'active',
    });
  });

  it('does not leak botToken via any enumerable key', () => {
    const result = toConnectionResponse(base);
    const json = JSON.stringify(result);
    expect(json).not.toContain('botToken');
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain('ciphertext');
  });
});
