import type { Metadata } from "next";

import { ZoneEditor } from "@/components/ZoneEditor";

export const metadata: Metadata = { title: "Zone | Linewatch" };

export default function ZonesPage() {
  return <ZoneEditor />;
}
