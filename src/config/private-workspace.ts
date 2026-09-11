/**
 * Build-time presentation mode for privately hosted workspaces.
 *
 * This only controls hosted marketing surfaces. Authentication, entitlement
 * checks, and premium feature gates remain unchanged elsewhere.
 */
export const PRIVATE_WORKSPACE_ENABLED = (() => {
  try {
    return import.meta.env.VITE_PRIVATE_WORKSPACE === '1';
  } catch {
    return false;
  }
})();

/** Return whether a hosted marketing surface may be rendered. */
export function shouldRenderHostedMarketing(privateWorkspaceEnabled: boolean): boolean {
  return !privateWorkspaceEnabled;
}

/** Pricing and hosted-account acquisition links are omitted in private mode. */
export function shouldRenderHostedFooterLinks(privateWorkspaceEnabled: boolean): boolean {
  return shouldRenderHostedMarketing(privateWorkspaceEnabled);
}

/** The unsolicited hosted Discord community nudge is omitted in private mode. */
export function shouldRenderCommunityNudge(privateWorkspaceEnabled: boolean): boolean {
  return shouldRenderHostedMarketing(privateWorkspaceEnabled);
}

/**
 * Hosted-product branding is omitted in private mode: the author handle and
 * X/GitHub credit links, the version badge, the footer brand block, and the
 * Blog/Status/GitHub/X/Download links. The dashboard title, the reference
 * links (Countries, Chokepoints, …), the Docs link and the copyright notice
 * stay: the first two are navigation, the last is attribution we keep under
 * the accepted AGPL reuse.
 */
export function shouldRenderHostedBranding(privateWorkspaceEnabled: boolean): boolean {
  return shouldRenderHostedMarketing(privateWorkspaceEnabled);
}

/** Signed-in users retain their account control; signed-out hosted CTAs do not. */
export function shouldRenderHostedAuthCtas(
  privateWorkspaceEnabled: boolean,
  signedIn: boolean,
): boolean {
  return signedIn || !privateWorkspaceEnabled;
}
