import { useEffect, useRef, useState } from "react";
import type { AdItem } from "@ps5-cafe/contracts";

/** How long each image stays up. Videos play to their end, or at most VIDEO_MAX_MS if one stalls. */
export const IMAGE_MS = 8_000;
const VIDEO_MAX_MS = 120_000;

/** Plays the advertising playlist in a loop: images for a few seconds each, videos muted to their end. */
export function AdPlayer({ ads }: { ads: readonly AdItem[] }) {
  // A step counter, not an index: every advance remounts the element, so a one-video playlist still replays.
  const [step, setStep] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const signature = ads.map((ad) => ad.url).join("|");
  const item = ads.length > 0 ? ads[step % ads.length] : undefined;
  const next = () => setStep((value) => value + 1);

  useEffect(() => { setStep(0); }, [signature]);
  useEffect(() => {
    if (!item) return;
    const timer = setTimeout(next, item.kind === "image" ? IMAGE_MS : VIDEO_MAX_MS);
    return () => clearTimeout(timer);
  }, [step, signature]); // eslint-disable-line react-hooks/exhaustive-deps

  // A hidden page (TV on another input) must not keep decoding video.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") video.current?.pause(); else void video.current?.play().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!item) return null;
  return item.kind === "image"
    ? <img key={step} className="ad-media" src={item.url} alt="" onError={next} />
    : <video key={step} ref={video} className="ad-media" src={item.url} autoPlay muted playsInline onEnded={next} onError={next} />;
}
