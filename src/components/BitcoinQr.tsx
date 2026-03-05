import React from "react";
import { QRCodeSVG } from "qrcode.react";

type Props = {
  value: string;
  size?: number;
};

export function BitcoinQr({ value, size = 220 }: Props) {
  // SVG is the most compatible (Firefox-safe) way to render QR.
  // We keep background transparent to match your modal styling.
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        borderRadius: 14,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.10)",
      }}
    >
      <QRCodeSVG
        value={value}
        width={size - 24}
        height={size - 24}
        level="M"
        includeMargin={true}
        // High contrast for scanners; SVG avoids canvas issues in Firefox.
        fgColor="#FFFFFF"
        bgColor="transparent"
      />
    </div>
  );
}
