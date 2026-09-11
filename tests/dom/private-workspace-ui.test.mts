import { describe, expect, it } from 'vitest';
import {
  shouldRenderHostedAuthCtas,
  shouldRenderHostedMarketing,
  shouldRenderHostedFooterLinks,
  shouldRenderCommunityNudge,
  shouldRenderHostedBranding,
} from '@/config/private-workspace';
import { getPanelDisplayTitle, shouldRenderPanelProBadge } from '@/components/Panel';

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

  it('suppresses hosted-product branding in private mode', () => {
    expect(shouldRenderHostedBranding(true)).toBe(false);
    expect(shouldRenderHostedBranding(false)).toBe(true);
  });

  it('drops the panel-header PRO chip and "Premium" title prefix when hosted branding is off', () => {
    const hosted = shouldRenderHostedBranding(false);
    const privateBuild = shouldRenderHostedBranding(true);

    expect(getPanelDisplayTitle('Premium Stock Analysis', hosted)).toBe('Premium Stock Analysis');
    expect(getPanelDisplayTitle('Premium Stock Analysis', privateBuild)).toBe('Stock Analysis');
    expect(getPanelDisplayTitle('Premium Backtesting', privateBuild)).toBe('Backtesting');
    // Only the leading sales prefix goes; ordinary titles are untouched.
    expect(getPanelDisplayTitle('Daily Market Brief', privateBuild)).toBe('Daily Market Brief');
    expect(getPanelDisplayTitle('Premium Times Feed', hosted)).toBe('Premium Times Feed');

    expect(shouldRenderPanelProBadge('locked', privateBuild)).toBe(false);
    expect(shouldRenderPanelProBadge('enhanced', privateBuild)).toBe(false);
    expect(shouldRenderPanelProBadge(true, privateBuild)).toBe(false);
    // Hosted behaviour: a premium panel keeps its chip, a free panel never had one.
    expect(shouldRenderPanelProBadge('locked', hosted)).toBe(true);
    expect(shouldRenderPanelProBadge(undefined, hosted)).toBe(false);
    expect(shouldRenderPanelProBadge(false, hosted)).toBe(false);
  });
});
