import { ArrowRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { External, Modal, slotTime } from './components';
import type { ApolloPreview, ApolloWaterfallRun } from './model';
import './apollo-waterfall.css';

type ApolloReviewProps = {
  preview: ApolloPreview;
  busy: boolean;
  close: () => void;
  onApprove: (token: string) => void;
  onResize?: (limit: number) => void;
};

const pricingUrl = 'https://docs.apollo.io/docs/api-pricing';
const number = new Intl.NumberFormat('en-US');

export function ApolloReviewModal({ preview, busy, close, onApprove, onResize }: ApolloReviewProps) {
  const waterfall = preview.mode === 'waterfall';
  const { people, credits, estimate } = preview;
  const quote = typeof credits === 'number' && Number.isFinite(credits)
    ? `${number.format(credits)} ${credits === 1 ? 'credit' : 'credits'}`
    : undefined;
  const method = waterfall ? 'Waterfall email lookup' : 'Standard email lookup';
  const selectable = Math.max(people.length, Math.min(10, preview.available ?? 0));

  return <Modal title="Review Apollo lookup" description={`${method} for ${people.length} ${people.length === 1 ? 'contact' : 'contacts'}.`}
    onClose={() => { if (!busy) close(); }}>
    {waterfall && onResize && selectable > 1 && <label className="field apollo-review-size">
      <span>Contacts to review</span>
      <select value={people.length} onChange={event => onResize(Number(event.target.value))} disabled={busy}>
        {Array.from({ length: selectable }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select>
    </label>}
    <div className="apollo-cost">
      <strong>{quote ? `Estimated cost · ${quote}` : waterfall ? 'Cost varies by source and result' : 'Cost varies by result'}</strong>
      {estimate && <p>{estimate}</p>}
      <p>{waterfall
        ? 'Apollo checks your team’s configured sources and may use more credits than a standard lookup. Some sources charge only for results. Others charge even when they find no email.'
        : 'Apollo calculates usage based on your plan and the data returned.'}</p>
      <External url={pricingUrl}>Apollo credit pricing</External>
    </div>
    <ol className="apollo-review-people" aria-label="Contacts included in this lookup">
      {people.map((person, index) => <li key={index}>{person}</li>)}
    </ol>
    {waterfall && <p className="field-note">Apollo processes waterfall results in the background. They may take a few minutes to appear.</p>}
    <div className="form-actions">
      <button className="button secondary" disabled={busy} onClick={close}>Cancel</button>
      <button className="button primary" disabled={busy || people.length === 0} onClick={() => onApprove(preview.token)}>
        {busy ? <LoaderCircle className="spin" size={16}/> : <ArrowRight size={16}/>}
        {busy ? 'Submitting lookup…' : 'Approve and run lookup'}
      </button>
    </div>
  </Modal>;
}


const recipientStatus = {
  queued: 'Queued',
  submitting: 'Submitting',
  pending: 'In progress',
  waiting: 'Waiting for result',
  matched: 'Email found',
  no_match: 'No verified email',
  failed: 'Lookup failed',
  uncertain: 'Needs review',
  skipped: 'Skipped',
} as const;

function awaitingResult(status: keyof typeof recipientStatus) {
  return status === 'pending' || status === 'waiting';
}

export function ApolloWaterfallResults({ runs, onRefresh, busy }: {
  runs: ApolloWaterfallRun[];
  onRefresh: (runId: string) => void;
  busy: boolean;
}) {
  if (!runs.length) return null;
  const ordered = [...runs].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

  return <section className="apollo-runs" aria-labelledby="apollo-runs-title">
    <div className="section-title"><div>
      <h2 id="apollo-runs-title">Apollo waterfall results</h2>
      <p>See what Apollo found and check for results still in progress.</p>
    </div></div>
    {ordered.map((run, index) => {
      const pending = run.recipients.filter(recipient => awaitingResult(recipient.status)).length;
      const canCheck = pending > 0 || run.recipients.some(recipient => recipient.status === 'uncertain' && recipient.requestId);
      const matched = run.recipients.filter(recipient => recipient.status === 'matched').length;
      const inProgress = pending + run.recipients.filter(recipient => recipient.status === 'queued' || recipient.status === 'submitting').length;
      return <details className="apollo-run" key={run.id} open={index === 0 || undefined}>
        <summary>
          <span>Approved {slotTime(run.approvedAt)}</span>
          <span className="apollo-run-counts">
            <span>{run.recipients.length} {run.recipients.length === 1 ? 'contact' : 'contacts'}</span>
            {matched > 0 && <span className="apollo-result-status matched">{matched} matched</span>}
            {inProgress > 0 && <span className="apollo-result-status pending">{inProgress} in progress</span>}
          </span>
        </summary>
        <div className="apollo-run-body">
          {run.costLabel && <p className="field-note apollo-run-cost">{run.costLabel}</p>}
          <ul className="apollo-run-recipients">
            {run.recipients.map(recipient => <li key={recipient.contactId}>
              <div className="apollo-recipient-top">
                <div><strong>{recipient.name}</strong>{recipient.company && <p>{recipient.company}</p>}</div>
                <span className={`apollo-result-status ${recipient.status}`}>{recipientStatus[recipient.status]}</span>
              </div>
              {recipient.email && <p className="apollo-result-email">{recipient.email}</p>}
              {recipient.notes.length > 0 && <ul className="apollo-result-notes">
                {recipient.notes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}
              </ul>}
            </li>)}
          </ul>
          {canCheck && <div className="apollo-run-actions">
            <p className="field-note">Checking retrieves existing results.</p>
            <button className="button secondary" type="button" disabled={busy} onClick={() => onRefresh(run.id)}>
              <RefreshCw size={15} className={busy ? 'spin' : undefined}/>{busy ? 'Checking…' : 'Refresh results'}
            </button>
          </div>}
        </div>
      </details>;
    })}
  </section>;
}
