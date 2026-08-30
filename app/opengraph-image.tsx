import { ImageResponse } from "next/og";

export const alt = "CreatorNet — Scroll. Learn. Earn.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Default share card for every page that doesn't override it.
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 36,
          background: "#0A0A0A",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg width="150" height="113" viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M14.5 6C9.25329 6 5 10.2533 5 15.5C5 20.7467 9.25329 25 14.5 25H17.5C18.6046 25 19.5 24.1046 19.5 23C19.5 21.8954 18.6046 21 17.5 21H14.5C11.4624 21 9 18.5376 9 15.5C9 12.4624 11.4624 10 14.5 10H19.5C20.6046 10 21.5 9.10457 21.5 8C21.5 6.89543 20.6046 6 19.5 6H14.5Z"
              fill="#655BFF"
            />
            <path d="M23.5 6V26H27.8L36.5 12.7V26H40.5V6H36.2L27.5 19.3V6H23.5Z" fill="#655BFF" />
          </svg>
          <div style={{ display: "flex", fontSize: 96, fontWeight: 700, color: "#FFFFFF" }}>
            CreatorNet
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 40, color: "#A1A1AA" }}>
          Scroll. Learn. Earn.
        </div>
      </div>
    ),
    size
  );
}
