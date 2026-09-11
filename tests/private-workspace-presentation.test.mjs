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
