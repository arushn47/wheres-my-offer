import type { Metadata, Viewport } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#10b981',
};

const siteUrl =
  process.env.NEXT_PUBLIC_APP_URL && !process.env.NEXT_PUBLIC_APP_URL.includes('localhost')
    ? process.env.NEXT_PUBLIC_APP_URL
    : 'https://www.wheresmyoffer.in';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Where's My Offer? — NeoPAT Tracker & Campus Placement Radar",
    template: "%s — Where's My Offer? | NeoPAT Tracker",
  },
  description:
    "The #1 real-time NeoPAT tracker and campus placement radar. Automated email sync, shortlist spreadsheet scanner, OA test alerts, and interview rounds in one unified mission-control dashboard.",
  keywords: [
    "NeoPAT Tracker",
    "neopat tracker",
    "NeoPAT",
    "neopat",
    "Where's My Offer?",
    "Where's My Offer App",
    "Campus Placement Radar",
    "Campus Placement Tracker",
    "NeoPAT Placement Tracker",
    "NeoPAT Status Tracker",
    "NeoPAT Email Tracker",
    "VIT NeoPAT",
    "NeoPAT student tracker",
    "NeoPAT drive tracker",
    "VIT Placement Tracker",
    "VIT Bhopal Placements",
    "College Placement Management",
    "Placement Drive Schedule",
    "Shortlist Attachment Parser",
    "Online Assessment Tracker",
    "Interview Schedule Manager",
    "Job Application Tracking System",
  ],
  authors: [{ name: "Where's My Offer? Team", url: siteUrl }],
  creator: "Where's My Offer?",
  publisher: "Where's My Offer?",
  applicationName: "Where's My Offer?",
  category: "Productivity",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "Where's My Offer? — NeoPAT Tracker",
    title: "Where's My Offer? — NeoPAT Tracker & Campus Placement Radar",
    description:
      "The #1 real-time NeoPAT tracker and campus placement radar. Automated email sync, shortlist spreadsheet scanner, OA test alerts, and interview rounds.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Where's My Offer? — NeoPAT Tracker & Campus Placement Radar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Where's My Offer? — NeoPAT Tracker & Campus Placement Radar",
    description:
      "The #1 real-time NeoPAT tracker and campus placement radar. Automated email sync, shortlist spreadsheet scanner, OA test alerts, and interview rounds.",
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Where's My Offer?",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon.jpg", type: "image/jpeg" },
    ],
    apple: [
      { url: "/apple-touch-icon.jpg", type: "image/jpeg" },
    ],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": `${siteUrl}/#webapp`,
      name: "Where's My Offer?",
      url: siteUrl,
      applicationCategory: "EducationalApplication, BusinessApplication",
      operatingSystem: "All modern web browsers, Android, iOS",
      description:
        "Real-time campus placement tracking, automated NeoPAT email sync, shortlist spreadsheet parsing, and interview schedule command center.",
      browserRequirements: "Requires JavaScript. Requires HTML5.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Automated Gmail & NeoPAT Sync",
        "Excel & PDF Shortlist Candidate Matching",
        "Placement Drive Calendar & Timeline",
        "Conversion Funnel Analytics",
        "Browser & Mobile Web Push Notifications",
      ],
    },
    {
      "@type": "Organization",
      "@id": `${siteUrl}/#organization`,
      name: "Where's My Offer?",
      url: siteUrl,
      logo: `${siteUrl}/opengraph-image`,
      description: "Smart Campus Placement and Drive Intelligence Platform.",
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} font-sans antialiased bg-bg-primary text-zinc-100`}
      >
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          className="app-toaster"
          richColors
          visibleToasts={3}
          duration={Infinity}
        />
      </body>
    </html>
  );
}
