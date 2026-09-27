/**
 * Where the published privacy policy lives.
 *
 * Google Play requires a link to it on the store listing **and inside the app**, whether or not the
 * app collects anything. This is a source constant rather than build configuration on purpose: an
 * environment variable can be forgotten, and a build that shipped without this link would be in
 * breach of the policy it exists to satisfy. There is nothing secret in a public URL.
 *
 * It is offered on the About page, which the locked calculator's own menu reaches
 * (`CalculatorScreen`), so someone who never types the PIN -- a Play reviewer, for instance -- can
 * still find it. Behind the PIN it would be effectively absent.
 *
 * The page is served from a repository of its own rather than the app's, which is private and would
 * have had to be made public to host it -- publishing the vault's source and its threat model along
 * with the policy.
 */
import { Linking } from 'react-native';

export const PRIVACY_POLICY_URL = 'https://krueger100.github.io/silentsum-privacy/';

/**
 * The section of that page describing how to delete an account and its data, which Play requires
 * to be reachable without installing the app.
 */
export const DATA_DELETION_URL = `${PRIVACY_POLICY_URL}#delete`;

/** What the row says. Named the way a calculator would name it: plainly, and about nothing else. */
export const PRIVACY_POLICY_LABEL = 'Privacy policy';

/**
 * Hands a URL to the system browser. Resolves false when nothing could take it, so a screen can say
 * so instead of appearing to do nothing.
 *
 * Shared by the two places that offer the policy, so there is one implementation to reason about.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
