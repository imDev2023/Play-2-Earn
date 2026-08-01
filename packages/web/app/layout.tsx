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
      {/*
       * Password managers, theme switchers and colour pickers all write attributes onto
       * <body> before React hydrates, which React then reports as a hydration mismatch.
       * It is not ours and there is nothing to fix in the markup, but it renders as a
       * full-width red error over the game, and an error that is always there is an
       * error nobody reads - including the real one behind it.
       *
       * This suppresses the warning for the attributes on this element only. Mismatches
       * inside the tree, which would be ours, still report normally.
       */}
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
