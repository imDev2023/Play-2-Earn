import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "RUSHOOD",
  description:
    "Pick your odds. A real-value number-prediction game on Robinhood Chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
