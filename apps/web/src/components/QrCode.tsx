import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Builds the QR image as one SVG path from the module grid (no injected markup). Quiet zone of 4 modules per the spec. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
    return { size: count + 8, path: d };
  }, [text]);
  return <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" />
    <path d={path} fill="#000" />
  </svg>;
}
