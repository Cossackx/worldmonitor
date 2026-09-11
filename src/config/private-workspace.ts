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

/** Signed-in users retain their account control; signed-out hosted CTAs do not. */
export function shouldRenderHostedAuthCtas(
  privateWorkspaceEnabled: boolean,
  signedIn: boolean,
): boolean {
  return signedIn || !privateWorkspaceEnabled;
}
