/**
 * Seed company list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTANT - these board tokens are UNVERIFIED.
 *
 * The build environment blocks outbound network access, so none of these could
 * be checked against a live board. Company names and domains are real; the
 * Greenhouse board tokens are best guesses from the usual slug convention and
 * SOME WILL BE WRONG.
 *
 * A wrong token is not silent: the adapter raises AdapterHttpError 404, the
 * run is recorded as a failure, and the source is marked `degraded` after
 * three attempts. So verify with:
 *
 *     pnpm --filter @jobswitch/db seed:verify
 *
 * which probes every token and reports which resolve. Fix or remove the
 * failures before relying on the index.
 *
 * This is Phase 2's version of the curation work the ADR budgets a week for in
 * Phase 3. It is a starting point, not a finished index - and per challenge 03
 * in the product definition, the list that actually matters is the one derived
 * from real users' targets, not from guesses.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface SeedCompany {
  name: string;
  domain: string;
  website: string;
  atsType: 'greenhouse';
  boardIdentifier: string;
  cadenceTier?: 'hot' | 'standard' | 'cold';
}

export const SEED_COMPANIES: SeedCompany[] = [
  { name: 'Razorpay', domain: 'razorpay.com', website: 'https://razorpay.com', atsType: 'greenhouse', boardIdentifier: 'razorpay', cadenceTier: 'hot' },
  { name: 'Zerodha', domain: 'zerodha.com', website: 'https://zerodha.com', atsType: 'greenhouse', boardIdentifier: 'zerodha' },
  { name: 'Postman', domain: 'postman.com', website: 'https://www.postman.com', atsType: 'greenhouse', boardIdentifier: 'postman', cadenceTier: 'hot' },
  { name: 'Freshworks', domain: 'freshworks.com', website: 'https://www.freshworks.com', atsType: 'greenhouse', boardIdentifier: 'freshworks' },
  { name: 'Chargebee', domain: 'chargebee.com', website: 'https://www.chargebee.com', atsType: 'greenhouse', boardIdentifier: 'chargebee' },
  { name: 'BrowserStack', domain: 'browserstack.com', website: 'https://www.browserstack.com', atsType: 'greenhouse', boardIdentifier: 'browserstack' },
  { name: 'Hasura', domain: 'hasura.io', website: 'https://hasura.io', atsType: 'greenhouse', boardIdentifier: 'hasura' },
  { name: 'CleverTap', domain: 'clevertap.com', website: 'https://clevertap.com', atsType: 'greenhouse', boardIdentifier: 'clevertap' },
  { name: 'Meesho', domain: 'meesho.com', website: 'https://www.meesho.com', atsType: 'greenhouse', boardIdentifier: 'meesho', cadenceTier: 'hot' },
  { name: 'Groww', domain: 'groww.in', website: 'https://groww.in', atsType: 'greenhouse', boardIdentifier: 'groww' },
  { name: 'CRED', domain: 'cred.club', website: 'https://cred.club', atsType: 'greenhouse', boardIdentifier: 'cred' },
  { name: 'Dream11', domain: 'dream11.com', website: 'https://www.dream11.com', atsType: 'greenhouse', boardIdentifier: 'dream11' },
  { name: 'Swiggy', domain: 'swiggy.com', website: 'https://www.swiggy.com', atsType: 'greenhouse', boardIdentifier: 'swiggy', cadenceTier: 'hot' },
  { name: 'Zomato', domain: 'zomato.com', website: 'https://www.zomato.com', atsType: 'greenhouse', boardIdentifier: 'zomato' },
  { name: 'PhonePe', domain: 'phonepe.com', website: 'https://www.phonepe.com', atsType: 'greenhouse', boardIdentifier: 'phonepe', cadenceTier: 'hot' },
  { name: 'Zeta', domain: 'zeta.tech', website: 'https://www.zeta.tech', atsType: 'greenhouse', boardIdentifier: 'zeta' },
  { name: 'Innovaccer', domain: 'innovaccer.com', website: 'https://innovaccer.com', atsType: 'greenhouse', boardIdentifier: 'innovaccer' },
  { name: 'Darwinbox', domain: 'darwinbox.com', website: 'https://darwinbox.com', atsType: 'greenhouse', boardIdentifier: 'darwinbox' },
  { name: 'Whatfix', domain: 'whatfix.com', website: 'https://whatfix.com', atsType: 'greenhouse', boardIdentifier: 'whatfix' },
  { name: 'MoEngage', domain: 'moengage.com', website: 'https://www.moengage.com', atsType: 'greenhouse', boardIdentifier: 'moengage' },
  { name: 'Netradyne', domain: 'netradyne.com', website: 'https://www.netradyne.com', atsType: 'greenhouse', boardIdentifier: 'netradyne' },
  { name: 'Sprinklr', domain: 'sprinklr.com', website: 'https://www.sprinklr.com', atsType: 'greenhouse', boardIdentifier: 'sprinklr' },
  { name: 'Atlassian', domain: 'atlassian.com', website: 'https://www.atlassian.com', atsType: 'greenhouse', boardIdentifier: 'atlassian', cadenceTier: 'hot' },
  { name: 'Databricks', domain: 'databricks.com', website: 'https://www.databricks.com', atsType: 'greenhouse', boardIdentifier: 'databricks' },
  { name: 'Stripe', domain: 'stripe.com', website: 'https://stripe.com', atsType: 'greenhouse', boardIdentifier: 'stripe' },
  { name: 'GitLab', domain: 'gitlab.com', website: 'https://about.gitlab.com', atsType: 'greenhouse', boardIdentifier: 'gitlab' },
  { name: 'Figma', domain: 'figma.com', website: 'https://www.figma.com', atsType: 'greenhouse', boardIdentifier: 'figma' },
  { name: 'Airbnb', domain: 'airbnb.com', website: 'https://www.airbnb.com', atsType: 'greenhouse', boardIdentifier: 'airbnb' },
  { name: 'Coinbase', domain: 'coinbase.com', website: 'https://www.coinbase.com', atsType: 'greenhouse', boardIdentifier: 'coinbase' },
  { name: 'Twilio', domain: 'twilio.com', website: 'https://www.twilio.com', atsType: 'greenhouse', boardIdentifier: 'twilio' },
];

/**
 * Domain normalization for the uniqueness key.
 *
 * Lowercase, strip scheme, strip `www.`, strip any path. Without this,
 * "https://www.Swiggy.com/" and "swiggy.com" become two companies and the
 * whole shared-index economy quietly doubles for that company.
 */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}
