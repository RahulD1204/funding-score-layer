import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Inter is bundled with the app (SIL Open Font License, see app/fonts/LICENSE-Inter.txt),
// so the build never has to fetch a font from another site.
const inter = localFont({
  src: "./fonts/InterVariable-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Funding Score Layer (prototype)",
  description:
    "Prototype on synthetic data: retry schedules for failed EMI and premium debits, timed to the customer's funded day. Advice only.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
