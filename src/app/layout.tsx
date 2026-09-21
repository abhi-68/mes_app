import type { Metadata } from "next";
// Self-hosted, so there is no call to a font CDN at build or at run time — the
// earlier next/font/google setup could not build in a network-restricted sandbox.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { Providers } from "./providers";
import { TopNav } from "@/components/TopNav";

export const metadata: Metadata = {
  title: "Thermal Corp MES",
  description: "Manufacturing execution tracker for Thermal Corp",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-steel-50 font-sans">
        <Providers>
          {/*
            Shown on any deployed copy. A shared link goes to people who did not
            watch it being built, and demonstration data that is not labelled as
            such is how a prototype gets mistaken for a live factory record.
          */}
          {process.env.NEXT_PUBLIC_DEMO_BANNER === "1" && (
            <div className="bg-navy-950 px-4 py-1.5 text-center text-[11px] tracking-wide text-white/55">
              Demonstration only — sample data, not a live factory record. Stations and routings
              are a best guess from the public catalogue, not Thermal Corp&rsquo;s confirmed
              process.
            </div>
          )}
          <TopNav />
          <div className="flex flex-1 flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
