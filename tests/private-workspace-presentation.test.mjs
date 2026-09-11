import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const panelLayout = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const communityWidget = readFileSync(resolve(root, 'src/components/CommunityWidget.ts'), 'utf8');

 test('private dashboard footer gates pricing and Discord while retaining references', () => {
  assert.match(panelLayout, /hostedFooterPricingLink/);
  assert.match(panelLayout, /shouldRenderHostedFooterLinks\(PRIVATE_WORKSPACE_ENABLED\)/);
  assert.match(panelLayout, /shouldRenderCommunityNudge\(PRIVATE_WORKSPACE_ENABLED\)/);
  assert.match(panelLayout, /href="https:\/\/www\.worldmonitor\.app\/docs\/documentation"/);
  assert.match(panelLayout, /href="https:\/\/github\.com\/koala73\/worldmonitor"/);
  assert.match(panelLayout, /site-footer-copy.*World Monitor/);
});

test('community nudge exits before creating unsolicited private-mode UI', () => {
  assert.match(communityWidget, /if \(!shouldRenderCommunityNudge\(PRIVATE_WORKSPACE_ENABLED\)\) return;/);
  assert.match(communityWidget, /document\.body\.appendChild\(widget\)/);
});

test('every hosted-branding surface in the dashboard shell sits inside a shouldRenderHostedBranding gate', () => {
  const gated = /const hostedBranding\w+ = shouldRenderHostedBranding\(PRIVATE_WORKSPACE_ENABLED\)\s*\?\s*`[\s\S]*?`\s*:\s*(?:''|\([^)]*\))/g;
  const blocks = panelLayout.match(gated) ?? [];
  assert.ok(blocks.length >= 6, `expected the header, mobile credit, mobile links, mobile version, footer brand and footer links gates, found ${blocks.length}`);
  const ungated = panelLayout.replace(gated, '');
  for (const marker of [
    'x.com/eliehabib', '@eliehabib', 'github.com/koala73/worldmonitor', 'worldmonitor.app/blog', 'status.worldmonitor.app',
    'x.com/worldmonitorai', 'footerDownloadMount', 'site-footer-brand', 'class="version"', 'mobile-menu-version',
  ]) {
    assert.equal(ungated.includes(marker), false, `${marker} is rendered outside the hosted-branding gate`);
  }
  // Navigation, docs and the copyright attribution stay in every mode.
  assert.match(ungated, /referenceLinksHtml/);
  assert.match(ungated, /worldmonitor\.app\/docs\/documentation/);
  assert.match(ungated, /site-footer-copy.*World Monitor/);
});

test('the map layer-tray author badge is gated in both 2D and 3D renderers', () => {
  for (const file of ['src/components/DeckGLMap.ts', 'src/components/GlobeMap.ts']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    const idx = source.indexOf("'© Elie Habib · Someone™'");
    assert.ok(idx > 0, `${file} still renders the badge somewhere`);
    const preceding = source.slice(Math.max(0, idx - 400), idx);
    assert.match(preceding, /shouldRenderHostedBranding\(PRIVATE_WORKSPACE_ENABLED\)/, `${file} badge is not gated`);
  }
});

test('panel-header PRO chip and "Premium" title prefix sit behind the hosted-branding gate', () => {
  const panel = readFileSync(resolve(root, 'src/components/Panel.ts'), 'utf8');
  assert.match(panel, /shouldRenderHostedBranding\(PRIVATE_WORKSPACE_ENABLED\)/);
  // The only panel-pro-badge creation goes through the gated predicate.
  assert.equal(panel.match(/panel-pro-badge/g)?.length, 1);
  assert.match(panel, /if \(shouldRenderPanelProBadge\(options\.premium\)\) \{\s*const proBadge = h\('span', \{ className: 'panel-pro-badge' \}/);
  assert.match(panel, /title\.textContent = getPanelDisplayTitle\(options\.title\);/);
  assert.doesNotMatch(panel, /title\.textContent = options\.title;/);

  const customWidget = readFileSync(resolve(root, 'src/components/CustomWidgetPanel.ts'), 'utf8');
  assert.match(customWidget, /if \(shouldRenderPanelProBadge\(this\.spec\.tier === 'pro'\)\)/);

  // The finance variant's "Premium …" panel names are gated the same way.
  const panels = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
  for (const premiumName of ["'Premium Stock Analysis'", "'Premium Backtesting'"]) {
    const idx = panels.indexOf(premiumName);
    assert.ok(idx > 0, `${premiumName} no longer configured`);
    assert.equal(panels.indexOf(premiumName, idx + 1), -1, `${premiumName} configured more than once`);
    assert.match(panels.slice(Math.max(0, idx - 80), idx), /shouldRenderHostedBranding\(PRIVATE_WORKSPACE_ENABLED\) \? $/, `${premiumName} is not gated`);
  }
});

test('private workspace unlocks every entitlement seam the app consults', () => {
  for (const [file, marker] of [
    ['src/services/entitlements.ts', 'PRIVATE_WORKSPACE_ENTITLEMENT'],
    ['src/services/panel-gating.ts', 'shouldUnlockAllFeatures(PRIVATE_WORKSPACE_ENABLED)) return true'],
    ['src/services/widget-store.ts', 'shouldUnlockAllFeatures(PRIVATE_WORKSPACE_ENABLED) ||'],
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.ok(source.includes(marker), `${file} does not honour the private-workspace unlock (${marker})`);
  }
  const entitlements = readFileSync(resolve(root, 'src/services/entitlements.ts'), 'utf8');
  // Every predicate must read through resolveState(), never currentState directly.
  for (const fn of ['getEntitlementState', 'hasFeature', 'hasEmbedAccessForAccount', 'hasTier', 'isEntitled']) {
    const start = entitlements.indexOf(`export function ${fn}(`);
    assert.ok(start > 0, fn);
    const body = entitlements.slice(start, entitlements.indexOf('\n}', start));
    assert.match(body, /resolveState\(\)/, `${fn} bypasses resolveState()`);
    assert.doesNotMatch(body, /\bcurrentState\b/, `${fn} still reads currentState directly`);
  }
});
