'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWorkspace } from '@/lib/workspace';
import { when } from '@/lib/format';
import { BucketWizard } from '@/components/capital/bucket-wizard';
import { EnvBadge, SegBadge, SegregationExplainer, useBuckets, usePortfolios } from '@/components/capital/shared';

function Inner() {
  const { canAdmin } = useWorkspace(); const buckets = useBuckets(), portfolios = usePortfolios(); const [wiz, setWiz] = useState(false);
  const only = useSearchParams().get('portfolio');
  const pname = (id: string) => portfolios.data?.items.find((p) => p.id === id)?.name ?? '…';
  return (<>
    <PageHeader title="Buckets" description="Accounting buckets across all portfolios. Each bucket states honestly whether its wallets are dedicated (physical), shared (logical) or a protected vault."
      actions={<Button variant="primary" disabled={!canAdmin || !portfolios.data?.items.length} title={!canAdmin ? 'Owner or admin role required' : !portfolios.data?.items.length ? 'Create a portfolio first' : undefined} onClick={() => setWiz(true)}><Plus className="size-4" aria-hidden />New bucket</Button>} />
    <Card>
      <Async q={buckets}>{(d) => { const rows = d.items.filter((b) => !only || b.portfolio_id === only); return rows.length === 0
        ? <EmptyState title="No buckets yet" hint={only ? 'This portfolio has no buckets.' : 'Create a portfolio, then add a bucket to start segregating capital.'} action={canAdmin && portfolios.data?.items.length ? <Button variant="primary" onClick={() => setWiz(true)}>New bucket</Button> : <Link className="font-semibold text-accent underline" href="/portfolios">Go to Portfolios</Link>} />
        : <DataTable caption="Buckets" rows={rows} cols={[
          { key: 'name', header: 'Bucket', render: (b) => <Link className="font-semibold text-accent hover:underline" href={`/portfolios/${b.portfolio_id}/buckets/${b.id}`}>{b.name}</Link> },
          { key: 'portfolio', header: 'Portfolio', filter: true, text: (b) => pname(b.portfolio_id) },
          { key: 'environment', header: 'Env', filter: true, render: (b) => <EnvBadge env={b.environment} /> },
          { key: 'kind', header: 'Type', filter: true, text: (b) => b.kind.replace('_', ' ') },
          { key: 'segregation', header: 'Segregation', filter: true, render: (b) => <SegBadge seg={b.segregation} /> },
          { key: 'wallet_count', header: 'Wallets', align: 'right', sort: (b) => b.wallet_count },
          { key: 'state', header: 'State', filter: true, render: (b) => <Badge tone={b.state === 'active' ? 'good' : 'warn'}>{b.state.replace(/_/g, ' ')}</Badge> },
          { key: 'policy_version', header: 'Policy v', align: 'right', sort: (b) => b.policy_version },
          { key: 'created_at', header: 'Created', text: (b) => when(b.created_at) },
        ]} />; }}</Async>
    </Card>
    <div className="mt-5"><Card title="What the segregation labels mean"><SegregationExplainer /></Card></div>
    <BucketWizard open={wiz} onClose={() => setWiz(false)} defaultPortfolio={only ?? undefined} />
  </>);
}
export default function BucketsPage() { return <NeedWorkspace><Suspense fallback={null}><Inner /></Suspense></NeedWorkspace>; }
