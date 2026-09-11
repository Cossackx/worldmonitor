import { describe, expect, it } from 'vitest';
import {
  shouldRenderHostedAuthCtas,
  shouldRenderHostedMarketing,
  shouldRenderHostedFooterLinks,
  shouldRenderCommunityNudge,
} from '@/config/private-workspace';

describe('private workspace presentation policy', () => {
  it('suppresses hosted marketing without changing entitlement policy', () => {
    expect(shouldRenderHostedMarketing(true)).toBe(false);
    expect(shouldRenderHostedMarketing(false)).toBe(true);
    expect(shouldRenderHostedAuthCtas(true, false)).toBe(false);
    expect(shouldRenderHostedAuthCtas(true, true)).toBe(true);
  });

  it('suppresses only unsolicited hosted footer and community acquisition surfaces', () => {
    expect(shouldRenderHostedFooterLinks(true)).toBe(false);
    expect(shouldRenderHostedFooterLinks(false)).toBe(true);
    expect(shouldRenderCommunityNudge(true)).toBe(false);
    expect(shouldRenderCommunityNudge(false)).toBe(true);
  });
});
