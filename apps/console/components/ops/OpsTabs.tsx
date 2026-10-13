'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';

export function OpsTabs() {
  const path = usePathname();
  const items = [{ href: '/operations/jobs', label: 'Batch jobs' }, { href: '/operations/audit', label: 'Audit and incidents' }];
  return <nav aria-label="Operations sections" className="mb-5 flex gap-1 border-b border-line">{items.map((i) => (
    <Link key={i.href} href={i.href} aria-current={path === i.href ? 'page' : undefined} className={cx('border-b-2 px-4 py-2.5 text-[13px] font-semibold', path === i.href ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink')}>{i.label}</Link>))}</nav>;
}
