import { PrismaClient } from '@prisma/client';
import { BootedApp, bootApp, createEmailCapture, resetDatabase } from './helpers';

/**
 * Upgrading an install that predates the seeded Member role: reads used to need no
 * grant, so everyone already there must get Member, and a role already called
 * "Member" is adopted rather than duplicated (found in the cutover rehearsal).
 */
describe('Upgrade seeding', () => {
  let booted: BootedApp;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDatabase();
    prisma = new PrismaClient();
    await prisma.appUser.create({ data: { email: 'old@example.com', displayName: 'Old hand' } });
    await prisma.role.create({ data: { name: 'member' } });
    booted = await bootApp({ emailStub: createEmailCapture().stub });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await booted?.app.close();
  });

  it('adopts the existing Member role, tops up its grants, and gives it to existing users', async () => {
    const members = await prisma.role.findMany({ where: { name: { equals: 'member', mode: 'insensitive' } } });
    expect(members).toHaveLength(1);
    const settings = await prisma.systemSettings.findFirstOrThrow();
    expect(settings.memberRoleId).toBe(members[0].id);
    expect(await prisma.grant.count({ where: { roleId: members[0].id, action: 'task:read' } })).toBe(1);
    const old = await prisma.appUser.findFirstOrThrow({ where: { email: 'old@example.com' } });
    expect(await prisma.userRole.count({ where: { userId: old.id, roleId: members[0].id } })).toBe(1);
  });
});
