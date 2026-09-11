import type { GlobeMap } from './GlobeMap';
import type { CesiumMapAdapter } from './CesiumMapAdapter';

/**
 * GlobeMap methods that MapContainer may call but the bounded Cesium adapter
 * cannot implement yet. They are deliberately listed here rather than being
 * synthesized for every missing property: an unknown property must retain
 * normal JavaScript semantics (especially `then`, which must not be callable).
 *
 * These methods are compatibility no-ops because their callers also cache the
 * data and the Cesium spike explicitly does not render those layers/features.
 */
const COMPATIBILITY_NO_OPS = new Set([
  'setHappinessScores',
  'setSpeciesRecoveryZones',
  'setRenewableInstallations',
  'setOnTimeRangeChange',
  'setOnCountry',
  'setOnLayerChange',
  'setOnMapContextMenu',
  'setOnHotspotClicked',
  'onTimeRangeChanged',
  'onStateChanged',
  'hideLayerToggle',
  'flashAssets',
  'triggerHotspotClick',
  'triggerBaseClick',
  'triggerPipelineClick',
  'triggerCableClick',
  'triggerDatacenterClick',
  'triggerNuclearClick',
  'triggerIrradiatorClick',
  'updateHotspotActivity',
  'updateMilitaryForEscalation',
  'highlightAssets',
  'setHotspotLevels',
  'initEscalationGetters',
  'setPositiveEvents',
  'setKindnessData',
]);

const COMPATIBILITY_VALUES: Record<string, () => unknown> = {
  // MapContainer treats this as an optional viewport query. Cesium has no
  // country-bounds source in this spike, so null is the honest answer.
  getBbox: () => null,
};

/**
 * Adapt the intentionally small Cesium surface to the existing GlobeMap
 * boundary. Adapter methods are bound so destructuring/callback use preserves
 * their receiver; only explicitly named compatibility members are supplied.
 */
export function createCesiumMapBridge(adapter: CesiumMapAdapter): GlobeMap {
  return new Proxy(adapter as unknown as GlobeMap, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return typeof value === 'function' ? value.bind(target) : value;
      if (typeof property !== 'string') return undefined;
      const compatibilityValue = COMPATIBILITY_VALUES[property];
      if (compatibilityValue) return compatibilityValue;
      if (COMPATIBILITY_NO_OPS.has(property)) return () => undefined;
      return undefined;
    },
  });
}
