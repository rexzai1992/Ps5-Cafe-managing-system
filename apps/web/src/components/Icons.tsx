// Small decorative icons. Always paired with text and hidden from assistive technology.
import type { JSX } from "react";

export function ClockIcon() {
  return <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 4.2V8l2.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>;
}

export function AlertIcon() {
  return <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8 6v3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="8" cy="11.8" r=".95" fill="currentColor" />
  </svg>;
}

export function InfoIcon() {
  return <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="8" cy="4.9" r=".95" fill="currentColor" />
  </svg>;
}

const navIcon = (children: JSX.Element) => <svg className="icon nav-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"
  fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;

/** Navigation icons, keyed by page. Decorative: every nav item also has a text label. */
export const NAV_ICONS = {
  dashboard: navIcon(<><rect x="3" y="3" width="6" height="6" rx="1.2" /><rect x="11" y="3" width="6" height="6" rx="1.2" /><rect x="3" y="11" width="6" height="6" rx="1.2" /><rect x="11" y="11" width="6" height="6" rx="1.2" /></>),
  remote: navIcon(<><rect x="6" y="2.5" width="8" height="15" rx="2.5" /><circle cx="10" cy="7" r="1.6" /><path d="M8.3 11.5h3.4M8.3 14h3.4" /></>),
  media: navIcon(<><rect x="2.5" y="4" width="15" height="12" rx="1.8" /><path d="m8.5 7.5 4 2.5-4 2.5z" /></>),
  devices: navIcon(<><rect x="2.5" y="3.5" width="15" height="10" rx="1.5" /><path d="M7 17h6M10 13.5V17" /></>),
  settings: navIcon(<><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" /></>),
} as const;

export function ChevronIcon() {
  return <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function CloseIcon() {
  return <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>;
}

/** Thumbnail pictures. Decorative: the thumbnail always says the same thing in text. */
const pictureIcon = (children: JSX.Element) => <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
  fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;

export const QrIcon = () => pictureIcon(<>
  <rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="9.5" y="1.5" width="5" height="5" rx="1" /><rect x="1.5" y="9.5" width="5" height="5" rx="1" />
  <path d="M9.5 9.5h2v2h-2zM13 13h1.5v1.5H13zM9.5 13.5h1.5M13 9.5h1.5" />
</>);

export const GamepadIcon = () => pictureIcon(<>
  <path d="M4.6 4.5h6.8a3 3 0 0 1 2.9 3.6l-.6 2.9a1.5 1.5 0 0 1-2.6.7L9.7 10H6.3L4.9 11.7a1.5 1.5 0 0 1-2.6-.7l-.6-2.9a3 3 0 0 1 2.9-3.6z" />
  <path d="M5 6.6v2.2M3.9 7.7h2.2" /><path d="M10.8 7.2h.01M12 8.4h.01" strokeWidth="2" />
</>);

export const TvOffIcon = () => pictureIcon(<><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><path d="M5.5 14h5M2 1.5l12 13" /></>);
