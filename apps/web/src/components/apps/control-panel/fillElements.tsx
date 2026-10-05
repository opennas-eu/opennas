import { Fragment, type ReactNode } from "react";

/**
 * Fill `{name}` placeholders in a translated sentence with elements rather than
 * text, so a translation can put a `<code>` or link wherever its word order
 * wants it. Pass the template unfilled - `t()` leaves placeholders it has no
 * value for in place.
 */
export function fillElements(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return name && name in parts ? <Fragment key={i}>{parts[name]}</Fragment> : piece;
  });
}
