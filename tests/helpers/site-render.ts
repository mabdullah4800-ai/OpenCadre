import { composeSitePage, type SitePage } from "../../src/site-pages.js";
import { renderSitePlans } from "../../src/site-plans.js";

/** A site page as the hub renders it before the signup labels: the shared frame, the plan limits from the plans table
 * and the trial length from CARD_TRIAL_DAYS. Tests that read a page's words read this, not the file on disk, because
 * the file holds empty elements where the hub puts those numbers. */
export function renderedSitePage(page: SitePage, { signedIn = false, trialDays }: { signedIn?: boolean; trialDays?: number } = {}): string {
  return renderSitePlans(composeSitePage(page, { version: "test", signedIn }), undefined, trialDays === undefined ? {} : { trialDays });
}
