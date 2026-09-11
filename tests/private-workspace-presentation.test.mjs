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
