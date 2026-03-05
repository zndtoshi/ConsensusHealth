import React from "react";
import { QRCodeSVG } from "qrcode.react";

export function BitcoinQr({ value, size = 220 }) {
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
        fgColor="#FFFFFF"
        bgColor="transparent"
      />
    </div>
  );
}
