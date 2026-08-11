import { Prisma } from '@prisma/client';
import { generateMemberId, withMemberId } from '../../src/utils/member-id';

const uniqueViolation = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target },
  });

describe('member id generation', () => {
  it('uses the ZCN- prefix and an unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const id = generateMemberId();
      expect(id).toMatch(/^ZCN-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      // 0/O and 1/I/L are excluded because member IDs get read aloud.
      expect(id.slice(4)).not.toMatch(/[01OIL]/);
    }
  });

  it('does not bias toward the start of the alphabet', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) for (const c of generateMemberId().slice(4)) counts[c] = (counts[c] || 0) + 1;
    const vals = Object.values(counts);
    const expected = 120000 / 31;
    expect((Math.max(...vals) - Math.min(...vals)) / expected).toBeLessThan(0.15);
  });
});

describe('collision handling', () => {
  it('retries with a fresh id when member_id collides', async () => {
    let attempts = 0;
    const result = await withMemberId(async (memberId) => {
      attempts++;
      if (attempts < 3) throw uniqueViolation(['member_id']);
      return memberId;
    });
    expect(attempts).toBe(3);
    expect(result).toMatch(/^ZCN-/);
  });

  it('does NOT retry a duplicate email — that must surface as a conflict', async () => {
    let attempts = 0;
    await expect(
      withMemberId(async () => { attempts++; throw uniqueViolation(['email']); }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(attempts).toBe(1);
  });

  it('gives up after the retry budget rather than looping forever', async () => {
    let attempts = 0;
    await expect(
      withMemberId(async () => { attempts++; throw uniqueViolation(['member_id']); }, 4),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(attempts).toBe(4);
  });
});
