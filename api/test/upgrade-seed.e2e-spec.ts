import { PrismaClient, ScopeKind } from '@prisma/client';
import { BootedApp, bootApp, createEmailCapture, resetDatabase } from './helpers';

/**
 * Upgrading an install that has the org-wide Member role (ADR 0022): its grants are
 * translated into Everyone and a new Member unit role, every division and team takes
 * Member as its default, every current member holds it there, and the old role retires
 * with no holders.
 */
describe('Upgrade seeding', () => {
  let booted: BootedApp;
  let prisma: PrismaClient;
  let oldMemberId: string;
  let userId: string;
  let divisionId: string;

  beforeAll(async () => {
    await resetDatabase();
    prisma = new PrismaClient();
    const old = await prisma.role.create({ data: { name: 'Member' } });
    oldMemberId = old.id;
    await prisma.grant.createMany({
      data: [
        { roleId: old.id, action: 'user:read', scopeKind: 'global' },
        { roleId: old.id, action: 'task:read', scopeKind: 'own' },
        { roleId: old.id, action: 'task:read', scopeKind: 'own_division' },
        { roleId: old.id, action: 'task:assign', scopeKind: 'own_division' },
        { roleId: old.id, action: 'task:assign', scopeKind: 'own_team' },
        { roleId: old.id, action: 'message:update', scopeKind: 'own' },
        { roleId: old.id, action: 'invite:create', scopeKind: 'global' },
      ].map((g) => ({ ...g, scopeKind: g.scopeKind as ScopeKind, effect: 'permit' as const })),
    });
    await prisma.systemSettings.upsert({
      where: { id: 1 },
      create: { id: 1, memberRoleId: old.id, memberRoleSeeded: true },
      update: { memberRoleId: old.id, memberRoleSeeded: true, memberUnitSeeded: false },
    });
    userId = (await prisma.appUser.create({ data: { email: 'old@example.com', displayName: 'Old hand' } })).id;
    await prisma.userRole.create({ data: { userId, roleId: old.id } });
    divisionId = (await prisma.division.create({ data: { name: 'Writing' } })).id;
    await prisma.membership.create({ data: { userId, divisionId } });
    booted = await bootApp({ emailStub: createEmailCapture().stub });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await booted?.app.close();
  });

  it('retires the org-wide Member with no holders, freeing its name', async () => {
    const old = await prisma.role.findUniqueOrThrow({ where: { id: oldMemberId } });
    expect(old.lifecycleState).toBe('retired');
    expect(old.name).toBe('Member (before unit roles)');
    expect(await prisma.userRole.count({ where: { roleId: oldMemberId } })).toBe(0);
  });

  it('translates its grants into the Member unit role', async () => {
    const settings = await prisma.systemSettings.findFirstOrThrow();
    expect(settings.memberRoleId).toBeNull();
    expect(settings.memberUnitSeeded).toBe(true);
    const member = await prisma.role.findUniqueOrThrow({ where: { id: settings.defaultUnitRoleId! }, include: { grants: true } });
    expect(member).toMatchObject({ name: 'Member', kind: 'unit', assignableByLeads: true });
    expect(member.grants.map((g) => `${g.action}@${g.scopeKind}`).sort()).toEqual([
      'message:update@own',
      'task:assign@assigned',
      'task:read@assigned',
    ]);
  });

  it('seeds Everyone with the reads, and leaves governance behind', async () => {
    const everyone = await prisma.role.findFirstOrThrow({ where: { kind: 'baseline' }, include: { grants: true } });
    expect(everyone.name).toBe('Everyone');
    const grants = everyone.grants.map((g) => `${g.action}@${g.scopeKind}`);
    expect(grants).toEqual(expect.arrayContaining(['user:read@global', 'task:read@own']));
    expect(grants.some((g) => g.startsWith('invite:'))).toBe(false);
  });

  it('makes Member every unit’s default and gives it to current members', async () => {
    const memberId = (await prisma.systemSettings.findFirstOrThrow()).defaultUnitRoleId!;
    expect((await prisma.division.findUniqueOrThrow({ where: { id: divisionId } })).defaultRoleId).toBe(memberId);
    const held = await prisma.unitRoleAssignment.findMany({ where: { userId, roleId: memberId } });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ divisionId, viaDefault: true });
  });
});
