import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
export const metadata: Metadata = { title: 'APEX — Treasury & Trading Control', description: 'Segregated multi-chain treasury, compounding policy and paper-trading control plane' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
