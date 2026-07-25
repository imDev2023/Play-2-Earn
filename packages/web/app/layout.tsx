import type { ReactNode } from "react";

export const metadata = {
  title: "RUSHOOD",
  description:
    "Pick your odds. A real-value number-prediction game on Robinhood Chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
