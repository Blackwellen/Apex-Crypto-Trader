import { Activity, ArrowLeftRight, BarChart3, Boxes, Coins, Compass, FlaskConical, Gauge, GitBranch, Layers, LineChart, Newspaper, Radar, Settings, ShieldAlert, Wallet, Wrench, Zap, type LucideIcon } from 'lucide-react';
export interface NavItem { href: string; label: string; icon: LucideIcon; group: string }
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Command', icon: Gauge, group: 'Command' },
  { href: '/markets', label: 'Markets', icon: BarChart3, group: 'Intelligence' },
  { href: '/meme-radar', label: 'Meme Radar', icon: Radar, group: 'Intelligence' },
  { href: '/intelligence', label: 'News', icon: Newspaper, group: 'Intelligence' },
  { href: '/strategies', label: 'Strategies', icon: Compass, group: 'Trading' },
  { href: '/trading', label: 'Live Orders', icon: Activity, group: 'Trading' },
  { href: '/execution', label: 'Execution', icon: Zap, group: 'Trading' },
  { href: '/arbitrage', label: 'Arbitrage', icon: ArrowLeftRight, group: 'Trading' },
  { href: '/portfolios', label: 'Portfolios', icon: Layers, group: 'Capital' },
  { href: '/buckets', label: 'Buckets', icon: Boxes, group: 'Capital' },
  { href: '/wallets', label: 'Wallets', icon: Wallet, group: 'Capital' },
  { href: '/compounding', label: 'Compounding', icon: LineChart, group: 'Capital' },
  { href: '/treasury', label: 'Treasury', icon: Coins, group: 'Capital' },
  { href: '/chains', label: 'Chains', icon: GitBranch, group: 'Platform' },
  { href: '/risk', label: 'Risk', icon: ShieldAlert, group: 'Platform' },
  { href: '/research', label: 'Research', icon: FlaskConical, group: 'Platform' },
  { href: '/operations/jobs', label: 'Operations', icon: Wrench, group: 'Platform' },
  { href: '/settings', label: 'Settings', icon: Settings, group: 'Platform' },
];
