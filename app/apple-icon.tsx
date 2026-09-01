import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Apple touch icons get their corners rounded by iOS itself, so this renders
// a full-bleed square.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0A0A0A",
        }}
      >
        <svg width="140" height="105" viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M14.5 6C9.25329 6 5 10.2533 5 15.5C5 20.7467 9.25329 25 14.5 25H17.5C18.6046 25 19.5 24.1046 19.5 23C19.5 21.8954 18.6046 21 17.5 21H14.5C11.4624 21 9 18.5376 9 15.5C9 12.4624 11.4624 10 14.5 10H19.5C20.6046 10 21.5 9.10457 21.5 8C21.5 6.89543 20.6046 6 19.5 6H14.5Z"
            fill="#655BFF"
          />
          <path d="M23.5 6V26H27.8L36.5 12.7V26H40.5V6H36.2L27.5 19.3V6H23.5Z" fill="#655BFF" />
        </svg>
      </div>
    ),
    size
  );
}
