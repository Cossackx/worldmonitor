/**
 * Map-pane chrome for the Cesium renderer: zoom buttons, time-range selector,
 * layer picker and legend.
 *
 * Every renderer builds these overlays itself inside #mapContainer
 * (DeckGLMap.createControls/createTimeSlider/createLayerToggles/createLegend,
 * GlobeMap.createControls/createLayerToggles), and MapContainer empties that
 * element on each renderer swap. A renderer that builds no chrome therefore
 * leaves a bare pane, which is exactly what the 2026-09-11 default-layout
 * review frames showed for 3D: no way to change layers, time range or zoom
 * without switching back to 2D.
 *
 * This module reproduces the same markup and class names, so the existing
 * CSS, entitlement presentation, truncation badges, layer search and layer
 * explanations apply unchanged. The adapter owns the state; the chrome only
 * reports user intent and mirrors state back into the DOM.
 */
import { t } from '@/services/i18n';
import { SITE_VARIANT } from '@/config/variant';
import { getAuthState } from '@/services/auth-state';
import { PRIVATE_WORKSPACE_ENABLED, shouldRenderHostedBranding } from '@/config/private-workspace';
import {
  bindLayerSearch,
  getLayerExplanation,
  getLayersForVariant,
  hasCuratedLayerExplanation,
  resolveLayerLabel,
  type MapVariant,
} from '@/config/map-layer-definitions';
import { applyPremiumLayerPresentation, getPremiumLayerPresentation, PremiumLayerGate } from './premium-layer-gate';
import { renderLayerExplanationCard } from '@/utils/layer-explanation-card';
import { renderLayerTruncationBadges } from '@/utils/layer-truncation-badge';
import { showLayerWarning } from '@/utils/layer-warning';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { getCurrentTheme } from '@/utils/theme-manager';
import type { GlobeLayerTruncation } from '@/utils/globe-marker-budget';
import type { MapLayers } from '@/types';
import type { TimeRange } from './MapContainer';

export interface CesiumMapChromeHost {
  container: HTMLElement;
  getLayers(): MapLayers;
  getTimeRange(): TimeRange;
  /** A user toggled a layer row. The host updates its state and re-renders. */
  onLayerToggled(layer: keyof MapLayers, enabled: boolean): void;
  onTimeRangeSelected(range: TimeRange): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
}

const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '48h', '7d', 'all'];
/** Same threshold GlobeMap and DeckGLMap use before warning about clutter. */
const LAYER_WARN_THRESHOLD = 13;
const MARKUP_REASON = 'static map chrome markup; layer labels and icons come from the layer registry';

interface LegendItem { shape: string; label: string; layerKey: keyof MapLayers }

export class CesiumMapChrome {
  private readonly host: CesiumMapChromeHost;
  private readonly controlsEl: HTMLElement;
  private readonly timeSliderEl: HTMLElement;
  private readonly layerTogglesEl: HTMLElement;
  private readonly legendEl: HTMLElement;
  private premiumLayerGate: PremiumLayerGate | null = null;
  private layerWarningShown = false;
  private lastActiveLayerCount = 0;
  private destroyed = false;

  public constructor(host: CesiumMapChromeHost) {
    this.host = host;
    this.controlsEl = this.createControls();
    this.timeSliderEl = this.createTimeSlider();
    this.layerTogglesEl = this.createLayerToggles();
    this.legendEl = this.createLegend();
    this.syncLayers(host.getLayers());
    this.syncTimeRange(host.getTimeRange());
  }

  /** Root of the layer picker, for callers that need to query rows. */
  public getLayerTogglesElement(): HTMLElement { return this.layerTogglesEl; }

  // ─── State mirroring (adapter → DOM) ───────────────────────────────────

  public syncLayers(layers: MapLayers): void {
    if (this.destroyed) return;
    this.layerTogglesEl.querySelectorAll<HTMLElement>('.layer-toggle[data-layer]').forEach((label) => {
      const key = label.dataset.layer as keyof MapLayers | undefined;
      const input = label.querySelector<HTMLInputElement>('input[type=checkbox]');
      if (!key || !input) return;
      input.checked = layers[key] === true;
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-item[data-layer]').forEach((item) => {
      const key = item.dataset.layer as keyof MapLayers | undefined;
      item.style.display = key && layers[key] === true ? '' : 'none';
    });
    const ciiLegend = this.legendEl.querySelector<HTMLElement>('.cii-choropleth-legend');
    if (ciiLegend) ciiLegend.style.display = layers.ciiChoropleth ? 'block' : 'none';
  }

  public syncTimeRange(range: TimeRange): void {
    if (this.destroyed) return;
    this.timeSliderEl.querySelectorAll<HTMLElement>('.time-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === range);
    });
  }

  /** `shown/total` badges beside every layer the marker budget trimmed (#5368). */
  public renderTruncation(truncation: Readonly<Record<string, GlobeLayerTruncation>>): void {
    if (this.destroyed) return;
    renderLayerTruncationBadges(this.layerTogglesEl, truncation, 'rotate');
  }

  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.layerTogglesEl.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    toggle?.closest('.layer-toggle-row')?.remove();
    toggle?.remove();
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerTogglesEl.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('loading', loading);
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerTogglesEl.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('no-data', !hasData);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.premiumLayerGate?.destroy();
    this.premiumLayerGate = null;
    for (const el of [this.controlsEl, this.timeSliderEl, this.layerTogglesEl, this.legendEl]) el.remove();
    this.host.container.querySelector('.layer-explanation-popup')?.remove();
  }

  // ─── Builders ──────────────────────────────────────────────────────────

  private createControls(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'map-controls deckgl-controls';
    setTrustedHtml(el, trustedHtml(`
      <div class="zoom-controls">
        <button type="button" class="map-btn zoom-in"    title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" class="map-btn zoom-out"   title="Zoom out" aria-label="Zoom out">-</button>
        <button type="button" class="map-btn zoom-reset" title="Reset view" aria-label="Reset view">&#8962;</button>
      </div>`, MARKUP_REASON));
    el.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains('zoom-in')) this.host.zoomIn();
      else if (target.classList.contains('zoom-out')) this.host.zoomOut();
      else if (target.classList.contains('zoom-reset')) this.host.resetView();
    });
    this.host.container.appendChild(el);
    return el;
  }

  private createTimeSlider(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'time-slider deckgl-time-slider';
    const buttons = TIME_RANGES.map((range) => {
      const label = range === 'all' ? t('components.deckgl.timeAll') : range;
      return `<button type="button" class="time-btn" data-range="${range}">${escapeHtml(label)}</button>`;
    }).join('');
    setTrustedHtml(el, trustedHtml(`<div class="time-options">${buttons}</div>`, MARKUP_REASON));
    el.querySelectorAll<HTMLElement>('.time-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const range = btn.dataset.range as TimeRange | undefined;
        if (range) this.host.onTimeRangeSelected(range);
      });
    });
    this.host.container.appendChild(el);
    return el;
  }

  private createLayerToggles(): HTMLElement {
    const variant = (SITE_VARIANT || 'full') as MapVariant;
    const authState = getAuthState();
    const layers = getLayersForVariant(variant, 'globe').map((def) => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
      presentation: getPremiumLayerPresentation(def.premium, authState),
    }));
    const current = this.host.getLayers();

    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles';
    setTrustedHtml(el, trustedHtml(`
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button type="button" class="toggle-collapse" aria-label="Collapse layer list">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height:32vh;overflow-y:auto;scrollbar-width:thin;">
        ${layers.map(({ key, label, icon, presentation }) => {
          const explainLabel = escapeHtml(`Explain ${label} layer`);
          const hasExplanation = hasCuratedLayerExplanation(key);
          return `
          <div class="layer-toggle-row" data-layer="${key}">
            <label class="layer-toggle" data-layer="${key}">
              <input type="checkbox" ${current[key] ? 'checked' : ''}>
              <span class="toggle-icon">${icon}</span>
              <span class="toggle-label">${escapeHtml(label)}${presentation.enhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
            </label>
            <button type="button" class="layer-explain-btn${hasExplanation ? ' has-layer-explanation' : ''}" data-layer="${key}" aria-label="${explainLabel}" title="${explainLabel}">i</button>
          </div>`;
        }).join('')}
      </div>`, MARKUP_REASON));

    if (shouldRenderHostedBranding(PRIVATE_WORKSPACE_ENABLED)) {
      const authorBadge = document.createElement('div');
      authorBadge.className = 'map-author-badge';
      authorBadge.textContent = '© Elie Habib · Someone™';
      el.appendChild(authorBadge);
    }
    this.host.container.appendChild(el);

    for (const layer of layers) {
      if (!layer.premium) continue;
      const toggle = el.querySelector<HTMLElement>(`.layer-toggle[data-layer="${layer.key}"]`);
      if (toggle) applyPremiumLayerPresentation(toggle, layer.presentation);
    }

    el.querySelectorAll<HTMLInputElement>('.layer-toggle input').forEach((input) => {
      input.addEventListener('change', () => {
        const layer = input.closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
        if (!layer) return;
        this.host.onLayerToggled(layer, input.checked);
        this.enforceLayerLimit();
      });
    });

    el.querySelectorAll<HTMLElement>('.layer-explain-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const layer = button.getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) this.showLayerExplanation(layer, variant);
      });
    });

    const lockedPremiumLayerKeys = new Set(layers.filter((layer) => layer.presentation.locked).map((layer) => layer.key as string));
    this.premiumLayerGate = lockedPremiumLayerKeys.size > 0
      ? new PremiumLayerGate(el, lockedPremiumLayerKeys, {
          isLayerEnabled: (layer) => this.host.getLayers()[layer as keyof MapLayers] === true,
          onAccessLost: (layer) => this.host.onLayerToggled(layer as keyof MapLayers, false),
        })
      : null;

    bindLayerSearch(el);
    const searchEl = el.querySelector<HTMLElement>('.layer-search');
    const collapseBtn = el.querySelector<HTMLElement>('.toggle-collapse');
    const list = el.querySelector<HTMLElement>('.toggle-list');
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
      if (searchEl) searchEl.style.display = collapsed ? 'none' : '';
      if (collapseBtn) setTrustedHtml(collapseBtn, trustedHtml(collapsed ? '&#9654;' : '&#9660;', MARKUP_REASON));
    });
    // Scrolling the list must not reach the globe's camera controller.
    el.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    this.lastActiveLayerCount = Object.values(current).filter(Boolean).length;
    return el;
  }

  private createLegend(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'map-legend deckgl-legend';
    const isLight = getCurrentTheme() === 'light';
    const shapes = {
      circle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`,
      triangle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 11,10 1,10" fill="${color}"/></svg>`,
      square: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="${color}"/></svg>`,
      hexagon: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="${color}"/></svg>`,
    };
    // Same vocabulary as DeckGLMap's default legend, so 2D and 3D read alike.
    const items: LegendItem[] = [
      { shape: shapes.circle('rgb(255, 68, 68)'), label: t('components.deckgl.legend.highAlert'), layerKey: 'hotspots' },
      { shape: shapes.circle('rgb(255, 165, 0)'), label: t('components.deckgl.legend.elevated'), layerKey: 'hotspots' },
      { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 255, 0)'), label: t('components.deckgl.legend.monitoring'), layerKey: 'hotspots' },
      { shape: shapes.circle('rgb(255, 100, 100)'), label: t('components.deckgl.legend.conflict'), layerKey: 'conflicts' },
      { shape: shapes.triangle('rgb(68, 136, 255)'), label: t('components.deckgl.legend.base'), layerKey: 'bases' },
      { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 220, 0)'), label: t('components.deckgl.legend.nuclear'), layerKey: 'nuclear' },
      { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter'), layerKey: 'datacenters' },
      { shape: shapes.circle('rgb(160, 100, 255)'), label: t('components.deckgl.legend.aircraft'), layerKey: 'flights' },
    ];
    setTrustedHtml(el, trustedHtml(`
      <span class="legend-label-title">${t('components.deckgl.legend.title')}</span>
      ${items.map(({ shape, label, layerKey }) => `<span class="legend-item" data-layer="${layerKey}">${shape}<span class="legend-label">${escapeHtml(label)}</span></span>`).join('')}
      <div class="cii-choropleth-legend" style="display:none">
        <span class="legend-label-title" style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));letter-spacing:0.5px;">CII SCALE</span>
        <div style="display:flex;align-items:center;gap:2px;margin-top:2px;">
          <div style="width:100%;height:8px;border-radius:3px;background:linear-gradient(to right,#28b33e,#dcc030,#e87425,#dc2626,#7f1d1d);"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:calc(8px * var(--wm-panel-effective-scale, 1));opacity:0.7;margin-top:1px;">
          <span>0</span><span>31</span><span>51</span><span>66</span><span>81</span><span>100</span>
        </div>
      </div>`, MARKUP_REASON));
    this.host.container.appendChild(el);
    return el;
  }

  // ─── Behaviour shared with the other renderers ─────────────────────────

  private enforceLayerLimit(): void {
    const activeCount = Array.from(this.layerTogglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input')).filter((i) => i.checked).length;
    const increasing = activeCount > this.lastActiveLayerCount;
    this.lastActiveLayerCount = activeCount;
    if (activeCount >= LAYER_WARN_THRESHOLD && increasing && !this.layerWarningShown) {
      this.layerWarningShown = true;
      showLayerWarning(LAYER_WARN_THRESHOLD);
    } else if (activeCount < LAYER_WARN_THRESHOLD) {
      this.layerWarningShown = false;
    }
  }

  private showLayerExplanation(layer: keyof MapLayers, variant: MapVariant): void {
    const container = this.host.container;
    const existing = container.querySelector<HTMLElement>('.layer-explanation-popup');
    if (existing?.dataset.layer === layer) {
      existing.remove();
      container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
      return;
    }
    existing?.remove();
    container.querySelectorAll('.layer-explain-btn.active').forEach((btn) => btn.classList.remove('active'));

    const def = getLayersForVariant(variant, 'globe').find((item) => item.key === layer);
    const layerLabel = def ? resolveLayerLabel(def, t) : String(layer);
    const popup = document.createElement('div');
    popup.className = 'layer-explanation-popup';
    popup.dataset.layer = layer;
    setTrustedHtml(popup, trustedHtml(renderLayerExplanationCard(layerLabel, getLayerExplanation(layer)), 'static layer explanation metadata'));
    const closePopup = (): void => {
      popup.remove();
      container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
    };
    popup.querySelector('.layer-explanation-close')?.addEventListener('click', closePopup);
    container.appendChild(popup);
    container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.add('active');
  }
}
