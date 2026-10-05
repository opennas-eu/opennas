/**
 * Defusing markup that was generated from a user's file.
 *
 * `docx-preview` turns a .docx into DOM nodes in the desktop's own document,
 * and a .docx is just a zip someone else may have written: its hyperlink
 * targets are arbitrary strings, so a "link" can be `javascript:...` and run in
 * the desktop's origin, with the user's session, the moment it is clicked.
 * This walks what was rendered and takes out anything that could execute.
 *
 * The URL decisions are plain functions so they can be tested without a DOM.
 */

/** Strip what browsers ignore when they parse a URL scheme. */
function normalise(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
}

/**
 * May a clicked link go here? Only the web, mail, phone and in-document
 * anchors. Relative paths are refused too: resolved against the desktop they
 * would point into the OpenNAS API.
 */
export function isSafeLinkHref(href: string): boolean {
  const v = normalise(href);
  if (v === "" || v.startsWith("#")) return true;
  return /^(https?|mailto|tel):/.test(v);
}

/**
 * May a resource attribute (an image's `src`, an SVG `<image>`'s `href`) hold
 * this? The document's own pictures arrive as `blob:` or `data:image/` URLs,
 * and an image can't run script however it is written, so those stay.
 * Script-bearing schemes don't.
 */
export function isSafeResourceUrl(url: string): boolean {
  const v = normalise(url);
  if (/^(javascript|vbscript):/.test(v)) return false;
  if (v.startsWith("data:")) return v.startsWith("data:image/");
  return true;
}

/** Any attribute value that would execute if it ended up somewhere navigable. */
export function isScriptUrl(value: string): boolean {
  const v = normalise(value);
  return /^(javascript|vbscript|data):/.test(v);
}

const DROP_ELEMENTS = new Set(["script", "iframe", "frame", "object", "embed", "form", "base", "meta", "link", "foreignobject"]);
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction", "srcset", "poster", "background"]);

/**
 * Remove everything executable from a rendered subtree, in place: event
 * handler attributes, script-bearing URLs, and elements that load or run
 * other documents. Links that survive open in a new tab, without an opener.
 */
export function defuseRenderedMarkup(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.localName.toLowerCase();
    if (DROP_ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      const isLink = tag === "a" || tag === "area";
      const ok = isLink && (name === "href" || name === "xlink:href")
        ? isSafeLinkHref(attr.value)
        : (tag === "img" || tag === "image") && (name === "src" || name === "href" || name === "xlink:href")
          ? isSafeResourceUrl(attr.value)
          : !isScriptUrl(attr.value);
      if (!ok) el.removeAttribute(attr.name);
    }
    if (tag === "a" && el.hasAttribute("href") && !(el.getAttribute("href") ?? "").startsWith("#")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
}
