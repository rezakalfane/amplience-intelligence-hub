// Deep links into the Amplience Dynamic Content app. Pure (no env access) so client components can build them.
// URL shapes follow the app's hash routes; they have not been click-tested against every account setup.

export const APP_HOST = "https://app.amplience.net/content/#!";

export interface LinkBase {
  /** Hub name: an identifier used in app URLs, not a secret (tokens are). */
  hub: string;
}

const seg = encodeURIComponent;

export const ampLinks = {
  /** The hub's content library. */
  hub: (b: LinkBase) => `${APP_HOST}/${seg(b.hub)}/authoring/content-items`,
  /** Settings (localization lives under Settings → Localization). */
  settings: (b: LinkBase) => `${APP_HOST}/${seg(b.hub)}/settings`,
  /** Registered content types (Development → Content types). */
  contentTypes: (b: LinkBase) => `${APP_HOST}/${seg(b.hub)}/development/content-types`,
  /** The content form of one item (every locale of a field-level localized item is edited there). */
  item: (b: LinkBase, itemId: string) => `${APP_HOST}/${seg(b.hub)}/authoring/content-item/edit/${seg(itemId)}`,
};
