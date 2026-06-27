import { isApiRole, isWorkerRole } from './process-role';

describe('process role helpers', () => {
  describe('isApiRole', () => {
    it('true for api', () => expect(isApiRole('api')).toBe(true));
    it('true for combined', () => expect(isApiRole('combined')).toBe(true));
    it('false for worker', () => expect(isApiRole('worker')).toBe(false));
  });

  describe('isWorkerRole', () => {
    it('true for worker', () => expect(isWorkerRole('worker')).toBe(true));
    it('true for combined', () => expect(isWorkerRole('combined')).toBe(true));
    it('false for api', () => expect(isWorkerRole('api')).toBe(false));
  });
});
